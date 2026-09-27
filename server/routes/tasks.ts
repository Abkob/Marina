import { Router } from 'express';
import { activeTaskSql } from '../utils/archiveVisibility.js';
import { query, buildUpdate, transaction } from '../db.js';
import { syncGoalMetrics } from './goals.js';
import { generateEntitySummary } from '../services/summaryGenerator.js';
import { queueEmbeddingUpsert, markEmbeddingStale } from '../services/embeddingLifecycle.js';
import { requireISODate } from '../utils/localDate.js';
import { runInBackground } from '../utils/background.js';
import {
  childDeadlineError,
  dateOnly,
  isDeadlineAfter,
  synchronizedTaskDeadlineUpdates,
  type DeadlineTask,
} from '../utils/taskDeadline.js';

const router = Router();

const TASK_UPDATE_FIELDS = new Set([
  'goal_id', 'parent_task_id', 'milestone_id', 'deadline_id',
  'title', 'description', 'status', 'priority', 'kind', 'critical_path_status',
  'tags_json', 'due_date', 'start_date', 'estimated_duration', 'estimated_minutes', 'time_rollup_mode',
  'weight_percent', 'feel_score', 'completed', 'position',
  'last_activity_at', 'completion_note',
  // M-021 real date planning
  'target_date', 'hard_deadline', 'deadline_type', 'deadline_confidence',
  'scheduling_enabled', 'flexibility', 'can_split', 'min_session_minutes',
]);

// 'todo' is the legacy synonym of 'not_started'; both accepted.
const VALID_TASK_STATUSES = new Set(['todo', 'not_started', 'planned', 'in_progress', 'paused', 'done', 'inactive', 'blocked']);
const STARTABLE_TASK_STATUSES = new Set(['todo', 'not_started', 'planned', 'paused', 'inactive', 'blocked']);
const VALID_TIME_ROLLUP_MODES = new Set(['additive', 'inclusive']);
const VALID_TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

/** Finds the closest dated parent, including an immediate parent that inherits from its own parent. */
async function findEffectiveParentDeadline(parentTaskId: string | null): Promise<DeadlineTask | null> {
  if (!parentTaskId) return null;
  const { rows } = await query<DeadlineTask>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, title, parent_task_id, due_date, 0 AS depth, ARRAY[id] AS path FROM tasks WHERE id=$1
       UNION ALL
       SELECT t.id, t.title, t.parent_task_id, t.due_date, a.depth + 1, a.path || t.id
       FROM tasks t JOIN ancestors a ON t.id=a.parent_task_id
       WHERE NOT t.id = ANY(a.path)
     )
     SELECT id, title, due_date FROM ancestors
     WHERE due_date IS NOT NULL
     ORDER BY depth ASC
     LIMIT 1`,
    [parentTaskId],
  );
  return rows[0] ?? null;
}

async function findDescendantPastDeadline(taskId: string, deadline: string): Promise<DeadlineTask | null> {
  const { rows } = await query<DeadlineTask>(
    `WITH RECURSIVE descendants AS (
       SELECT id, title, parent_task_id, due_date, ARRAY[id] AS path FROM tasks WHERE parent_task_id=$1
       UNION ALL
       SELECT t.id, t.title, t.parent_task_id, t.due_date, d.path || t.id
       FROM tasks t JOIN descendants d ON t.parent_task_id=d.id
       WHERE NOT t.id = ANY(d.path)
     )
     SELECT id, title, due_date FROM descendants
     WHERE due_date IS NOT NULL AND LEFT(due_date, 10) > $2
     ORDER BY LEFT(due_date, 10) DESC
     LIMIT 1`,
    [taskId, deadline],
  );
  return rows[0] ?? null;
}

// GET /api/tasks?goal_id=...&parent_task_id=...&limit=N&offset=N
router.get('/', async (req, res) => {
  const { goal_id, parent_task_id } = req.query;
  const limit  = Math.min(Math.max(1, Number(req.query.limit)  || 500), 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  // Only an archived goal's detail view includes its archived branch. An active
  // goal must still hide descendants whose parent belongs to an archived goal.
  const visible = req.query.include_archived === 'true' ? 'TRUE'
    : goal_id ? `(${activeTaskSql()} OR EXISTS (SELECT 1 FROM goals WHERE goals.id=$1 AND archived_at IS NOT NULL))`
      : activeTaskSql();
  let result;
  let countResult;
  if (goal_id) {
    [result, countResult] = await Promise.all([
      query(`SELECT * FROM tasks WHERE goal_id = $1 AND ${visible} ORDER BY position ASC, created_at ASC LIMIT $2 OFFSET $3`, [goal_id, limit, offset]),
      query<{ total: string }>(`SELECT COUNT(*)::int AS total FROM tasks WHERE goal_id = $1 AND ${visible}`, [goal_id]),
    ]);
  } else if (parent_task_id) {
    [result, countResult] = await Promise.all([
      query(`SELECT * FROM tasks WHERE parent_task_id = $1 AND ${visible} ORDER BY position ASC, created_at ASC LIMIT $2 OFFSET $3`, [parent_task_id, limit, offset]),
      query<{ total: string }>(`SELECT COUNT(*)::int AS total FROM tasks WHERE parent_task_id = $1 AND ${visible}`, [parent_task_id]),
    ]);
  } else {
    [result, countResult] = await Promise.all([
      query(`SELECT * FROM tasks WHERE ${visible} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      query<{ total: string }>(`SELECT COUNT(*)::int AS total FROM tasks WHERE ${visible}`),
    ]);
  }
  res.setHeader('X-Total-Count', String(Number(countResult.rows[0]?.total ?? 0)));
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
  res.json(result.rows);
});

// GET /api/tasks/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// POST /api/tasks
router.post('/', async (req, res) => {
  const b = req.body;
  if (!b.title?.trim()) return res.status(400).json({ error: 'title required' });
  if (b.status !== undefined && !VALID_TASK_STATUSES.has(b.status as string)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_TASK_STATUSES].join(', ')}` });
  }
  if (b.priority !== undefined && !VALID_TASK_PRIORITIES.has(b.priority as string)) {
    return res.status(400).json({ error: `Invalid priority. Must be one of: ${[...VALID_TASK_PRIORITIES].join(', ')}` });
  }
  if (b.time_rollup_mode !== undefined && !VALID_TIME_ROLLUP_MODES.has(b.time_rollup_mode as string)) {
    return res.status(400).json({ error: `Invalid time_rollup_mode. Must be one of: ${[...VALID_TIME_ROLLUP_MODES].join(', ')}` });
  }
  if (b.feel_score !== undefined && b.feel_score !== null &&
      (!Number.isInteger(b.feel_score) || b.feel_score < 0 || b.feel_score > 100)) {
    return res.status(400).json({ error: 'feel_score must be a whole number from 0 to 100' });
  }
  try {
    requireISODate(b.due_date, 'due_date');
    requireISODate(b.start_date, 'start_date');
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const parentDeadline = await findEffectiveParentDeadline(b.parent_task_id ?? null);
  const newDueDate = dateOnly(b.due_date);
  if (newDueDate && parentDeadline && isDeadlineAfter(newDueDate, parentDeadline.due_date)) {
    return res.status(409).json({ error: childDeadlineError(parentDeadline) });
  }

  const { rows: countRows } = await query(
    'SELECT COUNT(*) as c FROM tasks WHERE goal_id = $1',
    [b.goal_id ?? null],
  );
  const position = b.position ?? Number((countRows[0] as Record<string, unknown>).c ?? 0);

  await query(
    `INSERT INTO tasks
      (id,goal_id,parent_task_id,milestone_id,deadline_id,title,description,status,priority,kind,
       critical_path_status,tags_json,due_date,start_date,estimated_duration,estimated_minutes,time_rollup_mode,
       weight_percent,feel_score,completed,position,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      id,
      b.goal_id ?? null,
      b.parent_task_id ?? null,
      b.milestone_id ?? null,
      b.deadline_id ?? null,
      b.title ?? '',
      b.description ?? '',
      b.status ?? 'todo',
      b.priority ?? 'medium',
      b.kind ?? 'manual',
      b.critical_path_status ?? null,
      b.tags_json ?? '[]',
      b.due_date ?? null,
      b.start_date ?? null,
      b.estimated_duration ?? null,
      b.estimated_minutes ?? null,
      b.time_rollup_mode ?? 'additive',
      b.weight_percent ?? null,
      b.feel_score ?? null,
      b.completed ?? false,
      position,
      now,
      now,
    ],
  );

  if (b.goal_id) {
    await query(
      `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), b.goal_id, 'goal', id, 'task', 'contains', JSON.stringify({ kind: b.kind ?? 'manual' }), now],
    );
    await syncGoalMetrics(b.goal_id as string);
  }
  if (b.parent_task_id) {
    await query(
      `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), id, 'task', b.parent_task_id, 'task', 'subtask_of', null, now],
    );
  }

  res.json({ id });
  runInBackground(generateEntitySummary('task', id), 'task create summary');
  runInBackground(queueEmbeddingUpsert('task', id), 'task create embedding queue');
  if (b.tags_json) {
    import('../services/topicTagSync.js')
      .then(({ syncTagsToTopics, parseTags }) => syncTagsToTopics('task', id, parseTags(b.tags_json), 'manual'))
      .catch(err => console.warn('[tasks] tag→topic sync:', err));
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res) => {
  const now = new Date().toISOString();
  const { rows: existing } = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: 'Not found' });

  // Validate enum fields at the boundary
  const body = req.body as Record<string, unknown>;
  if (body.status !== undefined && !VALID_TASK_STATUSES.has(body.status as string)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_TASK_STATUSES].join(', ')}` });
  }
  if (body.priority !== undefined && !VALID_TASK_PRIORITIES.has(body.priority as string)) {
    return res.status(400).json({ error: `Invalid priority. Must be one of: ${[...VALID_TASK_PRIORITIES].join(', ')}` });
  }
  if (body.time_rollup_mode !== undefined && !VALID_TIME_ROLLUP_MODES.has(body.time_rollup_mode as string)) {
    return res.status(400).json({ error: `Invalid time_rollup_mode. Must be one of: ${[...VALID_TIME_ROLLUP_MODES].join(', ')}` });
  }
  if (body.feel_score !== undefined && body.feel_score !== null &&
      (!Number.isInteger(body.feel_score) || Number(body.feel_score) < 0 || Number(body.feel_score) > 100)) {
    return res.status(400).json({ error: 'feel_score must be a whole number from 0 to 100' });
  }
  try {
    if ('due_date' in body) requireISODate(body.due_date, 'due_date');
    if ('start_date' in body) requireISODate(body.start_date, 'start_date');
    if ('target_date' in body) requireISODate(body.target_date, 'target_date');
    if ('hard_deadline' in body) requireISODate(body.hard_deadline, 'hard_deadline');
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }

  const updates: Record<string, unknown> = { updated_at: now };
  for (const key of TASK_UPDATE_FIELDS) {
    if (key in body) updates[key] = body[key];
  }
  Object.assign(updates, synchronizedTaskDeadlineUpdates(
    body,
    existing[0] as Record<string, unknown>,
  ));
  // State coherence: keep completed and status in sync
  if (updates.completed === true && !('status' in body)) {
    updates.status = 'done';
  } else if (updates.completed === false && !('status' in body)) {
    const task = existing[0] as Record<string, unknown>;
    updates.status = task.last_activity_at ? 'in_progress' : 'todo';
  }

  const taskId = req.params.id;
  const prevParent = (existing[0] as Record<string, unknown>).parent_task_id as string | null;
  const newParent = 'parent_task_id' in body ? (body.parent_task_id as string | null) : prevParent;
  const parentChanged = 'parent_task_id' in body && newParent !== prevParent;

  const finalDueDate = dateOnly('due_date' in body ? body.due_date : (existing[0] as Record<string, unknown>).due_date);
  const parentDeadline = await findEffectiveParentDeadline(newParent);
  if (finalDueDate && parentDeadline && isDeadlineAfter(finalDueDate, parentDeadline.due_date)) {
    return res.status(409).json({ error: childDeadlineError(parentDeadline) });
  }

  // A parent cannot be shortened past any explicitly dated child at any depth.
  const effectiveTaskDeadline = finalDueDate ?? dateOnly(parentDeadline?.due_date);
  if (effectiveTaskDeadline) {
    const lateChild = await findDescendantPastDeadline(taskId, effectiveTaskDeadline);
    if (lateChild) {
      return res.status(409).json({
        error: `Parent task deadline cannot be ${effectiveTaskDeadline}: child task "${lateChild.title}" is due ${dateOnly(lateChild.due_date)}. Move the child deadline first.`,
      });
    }
  }

  const { sets, vals } = buildUpdate(updates);
  await transaction(async (client) => {
    await client.query(`UPDATE tasks SET ${sets} WHERE id = $${vals.length + 1}`, [...vals, taskId]);
    if (parentChanged) {
      // Remove old subtask_of edge
      await client.query(
        "DELETE FROM edges WHERE source_id=$1 AND source_type='task' AND relationship='subtask_of'",
        [taskId],
      );
      if (newParent) {
        await client.query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,'task',$3,'task','subtask_of',NULL,$4) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), taskId, newParent, now],
        );
      }
    }
  });

  const shouldSync = ['completed', 'status', 'parent_task_id', 'weight_percent'].some(k => k in body);
  const goalId = (body.goal_id ?? (existing[0] as Record<string, unknown>).goal_id) as string | null;
  if (shouldSync && goalId) await syncGoalMetrics(goalId);

  res.json({ ok: true });
  runInBackground(generateEntitySummary('task', taskId), 'task update summary');
  runInBackground(markEmbeddingStale('task', taskId), 'task update stale embedding');
  runInBackground(queueEmbeddingUpsert('task', taskId), 'task update embedding queue');
  // Choice A — tags ARE topics: user-typed tags join matching topics.
  if ('tags_json' in body) {
    import('../services/topicTagSync.js')
      .then(({ syncTagsToTopics, parseTags }) => syncTagsToTopics('task', taskId, parseTags(body.tags_json), 'manual'))
      .catch(err => console.warn('[tasks] tag→topic sync:', err));
  }
});

// POST /api/tasks/:id/toggle
router.post('/:id/toggle', async (req, res) => {
  const { rows } = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const task = rows[0] as Record<string, unknown>;
  const completed = !task.completed;
  const now = new Date().toISOString();
  const revertStatus = task.last_activity_at ? 'in_progress' : 'todo';
  await query(
    'UPDATE tasks SET completed=$1, status=$2, updated_at=$3 WHERE id=$4',
    [completed, completed ? 'done' : revertStatus, now, req.params.id],
  );
  const goalId = task.goal_id as string | null;
  const metrics = goalId ? await syncGoalMetrics(goalId) : undefined;
  res.json({ completed, metrics });
});

// POST /api/tasks/:id/complete
router.post('/:id/complete', async (req, res) => {
  const { rows } = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const task = rows[0] as Record<string, unknown>;
  const now = new Date().toISOString();
  const note = (req.body.completion_note ?? '').toString().trim();
  await query(
    'UPDATE tasks SET completed=true, status=$1, completion_note=$2, last_activity_at=$3, updated_at=$4 WHERE id=$5',
    ['done', note, now, now, req.params.id],
  );
  const goalId = task.goal_id as string | null;
  const metrics = goalId ? await syncGoalMetrics(goalId) : undefined;
  res.json({ ok: true, metrics });
});

// POST /api/tasks/:id/touch
router.post('/:id/touch', async (req, res) => {
  const { rows } = await query('SELECT id, status, goal_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const task = rows[0] as Record<string, unknown>;
  const now = new Date().toISOString();
  const newStatus = STARTABLE_TASK_STATUSES.has(String(task.status)) ? 'in_progress' : task.status;
  await query(
    'UPDATE tasks SET last_activity_at=$1, status=$2, updated_at=$3 WHERE id=$4',
    [now, newStatus, now, req.params.id],
  );
  const goalId = task.goal_id as string | null;
  if (goalId) await syncGoalMetrics(goalId);
  res.json({ ok: true, status: newStatus });
});

// POST /api/tasks/:id/deactivate
router.post('/:id/deactivate', async (req, res) => {
  const { rows } = await query('SELECT goal_id FROM tasks WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const task = rows[0] as Record<string, unknown>;
  const now = new Date().toISOString();
  await query("UPDATE tasks SET status='inactive', updated_at=$1 WHERE id=$2", [now, req.params.id]);
  const goalId = task.goal_id as string | null;
  if (goalId) await syncGoalMetrics(goalId);
  res.json({ ok: true });
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  const taskId = req.params.id;
  const { rows } = await query('SELECT goal_id FROM tasks WHERE id = $1', [taskId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const goalId = (rows[0] as Record<string, unknown>).goal_id as string | null;

  // Collect the full descendant tree (subtasks cascade on delete, but their side data does not)
  const { rows: descRows } = await query<{ id: string }>(
    `WITH RECURSIVE tree AS (
       SELECT id FROM tasks WHERE id = $1
       UNION ALL
       SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id
     ) SELECT id FROM tree`,
    [taskId],
  );
  const allTaskIds = descRows.map(r => r.id);

  await transaction(async (client) => {
    // Delete resources exclusively attached to any task in the tree
    await client.query(
      `DELETE FROM resources WHERE id IN (
         SELECT source_id FROM edges
         WHERE source_type = 'resource' AND relationship = 'attached_to'
           AND target_id = ANY($1::text[]) AND target_type = 'task'
           AND source_id NOT IN (
             SELECT source_id FROM edges
             WHERE source_type = 'resource' AND relationship = 'attached_to'
               AND (target_id != ALL($1::text[]) OR target_type != 'task')
           )
       )`,
      [allTaskIds],
    );
    // Explicitly delete work sessions (task_id FK is SET NULL, not CASCADE)
    await client.query('DELETE FROM work_sessions WHERE task_id = ANY($1::text[])', [allTaskIds]);
    // Clean up derived data for the whole tree
    await client.query(
      "DELETE FROM entity_summaries WHERE entity_type='task' AND entity_id = ANY($1::text[])",
      [allTaskIds],
    );
    await client.query(
      "DELETE FROM embedding_jobs WHERE entity_type='task' AND entity_id = ANY($1::text[]) AND status IN ('pending','failed')",
      [allTaskIds],
    );
    await client.query(
      `DELETE FROM edges WHERE (source_id = ANY($1::text[]) AND source_type = 'task')
                            OR (target_id = ANY($1::text[]) AND target_type = 'task')`,
      [allTaskIds],
    );
    // Clean derived evidence for all tasks in the tree
    await client.query(
      "DELETE FROM journal_links WHERE target_type='task' AND target_id = ANY($1::text[])",
      [allTaskIds],
    );
    await client.query(
      "DELETE FROM extracted_facts WHERE target_type='task' AND target_id = ANY($1::text[])",
      [allTaskIds],
    );
    await client.query(
      "DELETE FROM entity_aliases WHERE entity_type='task' AND entity_id = ANY($1::text[])",
      [allTaskIds],
    );
    await client.query(
      "DELETE FROM ai_action_proposals WHERE source_type='task' AND source_id = ANY($1::text[]) AND status='pending'",
      [allTaskIds],
    );
    // Delete the root task — subtasks cascade via FK ON DELETE CASCADE
    await client.query('DELETE FROM tasks WHERE id=$1', [taskId]);
  });

  if (goalId) await syncGoalMetrics(goalId);
  await query(
    "DELETE FROM embeddings WHERE entity_type='task' AND entity_id = ANY($1::text[])",
    [allTaskIds],
  );
  res.json({ ok: true });
});

// ── Task notes ────────────────────────────────────────────────────────────────

router.get('/:id/notes', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM task_notes WHERE task_id=$1 ORDER BY created_at ASC',
    [req.params.id],
  );
  res.json(rows);
});

router.post('/:id/notes', async (req, res) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await query(
    'INSERT INTO task_notes (id,task_id,content,created_at) VALUES ($1,$2,$3,$4)',
    [id, req.params.id, req.body.content ?? '', now],
  );
  const { rows } = await query('SELECT goal_id, status FROM tasks WHERE id=$1', [req.params.id]);
  if (rows.length) {
    const task = rows[0] as Record<string, unknown>;
    const newStatus = STARTABLE_TASK_STATUSES.has(String(task.status)) ? 'in_progress' : task.status;
    await query(
      'UPDATE tasks SET updated_at=$1, last_activity_at=$2, status=$3 WHERE id=$4',
      [now, now, newStatus, req.params.id],
    );
    if (task.goal_id) await syncGoalMetrics(task.goal_id as string);
  }
  res.json({ id });
});

router.patch('/notes/:noteId', async (req, res) => {
  await query('UPDATE task_notes SET content=$1 WHERE id=$2', [req.body.content, req.params.noteId]);
  res.json({ ok: true });
});

router.delete('/notes/:noteId', async (req, res) => {
  // Files cascade via FK; also delete physical files
  const { rows: files } = await query(
    'SELECT file_path FROM task_note_files WHERE note_id=$1',
    [req.params.noteId],
  );
  const { unlinkSync } = await import('fs');
  for (const f of files as { file_path: string }[]) {
    try { unlinkSync(f.file_path); } catch {}
  }
  await query('DELETE FROM task_notes WHERE id=$1', [req.params.noteId]);
  res.json({ ok: true });
});

export { router as tasksRouter };
