import crypto from 'crypto';
import { query } from '../db.js';
import { chat, parseJSON, CHAT_MODEL } from '../ollama.js';

const DETERMINISTIC_MODEL = 'deterministic';

// ─── Entity text builders (deterministic — no LLM) ───────────────────────────

async function buildPlanningText(type: string, id: string): Promise<string | null> {
  if (type === 'goal') {
    const { rows } = await query('SELECT * FROM goals WHERE id=$1', [id]);
    if (!rows.length) return null;
    const g = rows[0] as Record<string, unknown>;
    const { rows: ms } = await query('SELECT title, due_date, completed FROM goal_milestones WHERE goal_id=$1 ORDER BY position ASC', [id]);
    const { rows: deadlines } = await query('SELECT title, date FROM goal_deadlines WHERE goal_id=$1', [id]);
    return [
      `Entity: Goal`,
      `Title: ${g.title}`,
      g.description ? `Description: ${g.description}` : null,
      `Category: ${g.category} | Status: ${g.status} | Progress: ${g.progress}%`,
      g.deadline ? `Deadline: ${g.deadline}` : null,
      g.archived_at ? `Archived: ${g.archived_at}` : null,
      ms.length ? `Milestones: ${ms.map((m: Record<string, unknown>) => `${m.title}${m.due_date ? ` (due ${m.due_date})` : ''}${m.completed ? ' ✓' : ''}`).join(', ')}` : null,
      deadlines.length ? `External deadlines: ${deadlines.map((d: Record<string, unknown>) => `${d.title} ${d.date}`).join(', ')}` : null,
    ].filter(Boolean).join('\n');
  }

  if (type === 'task') {
    const { rows } = await query('SELECT * FROM tasks WHERE id=$1', [id]);
    if (!rows.length) return null;
    const t = rows[0] as Record<string, unknown>;
    const { rows: gr } = t.goal_id ? await query('SELECT title FROM goals WHERE id=$1', [t.goal_id]) : { rows: [] };
    const { rows: mr } = t.milestone_id ? await query('SELECT title, due_date FROM goal_milestones WHERE id=$1', [t.milestone_id]) : { rows: [] };
    const { rows: blockers } = await query(
      `SELECT t.title FROM tasks t JOIN edges e ON e.source_id=t.id WHERE e.target_id=$1 AND e.relationship='blocks'`,
      [id],
    );
    const { rows: ws } = await query('SELECT SUM(minutes) as total FROM work_sessions WHERE task_id=$1', [id]);
    const logged = Number((ws[0] as Record<string, unknown>)?.total ?? t.actual_minutes ?? 0);
    const est = Number(t.estimated_minutes ?? 0);
    const remaining = est > 0 ? Math.max(0, est - logged) : null;
    return [
      `Entity: Task`,
      `Title: ${t.title}`,
      t.description ? `Description: ${t.description}` : null,
      gr.length ? `Goal: ${(gr[0] as Record<string, unknown>).title}` : null,
      mr.length ? `Milestone: ${(mr[0] as Record<string, unknown>).title}${(mr[0] as Record<string, unknown>).due_date ? ` (due ${(mr[0] as Record<string, unknown>).due_date})` : ''}` : null,
      `Status: ${t.status} | Priority: ${t.priority} | Kind: ${t.kind}`,
      t.feel_score != null ? `Feel score: ${t.feel_score}/100 (user's subjective need signal)` : null,
      t.due_date ? `Due: ${t.due_date}` : null,
      est > 0 ? `Estimated: ${est}min | Logged: ${logged}min | Remaining: ${remaining}min` : null,
      blockers.length ? `Blocked by: ${blockers.map((b: Record<string, unknown>) => b.title).join(', ')}` : null,
      t.completed ? `Completed: yes` : null,
    ].filter(Boolean).join('\n');
  }

  if (type === 'milestone') {
    const { rows } = await query('SELECT * FROM goal_milestones WHERE id=$1', [id]);
    if (!rows.length) return null;
    const m = rows[0] as Record<string, unknown>;
    const { rows: gr } = await query('SELECT title FROM goals WHERE id=$1', [m.goal_id]);
    const { rows: tasks } = await query(
      'SELECT COUNT(*) as total, SUM(CASE WHEN completed THEN 1 ELSE 0 END) as done FROM tasks WHERE milestone_id=$1',
      [id],
    );
    const t = tasks[0] as Record<string, unknown>;
    return [
      `Entity: Milestone`,
      `Title: ${m.title}`,
      m.description ? `Description: ${m.description}` : null,
      gr.length ? `Goal: ${(gr[0] as Record<string, unknown>).title}` : null,
      m.due_date ? `Due: ${m.due_date}` : null,
      `Completed: ${m.completed ? 'yes' : 'no'}`,
      `Tasks: ${t.done ?? 0}/${t.total ?? 0} done`,
    ].filter(Boolean).join('\n');
  }

  if (type === 'resource') {
    const { rows } = await query('SELECT * FROM resources WHERE id=$1', [id]);
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    return [
      `Entity: Resource`,
      `Title: ${r.title}`,
      r.description ? `Description: ${r.description}` : null,
      r.info ? `Info: ${r.info}` : null,
      `Type: ${r.type} | Read state: ${r.read_state}`,
      r.next_action ? `Next action: ${r.next_action}` : null,
      r.estimated_minutes ? `Estimated reading: ${r.estimated_minutes}min` : null,
      r.url ? `URL: ${r.url}` : null,
    ].filter(Boolean).join('\n');
  }

  if (type === 'meeting') {
    const { rows } = await query('SELECT * FROM meetings WHERE id=$1', [id]);
    if (!rows.length) return null;
    const m = rows[0] as Record<string, unknown>;
    const { rows: gr } = m.goal_id ? await query('SELECT title FROM goals WHERE id=$1', [m.goal_id]) : { rows: [] };
    return [
      `Entity: Meeting`,
      `Title: ${m.title}`,
      gr.length ? `Goal: ${(gr[0] as Record<string, unknown>).title}` : null,
      `Scheduled: ${m.scheduled_at} | Duration: ${m.duration_minutes}min`,
      m.location ? `Location: ${m.location}` : null,
      m.notes ? `Notes: ${m.notes}` : null,
      m.summary ? `Summary: ${m.summary}` : null,
    ].filter(Boolean).join('\n');
  }

  return null;
}

// ─── Evidence summary (deterministic — no LLM) ───────────────────────────────

async function buildEvidenceText(type: string, id: string): Promise<string | null> {
  const { rows: facts } = await query(
    `SELECT fact_text, fact_type, confidence
     FROM extracted_facts
     WHERE target_type=$1 AND target_id=$2 AND status='active' AND confidence >= 0.5
     ORDER BY confidence DESC, created_at DESC LIMIT 20`,
    [type, id],
  );
  if (!facts.length) return null;
  const lines = (facts as { fact_text: string; fact_type: string; confidence: number }[])
    .map(f => `• [${f.fact_type}] ${f.fact_text} (${(f.confidence * 100).toFixed(0)}%)`);
  return `Evidence for ${type}:\n${lines.join('\n')}`;
}

export async function generateEvidenceSummary(type: string, id: string): Promise<void> {
  const text = await buildEvidenceText(type, id);
  if (!text) return;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const { rows: existing } = await query(
    `SELECT source_hash FROM entity_summaries WHERE entity_type=$1 AND entity_id=$2 AND summary_type='evidence'`,
    [type, id],
  );
  if ((existing[0] as Record<string, unknown> | undefined)?.source_hash === hash) return;
  await upsertSummary(type, id, 'evidence', text, hash, DETERMINISTIC_MODEL);
}

// ─── Graph-card summary (ultra-short, for graph node tooltips) ────────────────

async function buildGraphCardText(type: string, id: string): Promise<string | null> {
  if (type === 'goal') {
    const { rows } = await query('SELECT title, status, progress FROM goals WHERE id=$1', [id]);
    if (!rows.length) return null;
    const g = rows[0] as Record<string, unknown>;
    return `goal | ${g.title} | ${g.status} | ${g.progress}% complete`;
  }
  if (type === 'task') {
    const { rows } = await query('SELECT title, status, priority, feel_score FROM tasks WHERE id=$1', [id]);
    if (!rows.length) return null;
    const t = rows[0] as Record<string, unknown>;
    return `task | ${t.title} | ${t.status} | ${t.priority} priority${t.feel_score != null ? ` | feel ${t.feel_score}/100` : ''}`;
  }
  if (type === 'milestone') {
    const { rows } = await query('SELECT title, completed, due_date FROM goal_milestones WHERE id=$1', [id]);
    if (!rows.length) return null;
    const m = rows[0] as Record<string, unknown>;
    return `milestone | ${m.title} | ${m.completed ? 'done' : 'pending'}${m.due_date ? ` | due ${m.due_date}` : ''}`;
  }
  if (type === 'resource') {
    const { rows } = await query('SELECT title, type, read_state FROM resources WHERE id=$1', [id]);
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    return `resource | ${r.title} | ${r.type} | ${r.read_state}`;
  }
  if (type === 'meeting') {
    const { rows } = await query('SELECT title, scheduled_at FROM meetings WHERE id=$1', [id]);
    if (!rows.length) return null;
    const m = rows[0] as Record<string, unknown>;
    return `meeting | ${m.title} | ${String(m.scheduled_at).slice(0, 10)}`;
  }
  return null;
}

export async function generateGraphCardSummary(type: string, id: string): Promise<void> {
  const text = await buildGraphCardText(type, id);
  if (!text) return;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const { rows: existing } = await query(
    `SELECT source_hash FROM entity_summaries WHERE entity_type=$1 AND entity_id=$2 AND summary_type='graph_card'`,
    [type, id],
  );
  if ((existing[0] as Record<string, unknown> | undefined)?.source_hash === hash) return;
  await upsertSummary(type, id, 'graph_card', text, hash, DETERMINISTIC_MODEL);
}

// ─── Upsert helper ────────────────────────────────────────────────────────────

async function upsertSummary(
  type: string, id: string,
  summaryType: string, summaryText: string,
  sourceHash: string, model: string,
): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO entity_summaries
       (id, entity_type, entity_id, summary_type, summary_text, source_hash, summary_model, summary_version, needs_review, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,false,$8,$9)
     ON CONFLICT (entity_type, entity_id, summary_type) DO UPDATE
       SET summary_text=$5, source_hash=$6, summary_model=$7,
           summary_version = entity_summaries.summary_version + 1,
           needs_review=false, updated_at=$9`,
    [crypto.randomUUID(), type, id, summaryType, summaryText, sourceHash, model, now, now],
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Fast, always works — no LLM. Generates planning + evidence + graph_card summaries.
export async function generateDeterministicSummaries(type: string, id: string): Promise<void> {
  const text = await buildPlanningText(type, id);
  if (!text) return;
  const hash = crypto.createHash('sha256').update(text).digest('hex');

  const { rows: existing } = await query(
    `SELECT source_hash, summary_model FROM entity_summaries
     WHERE entity_type=$1 AND entity_id=$2 AND summary_type='planning'`,
    [type, id],
  );
  const row = existing[0] as Record<string, unknown> | undefined;
  if (!(row?.source_hash === hash && row?.summary_model === DETERMINISTIC_MODEL)) {
    await upsertSummary(type, id, 'planning', text, hash, DETERMINISTIC_MODEL);
  }

  // These are cheap and always correct — run alongside planning
  await Promise.all([
    generateEvidenceSummary(type, id),
    generateGraphCardSummary(type, id),
  ]).catch(err => console.warn('[summary] evidence/graph_card:', err));
}

// Full generation — planning (deterministic) + semantic (LLM).
export async function generateAllSummaries(type: string, id: string): Promise<void> {
  const text = await buildPlanningText(type, id);
  if (!text) return;
  const hash = crypto.createHash('sha256').update(text).digest('hex');

  // Planning — always deterministic
  const { rows: existing } = await query(
    `SELECT source_hash, summary_model FROM entity_summaries
     WHERE entity_type=$1 AND entity_id=$2 AND summary_type='planning'`,
    [type, id],
  );
  const planRow = existing[0] as Record<string, unknown> | undefined;
  if (!(planRow?.source_hash === hash && planRow?.summary_model === DETERMINISTIC_MODEL)) {
    await upsertSummary(type, id, 'planning', text, hash, DETERMINISTIC_MODEL);
  }

  // Semantic — LLM, skip if source text unchanged
  const { rows: semExisting } = await query(
    `SELECT source_hash FROM entity_summaries
     WHERE entity_type=$1 AND entity_id=$2 AND summary_type='semantic'`,
    [type, id],
  );
  if ((semExisting[0] as Record<string, unknown> | undefined)?.source_hash === hash) return;

  let semantic: string;
  try {
    const raw = await chat([
      {
        role: 'system',
        content: 'You write ultra-concise entity descriptions for an AI planning copilot. Return ONLY the description — no JSON, no fences.',
      },
      {
        role: 'user',
        content: `Write 1-2 sentences describing what this entity is and why it matters for planning:\n\n${text}`,
      },
    ], { temperature: 0.1, max_tokens: 128 });
    semantic = raw.trim();
  } catch {
    semantic = text.split('\n').slice(0, 2).join(' ');
  }

  await upsertSummary(type, id, 'semantic', semantic, hash, CHAT_MODEL);
}

// Legacy export — kept for existing callers in route triggers
export async function generateEntitySummary(type: string, id: string): Promise<void> {
  return generateAllSummaries(type, id);
}

// ─── Journal digest — built from journal_links, no LLM ───────────────────────

export async function generateJournalDigestSummary(type: string, id: string): Promise<void> {
  const { rows: links } = await query(
    `SELECT je.entry_date, je.summary
     FROM journal_links jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE jl.target_type=$1 AND jl.target_id=$2 AND je.ingestion_status='processed' AND je.summary IS NOT NULL
     ORDER BY je.entry_date DESC LIMIT 5`,
    [type, id],
  );
  if (!links.length) return;

  const digestText = (links as { entry_date: string; summary: string }[])
    .map(l => `${l.entry_date}: ${l.summary}`)
    .join('\n');
  const hash = crypto.createHash('sha256').update(digestText).digest('hex');

  const { rows: existing } = await query(
    `SELECT source_hash FROM entity_summaries
     WHERE entity_type=$1 AND entity_id=$2 AND summary_type='journal_digest'`,
    [type, id],
  );
  if ((existing[0] as Record<string, unknown> | undefined)?.source_hash === hash) return;

  await upsertSummary(type, id, 'journal_digest', digestText, hash, DETERMINISTIC_MODEL);
}

export async function deleteEntitySummaries(type: string, id: string): Promise<void> {
  await query('DELETE FROM entity_summaries WHERE entity_type=$1 AND entity_id=$2', [type, id]);
}
