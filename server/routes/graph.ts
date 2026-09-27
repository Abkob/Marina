import { Router } from 'express';
import { activeTaskSql, activeMilestoneSql, activeMeetingSql, activeResourceSql } from '../utils/archiveVisibility.js';
import { query } from '../db.js';

const router = Router();

// GET /api/graph?goal_id=xxx
router.get('/', async (req, res) => {
  const { goal_id } = req.query;
  const since30 = new Date();
  since30.setDate(since30.getDate() - 30);
  const since30Str = `${since30.getFullYear()}-${String(since30.getMonth() + 1).padStart(2, '0')}-${String(since30.getDate()).padStart(2, '0')}`;

  const [
    { rows: goals },
    { rows: milestones },
    { rows: tasks },
    { rows: resources },
    { rows: meetings },
    { rows: journals },
    { rows: edges },
    { rows: journalLinks },
  ] = await Promise.all([
    query('SELECT id, title, status, deadline FROM goals WHERE archived_at IS NULL'),
    query(`SELECT id, goal_id, title, due_date, completed FROM goal_milestones WHERE ${activeMilestoneSql()}`),
    query(`SELECT id, goal_id, milestone_id, title, status, completed FROM tasks WHERE completed=false AND ${activeTaskSql()}`),
    query(`SELECT id, title, type FROM resources WHERE ${activeResourceSql()}`),
    query(`SELECT id, goal_id, title, scheduled_at FROM meetings WHERE ${activeMeetingSql()}`),
    query(`SELECT id, entry_date, summary FROM journal_entries WHERE entry_date >= $1`, [since30Str]),
    query('SELECT id, source_id, source_type, target_id, target_type, relationship FROM edges'),
    query('SELECT id, journal_entry_id, target_id, target_type, relationship, confidence FROM journal_links WHERE confidence >= 0.4'),
  ]);

  // Build node set — use "type:id" keys to avoid cross-type UUID collisions
  type GraphNode = { id: string; type: string; label: string; metadata: Record<string, unknown> };
  const nodes: GraphNode[] = [];
  const nodeKeys = new Set<string>(); // typed keys already added

  const addNode = (type: string, rawId: string, label: string, meta: Record<string, unknown>) => {
    const key = `${type}:${rawId}`;
    if (nodeKeys.has(key)) return;
    nodeKeys.add(key);
    nodes.push({ id: key, type, label, metadata: { ...meta, raw_id: rawId } });
  };

  for (const g of goals) {
    const r = g as Record<string, unknown>;
    if (goal_id && r.id !== goal_id) continue;
    addNode('goal', r.id as string, r.title as string, { status: r.status, deadline: r.deadline });
  }

  for (const m of milestones) {
    const r = m as Record<string, unknown>;
    if (goal_id && r.goal_id !== goal_id) continue;
    addNode('milestone', r.id as string, r.title as string, { goal_id: r.goal_id, due_date: r.due_date, completed: r.completed });
  }

  for (const t of tasks) {
    const r = t as Record<string, unknown>;
    if (goal_id && r.goal_id !== goal_id) continue;
    addNode('task', r.id as string, r.title as string, { goal_id: r.goal_id, milestone_id: r.milestone_id, status: r.status });
  }

  for (const r of resources) {
    const row = r as Record<string, unknown>;
    if (goal_id) {
      const isAttached = edges.some((e: Record<string, unknown>) =>
        e.source_id === row.id && e.source_type === 'resource' &&
        e.target_id === goal_id && e.relationship === 'attached_to'
      );
      if (!isAttached) continue;
    }
    addNode('resource', row.id as string, row.title as string, { type: row.type });
  }

  for (const m of meetings) {
    const r = m as Record<string, unknown>;
    if (goal_id && r.goal_id !== goal_id) continue;
    addNode('meeting', r.id as string, r.title as string, { goal_id: r.goal_id, scheduled_at: r.scheduled_at });
  }

  for (const j of journals) {
    const r = j as Record<string, unknown>;
    addNode('journal', r.id as string, `Journal ${r.entry_date}`, { entry_date: r.entry_date, summary: (r.summary as string | null)?.slice(0, 80) });
  }

  // Limit: trim to 300 if exceeded
  const nodeSlice = nodes.slice(0, 300);
  const validKeys = new Set(nodeSlice.map(n => n.id)); // typed keys present in final slice

  // Build edges (filter orphans) — source/target are also typed "type:id" keys
  type GraphEdge = { id: string; source: string; target: string; relationship: string; weight: number };
  const graphEdges: GraphEdge[] = [];

  for (const e of edges) {
    const r = e as Record<string, unknown>;
    const src = `${r.source_type}:${r.source_id}`;
    const tgt = `${r.target_type}:${r.target_id}`;
    if (validKeys.has(src) && validKeys.has(tgt)) {
      graphEdges.push({ id: r.id as string, source: src, target: tgt, relationship: r.relationship as string, weight: 1 });
    }
  }

  for (const jl of journalLinks) {
    const r = jl as Record<string, unknown>;
    const src = `journal:${r.journal_entry_id}`;
    const tgt = `${r.target_type}:${r.target_id}`;
    if (validKeys.has(src) && validKeys.has(tgt)) {
      graphEdges.push({ id: r.id as string, source: src, target: tgt, relationship: 'journal_evidence', weight: Number(r.confidence) });
    }
  }

  res.json({
    nodes: nodeSlice,
    edges: graphEdges,
    truncated: nodes.length > 300,
    total_nodes: nodes.length,
  });
});

export { router as graphRouter };
