import os from 'node:os';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { getPool, query } from '../db.js';
import { getObsidianVaultDir } from './obsidianVaultSync.js';

export type TableUsage = {
  table: string;
  totalBytes: number;
  dataBytes: number;
  indexBytes: number;
  estimatedRows: number;
  deadRows: number;
};

const FEATURE_TABLES: Array<{ key: string; label: string; description: string; tables: string[] }> = [
  {
    key: 'tasks', label: 'Tasks & goals', description: 'Tasks, goals, milestones, deadlines, and relationships.',
    tables: ['goals', 'tasks', 'goal_deadlines', 'goal_milestones', 'edges'],
  },
  {
    key: 'schedule', label: 'Schedule & work logs', description: 'Calendar events, meetings, work sessions, and planning preferences.',
    tables: ['meetings', 'events', 'event_task_links', 'work_sessions', 'user_schedule_prefs', 'schedule_day_overrides', 'daily_scores'],
  },
  {
    key: 'notes', label: 'Notes & journal', description: 'Task notes, journal entries, links, and attachment metadata.',
    tables: ['task_notes', 'task_note_files', 'notes', 'journal_entries', 'journal_links'],
  },
  {
    key: 'resources', label: 'Resources & research', description: 'Resource records, extracted chunks, research papers, and claims.',
    tables: ['resources', 'resource_chunks', 'resource_logs', 'research_papers', 'research_claims'],
  },
  {
    key: 'ai', label: 'AI & semantic memory', description: 'Embeddings, summaries, extracted facts, proposals, and chat history.',
    tables: ['embeddings', 'embedding_jobs', 'entity_summaries', 'extracted_facts', 'ai_action_proposals', 'chat_sessions', 'chat_messages'],
  },
  {
    key: 'organization', label: 'Topics & organization', description: 'Topics, aliases, tags, memberships, and suggestion history.',
    tables: ['topics', 'topic_aliases', 'topic_memberships', 'tags', 'entity_tags', 'entity_aliases', 'suggestion_runs'],
  },
  {
    key: 'agents', label: 'Agent activity', description: 'Agent run history and event logs.',
    tables: ['agent_runs', 'agent_events'],
  },
];

export function groupFeatureUsage(tables: TableUsage[]) {
  const claimed = new Set(FEATURE_TABLES.flatMap(feature => feature.tables));
  const groups = FEATURE_TABLES.map(feature => {
    const matching = tables.filter(table => feature.tables.includes(table.table));
    return {
      key: feature.key,
      label: feature.label,
      description: feature.description,
      bytes: matching.reduce((sum, table) => sum + table.totalBytes, 0),
      estimatedRows: matching.reduce((sum, table) => sum + table.estimatedRows, 0),
      tables: matching.map(table => table.table),
    };
  });
  const other = tables.filter(table => !claimed.has(table.table));
  if (other.length) {
    groups.push({
      key: 'system', label: 'System & migrations', description: 'Internal or uncategorized database tables.',
      bytes: other.reduce((sum, table) => sum + table.totalBytes, 0),
      estimatedRows: other.reduce((sum, table) => sum + table.estimatedRows, 0),
      tables: other.map(table => table.table),
    });
  }
  return groups.sort((a, b) => b.bytes - a.bytes);
}

async function directoryUsage(root: string): Promise<{ bytes: number; files: number; available: boolean }> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, available: false };
  }

  let bytes = 0;
  let files = 0;
  await Promise.all(entries.map(async entry => {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      const nested = await directoryUsage(fullPath);
      bytes += nested.bytes;
      files += nested.files;
      return;
    }
    if (!entry.isFile()) return;
    try {
      const stat = await fs.stat(fullPath);
      bytes += stat.size;
      files += 1;
    } catch { /* A file can disappear while the directory is being sampled. */ }
  }));
  return { bytes, files, available: true };
}

let lastCpuSample: { usage: NodeJS.CpuUsage; at: bigint } | null = null;

function sampleCpu(): number | null {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const previous = lastCpuSample;
  lastCpuSample = { usage, at: now };
  if (!previous) return null;
  const wallMicros = Number(now - previous.at) / 1_000;
  if (wallMicros <= 0) return null;
  const usedMicros = (usage.user - previous.usage.user) + (usage.system - previous.usage.system);
  return Math.max(0, Math.min(100, (usedMicros / wallMicros / Math.max(1, os.cpus().length)) * 100));
}

type TableStatRow = {
  table_name: string;
  total_bytes: string;
  data_bytes: string;
  index_bytes: string;
  estimated_rows: string;
  dead_rows: string;
};

export async function collectUsageMetrics() {
  const [databaseResult, tableResult, queueResult, uploads, vault, backups] = await Promise.all([
    query<{ database_name: string; bytes: string }>(
      'SELECT current_database() AS database_name, pg_database_size(current_database())::bigint::text AS bytes',
    ),
    query<TableStatRow>(
      `SELECT relname AS table_name,
              pg_total_relation_size(relid)::bigint::text AS total_bytes,
              pg_relation_size(relid)::bigint::text AS data_bytes,
              (pg_total_relation_size(relid) - pg_relation_size(relid))::bigint::text AS index_bytes,
              n_live_tup::bigint::text AS estimated_rows,
              n_dead_tup::bigint::text AS dead_rows
       FROM pg_stat_user_tables
       WHERE schemaname = 'public'
       ORDER BY pg_total_relation_size(relid) DESC`,
    ),
    query<{ status: string; count: string }>('SELECT status, COUNT(*)::bigint::text AS count FROM embedding_jobs GROUP BY status'),
    directoryUsage(path.resolve(process.cwd(), 'server', 'uploads')),
    directoryUsage(getObsidianVaultDir()),
    directoryUsage(path.resolve(process.cwd(), 'backups')),
  ]);

  const tables: TableUsage[] = tableResult.rows.map(row => ({
    table: row.table_name,
    totalBytes: Number(row.total_bytes),
    dataBytes: Number(row.data_bytes),
    indexBytes: Number(row.index_bytes),
    estimatedRows: Number(row.estimated_rows),
    deadRows: Number(row.dead_rows),
  }));
  const memory = process.memoryUsage();
  const systemTotal = os.totalmem();
  const systemFree = os.freemem();
  const pool = getPool();

  return {
    sampledAt: new Date().toISOString(),
    process: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      cpuPercent: sampleCpu(),
      uptimeSeconds: process.uptime(),
      pid: process.pid,
    },
    system: {
      totalMemoryBytes: systemTotal,
      freeMemoryBytes: systemFree,
      usedMemoryBytes: systemTotal - systemFree,
      cpuCores: os.cpus().length,
      platform: `${os.type()} ${os.release()}`,
    },
    database: {
      name: databaseResult.rows[0]?.database_name ?? 'unknown',
      bytes: Number(databaseResult.rows[0]?.bytes ?? 0),
      connections: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      tables,
      features: groupFeatureUsage(tables),
    },
    files: { uploads, obsidianVault: vault, backups },
    background: {
      embeddingJobs: Object.fromEntries(queueResult.rows.map(row => [row.status, Number(row.count)])),
    },
  };
}
