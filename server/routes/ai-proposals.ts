import { Router } from 'express';
import crypto from 'node:crypto';
import { query, transaction } from '../db.js';
import { activeProposals } from '../services/activeProposals.js';
import { validateModelActions } from '../services/actionValidation.js';
import { ARCHIVE_SCOPE_SQL, proposalTouchesArchive, activeTaskSql, activeEventSql, activeEntitySql } from '../utils/archiveVisibility.js';
import { synchronizedTaskDeadlineUpdates } from '../utils/taskDeadline.js';
import { eventDateServer, dateToWeekPosServer } from '../services/planLayout.js';
import { generateEntitySummary } from '../services/summaryGenerator.js';
import { markEmbeddingStale, queueEmbeddingUpsert } from '../services/embeddingLifecycle.js';
import { runInBackground } from '../utils/background.js';
import { createRoutine, updateRoutine, checkInRoutine, createRoutineSchema, updateRoutineSchema, routineCheckInSchema } from '../services/routines.js';
import { activeGoalSql } from '../utils/archiveVisibility.js';

// Durable proposals are shared by calendar, journal and Copilot UI controls.
const router = Router();
router.post('/apply', (_req, res) => {
  res.status(410).json({ error: 'Direct apply is disabled. Apply a durable proposal instead.' });
});

// GET /api/ai/proposals — pending AI-proposed actions
router.get('/proposals', async (_req, res) => {
  const { rows } = await query(
    `SELECT a.*, je.entry_date AS source_entry_date
     FROM ai_action_proposals a
     LEFT JOIN journal_entries je ON a.source_type='journal_entry' AND a.source_id=je.id
     WHERE a.status='pending'
     ORDER BY a.confidence DESC, a.created_at ASC`,
  );
  res.json(await activeProposals(rows));
});

// POST /api/ai/proposals/:id/apply
router.post('/proposals/:id/apply', async (req, res) => {
  const proposalId = req.params.id;
  let actionType = '';
  let actionResult: Record<string, unknown> = {};

  await transaction(async client => {
    // Lock the row first to prevent duplicate-apply races
    const { rows } = await client.query(
      `SELECT * FROM ai_action_proposals WHERE id=$1 FOR UPDATE`,
      [proposalId],
    );
    if (!rows.length) {
      const err = Object.assign(new Error('Proposal not found'), { status: 404 });
      throw err;
    }
    const proposal = rows[0] as Record<string, unknown>;
    if (proposal.status !== 'pending') {
      const err = Object.assign(new Error(`Proposal already ${proposal.status as string}`), { status: 409 });
      throw err;
    }

    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(proposal.action_payload as string ?? '{}'); } catch { /* */ }

    const validated = validateModelActions([{ type: proposal.action_type, params: payload }])[0];
    if (validated.rejected_reason) throw Object.assign(new Error(`Invalid proposal: ${validated.rejected_reason}`), { status: 400 });
    payload = validated.params;

    // A proposal may have been created before its target or ancestor was
    // archived. Recheck inside the same transaction as the eventual write.
    const { rows: archivedRows } = await client.query<{ entity_key: string }>(`${ARCHIVE_SCOPE_SQL} SELECT entity_key FROM archived_entities`);
    if (proposalTouchesArchive(proposal, new Set(archivedRows.map(row => row.entity_key)))) {
      throw Object.assign(new Error('This proposal refers to archived work.'), { status: 409 });
    }
    const references: Array<[unknown, string, string]> = [
      [payload.task_id, 'tasks', 'task'], [payload.parent_task_id, 'tasks', 'task'],
      [payload.goal_id, 'goals', 'goal'], [payload.milestone_id, 'goal_milestones', 'milestone'],
      [payload.resource_id, 'resources', 'resource'],
    ];
    if (payload.target_id) references.push([payload.target_id,
      payload.target_type === 'goal' ? 'goals' : payload.target_type === 'task' ? 'tasks' : 'goal_milestones', String(payload.target_type)]);
    for (const [id, table, type] of references) {
      if (typeof id !== 'string') continue;
      const { rows: found } = await client.query(`SELECT id FROM ${table} WHERE id=$1 AND ${activeEntitySql('$2::text', 'id')} FOR UPDATE`, [id, type]);
      if (!found.length) throw Object.assign(new Error(`Active ${type} not found`), { status: 404 });
    }
    if (typeof payload.routine_id === 'string') {
      const { rows: found } = await client.query(`SELECT id FROM routines WHERE id=$1 AND archived_at IS NULL AND ${activeGoalSql()} FOR UPDATE`, [payload.routine_id]);
      if (!found.length) throw Object.assign(new Error('Active routine not found'), { status: 404 });
    }

    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    actionType = proposal.action_type as string;

    if (actionType === 'create_routine') {
      const routine = await createRoutine(createRoutineSchema.parse(payload), client);
      actionResult.id = routine.id;
    } else if (actionType === 'update_routine') {
      const routine = await updateRoutine(String(payload.routine_id), updateRoutineSchema.parse(payload.changes), client);
      actionResult.id = routine.id;
    } else if (actionType === 'check_in_routine') {
      await checkInRoutine(String(payload.routine_id), routineCheckInSchema.parse(payload.entry), client);
      actionResult.id = payload.routine_id;
    } else if (actionType === 'create_task') {
      const { goal_id, parent_task_id, milestone_id, title, due_date, start_date, priority, estimated_minutes, status } = payload;
      const { rows: countRows } = await client.query('SELECT COUNT(*) as c FROM tasks WHERE goal_id=$1', [goal_id ?? null]);
      const count = Number((countRows[0] as Record<string, unknown>).c ?? 0);
      await client.query(
        `INSERT INTO tasks (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [newId, goal_id ?? null, parent_task_id ?? null, milestone_id ?? null, title, '', status ?? 'todo', priority ?? 'medium', 'manual', '[]', due_date ?? null, start_date ?? null, estimated_minutes ?? null, false, count, now, now],
      );
      actionResult.id = newId;
      actionResult.created_task_id = newId; // for post-commit side effects
    } else if (actionType === 'break_down_task') {
      const { parent_task_id, tasks } = payload as {
        parent_task_id: string;
        tasks: Array<{
          title: string;
          due_date?: string;
          start_date?: string;
          priority?: string;
          estimated_minutes?: number;
        }>;
      };
      const { rows: parentRows } = await client.query<{
        id: string;
        goal_id: string | null;
        milestone_id: string | null;
        due_date: string | null;
      }>(
        `SELECT id, goal_id, milestone_id, due_date
         FROM tasks WHERE id=$1`,
        [parent_task_id],
      );
      if (!parentRows.length) {
        throw Object.assign(new Error('Parent task not found'), { status: 404 });
      }
      const parent = parentRows[0];
      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) as c FROM tasks WHERE parent_task_id=$1',
        [parent_task_id],
      );
      const startPosition = Number((countRows[0] as Record<string, unknown>).c ?? 0);
      const createdTaskIds: string[] = [];

      for (const [index, child] of tasks.entries()) {
        if (child.due_date && parent.due_date && child.due_date > parent.due_date.slice(0, 10)) {
          throw Object.assign(
            new Error(`Child task "${child.title}" cannot be due after its parent (${parent.due_date.slice(0, 10)})`),
            { status: 409 },
          );
        }
        const childId = crypto.randomUUID();
        createdTaskIds.push(childId);
        await client.query(
          `INSERT INTO tasks
            (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,
             due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,'','todo',$6,'manual','[]',$7,$8,$9,false,$10,$11,$11)`,
          [
            childId,
            parent.goal_id,
            parent_task_id,
            parent.milestone_id,
            child.title,
            child.priority ?? 'medium',
            child.due_date ?? null,
            child.start_date ?? null,
            child.estimated_minutes ?? null,
            startPosition + index,
            now,
          ],
        );
        if (parent.goal_id) {
          await client.query(
            `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
             VALUES ($1,$2,'goal',$3,'task','contains',$4,$5) ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), parent.goal_id, childId, JSON.stringify({ kind: 'ai_breakdown' }), now],
          );
        }
        await client.query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,'task',$3,'task','subtask_of',$4,$5) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), childId, parent_task_id, JSON.stringify({ origin: 'ai_breakdown' }), now],
        );
      }
      actionResult.id = parent_task_id;
      actionResult.created_task_ids = createdTaskIds;
    } else if (actionType === 'update_task') {
      const { task_id, ...fields } = payload;
      const { rows: existingTasks } = await client.query(
        'SELECT target_date, hard_deadline FROM tasks WHERE id=$1 FOR UPDATE',
        [task_id],
      );
      if (!existingTasks.length) throw Object.assign(new Error('Task not found'), { status: 404 });
      const updates: Record<string, unknown> = { updated_at: now };
      const allowed = ['due_date', 'start_date', 'priority', 'status', 'estimated_minutes', 'milestone_id'];
      for (const k of allowed) { if (fields[k] !== undefined) updates[k] = fields[k]; }
      Object.assign(updates, synchronizedTaskDeadlineUpdates(
        fields,
        existingTasks[0] as Record<string, unknown>,
      ));
      const entries = Object.entries(updates);
      const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
      const vals = entries.map(([, v]) => v);
      await client.query(`UPDATE tasks SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, task_id]);
      actionResult.updated_task_id = task_id; // for post-commit side effects
    } else if (actionType === 'move_schedule_items') {
      const { source_date, target_date, entity_types, preserve_event_times } = payload as {
        source_date: string;
        target_date: string;
        entity_types: Array<'tasks' | 'deadlines' | 'events'>;
        preserve_event_times: true;
      };
      if (!preserve_event_times || source_date === target_date) {
        throw Object.assign(new Error('Invalid semantic move request'), { status: 400 });
      }
      const selected = new Set(entity_types);
      let movedEvents = 0;
      let lockedEvents = 0;
      let movedTaskStarts = 0;
      let movedTaskDeadlines = 0;

      if (selected.has('events')) {
        const { rows: eventRows } = await client.query(
          `SELECT id, week_start, day_index, locked FROM events WHERE ${activeEventSql()} AND week_start IS NOT NULL FOR UPDATE`,
        );
        const sourceEvents = (eventRows as Array<{ id: string; week_start: string; day_index: number; locked: boolean }>)
          .filter(event => eventDateServer(event.week_start, Number(event.day_index ?? 0)) === source_date);
        const movableIds = sourceEvents.filter(event => !event.locked).map(event => event.id);
        lockedEvents = sourceEvents.length - movableIds.length;
        if (movableIds.length) {
          const target = dateToWeekPosServer(target_date);
          const result = await client.query(
            `UPDATE events SET week_start=$1, day_index=$2, updated_at=$3 WHERE id = ANY($4)`,
            [target.week_start, target.day_index, now, movableIds],
          );
          movedEvents = result.rowCount ?? 0;
        }
      }

      if (selected.has('tasks')) {
        const result = await client.query(
          `UPDATE tasks SET start_date=$1, updated_at=$2
           WHERE completed=false AND ${activeTaskSql()} AND start_date=$3`,
          [target_date, now, source_date],
        );
        movedTaskStarts = result.rowCount ?? 0;
      }

      if (selected.has('deadlines')) {
        const result = await client.query(
          `UPDATE tasks
           SET due_date=CASE WHEN due_date=$1 THEN $2 ELSE due_date END,
               target_date=CASE WHEN target_date=$1 THEN $2 ELSE target_date END,
               hard_deadline=CASE WHEN hard_deadline=$1 THEN $2 ELSE hard_deadline END,
               updated_at=$3
           WHERE completed=false AND ${activeTaskSql()} AND (due_date=$1 OR target_date=$1 OR hard_deadline=$1)`,
          [source_date, target_date, now],
        );
        movedTaskDeadlines = result.rowCount ?? 0;
      }

      actionResult = {
        source_date,
        target_date,
        moved_events: movedEvents,
        locked_events_unchanged: lockedEvents,
        moved_task_start_dates: movedTaskStarts,
        moved_task_deadlines: movedTaskDeadlines,
      };
    } else if (actionType === 'create_goal') {
      const { title, description, deadline, start_date, category } = payload;
      await client.query(
        `INSERT INTO goals (id,title,description,category,status,progress,deadline,start_date,overdue,activity_level,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [newId, title, description ?? '', category ?? 'Work', 'Safe', 0, deadline ?? null, start_date ?? null, false, 1, now, now],
      );
      actionResult.id = newId;
      actionResult.created_goal_id = newId; // for post-commit side effects
    } else if (actionType === 'create_goal_with_tasks') {
      const { title, description, deadline, start_date, category, tasks } = payload as {
        title: string;
        description?: string;
        deadline?: string;
        start_date?: string;
        category?: string;
        tasks?: Array<Record<string, unknown>>;
      };
      const createdTaskIds: string[] = [];
      await client.query(
        `INSERT INTO goals (id,title,description,category,status,progress,deadline,start_date,overdue,activity_level,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [newId, title, description ?? '', category ?? 'Work', 'Safe', 0, deadline ?? null, start_date ?? null, false, 1, now, now],
      );
      for (const [index, task] of (tasks ?? []).entries()) {
        const taskId = crypto.randomUUID();
        createdTaskIds.push(taskId);
        await client.query(
          `INSERT INTO tasks (id,goal_id,parent_task_id,milestone_id,title,description,status,priority,kind,tags_json,due_date,start_date,estimated_minutes,completed,position,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            taskId,
            newId,
            null,
            null,
            task.title,
            '',
            task.status ?? 'todo',
            task.priority ?? 'medium',
            'manual',
            '[]',
            task.due_date ?? null,
            task.start_date ?? start_date ?? null,
            task.estimated_minutes ?? null,
            false,
            index,
            now,
            now,
          ],
        );
        await client.query(
          `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [crypto.randomUUID(), newId, 'goal', taskId, 'task', 'contains', '{}', now],
        );
      }
      actionResult.id = newId;
      actionResult.created_goal_id = newId;
      actionResult.created_task_ids = createdTaskIds;
    } else if (actionType === 'update_goal') {
      const { goal_id, ...fields } = payload;
      const updates: Record<string, unknown> = { updated_at: now };
      if (fields.deadline !== undefined) updates.deadline = fields.deadline;
      if (fields.status   !== undefined) updates.status   = fields.status;
      const entries = Object.entries(updates);
      const sets = entries.map(([col], i) => `${col}=$${i + 1}`).join(',');
      const vals = entries.map(([, v]) => v);
      await client.query(`UPDATE goals SET ${sets} WHERE id=$${vals.length + 1}`, [...vals, goal_id]);
      // Store goal_id so post-commit side effects can be triggered after the transaction
      actionResult.updated_goal_id = goal_id;
    } else if (actionType === 'create_milestone') {
      const { goal_id, title, description, due_date, color } = payload;
      const { rows: countRows } = await client.query('SELECT COUNT(*) as c FROM goal_milestones WHERE goal_id=$1', [goal_id]);
      const count = Number((countRows[0] as Record<string, unknown>).c ?? 0);
      await client.query(
        `INSERT INTO goal_milestones (id,goal_id,title,description,due_date,color,position,completed,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [newId, goal_id, title ?? '', description ?? '', due_date ?? null, color ?? '#6366f1', count, false, now, now],
      );
      actionResult.id = newId;
      actionResult.created_milestone_id = newId; // for post-commit summary generation
    } else if (actionType === 'attach_resource') {
      const { resource_id, target_type, target_id } = payload as { resource_id: string; target_type: string; target_id: string };
      // Both endpoints must exist — an attach to a hallucinated id must fail loudly
      const { rows: resRows } = await client.query('SELECT id, title FROM resources WHERE id=$1', [resource_id]);
      if (!resRows.length) throw Object.assign(new Error('Resource not found'), { status: 404 });
      const targetTable = target_type === 'goal' ? 'goals' : target_type === 'task' ? 'tasks' : 'goal_milestones';
      const { rows: tgtRows } = await client.query(`SELECT id FROM ${targetTable} WHERE id=$1`, [target_id]);
      if (!tgtRows.length) throw Object.assign(new Error(`${target_type} not found`), { status: 404 });
      await client.query(
        `INSERT INTO edges (id,source_id,source_type,target_id,target_type,relationship,metadata,created_at)
         VALUES ($1,$2,'resource',$3,$4,'attached_to','{}',$5) ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), resource_id, target_id, target_type, now],
      );
      actionResult.attached_resource_id = resource_id;
      actionResult.attached_to = `${target_type}:${target_id}`;
    } else {
      const err = Object.assign(new Error(`Unknown action type: ${actionType}`), { status: 400 });
      throw err;
    }

    // Transition proposal to applied in same transaction — prevents double-apply
    await client.query(
      `UPDATE ai_action_proposals SET status='applied', applied_at=$1 WHERE id=$2`,
      [now, proposalId],
    );
  });

  // Post-commit side effects: run after the transaction so they're never rolled back with it.
  // We fire-and-forget so the response is immediate, but these always execute after commit.
  if (actionResult.created_task_id) {
    const tid = actionResult.created_task_id as string;
    runInBackground(generateEntitySummary('task', tid), 'proposal create task summary');
    runInBackground(queueEmbeddingUpsert('task', tid), 'proposal create task embedding queue');
    delete actionResult.created_task_id;
  }
  if (Array.isArray(actionResult.created_task_ids)) {
    for (const tid of actionResult.created_task_ids as string[]) {
      runInBackground(generateEntitySummary('task', tid), 'proposal create goal task summary');
      runInBackground(queueEmbeddingUpsert('task', tid), 'proposal create goal task embedding queue');
    }
    delete actionResult.created_task_ids;
  }
  if (actionResult.updated_task_id) {
    const tid = actionResult.updated_task_id as string;
    runInBackground(markEmbeddingStale('task', tid), 'proposal update task stale embedding');
    runInBackground(queueEmbeddingUpsert('task', tid), 'proposal update task embedding queue');
    delete actionResult.updated_task_id;
  }
  if (actionResult.created_goal_id) {
    const gid = actionResult.created_goal_id as string;
    runInBackground(generateEntitySummary('goal', gid), 'proposal create goal summary');
    runInBackground(queueEmbeddingUpsert('goal', gid), 'proposal create goal embedding queue');
    delete actionResult.created_goal_id;
  }
  if (actionResult.updated_goal_id) {
    const gid = actionResult.updated_goal_id as string;
    runInBackground(generateEntitySummary('goal', gid), 'proposal update goal summary');
    runInBackground(markEmbeddingStale('goal', gid), 'proposal update goal stale embedding');
    runInBackground(queueEmbeddingUpsert('goal', gid), 'proposal update goal embedding queue');
    delete actionResult.updated_goal_id;
  }
  if (actionResult.created_milestone_id) {
    const mid = actionResult.created_milestone_id as string;
    runInBackground(generateEntitySummary('milestone', mid), 'proposal create milestone summary');
    delete actionResult.created_milestone_id;
  }

  res.json({ ok: true, action_type: actionType, ...actionResult });
});

// POST /api/ai/proposals/:id/reject — only pending proposals may be rejected
router.post('/proposals/:id/reject', async (req, res) => {
  await transaction(async client => {
    const { rows } = await client.query(
      `SELECT status FROM ai_action_proposals WHERE id=$1 FOR UPDATE`,
      [req.params.id],
    );
    if (!rows.length) {
      throw Object.assign(new Error('Proposal not found'), { status: 404 });
    }
    const { status } = rows[0] as { status: string };
    if (status !== 'pending') {
      throw Object.assign(new Error(`Cannot reject a proposal with status '${status}'`), { status: 409 });
    }
    await client.query(
      `UPDATE ai_action_proposals SET status='rejected' WHERE id=$1`,
      [req.params.id],
    );
  });
  res.json({ ok: true });
});


export { router as aiProposalsRouter };
