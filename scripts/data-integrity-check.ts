import 'dotenv/config';
import fs from 'fs';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[data-check] DATABASE_URL is required');
  process.exit(1);
}

const tables = [
  'goals', 'tasks', 'goal_milestones', 'meetings', 'events', 'notes',
  'resources', 'task_note_files', 'journal_entries', 'edges', 'embeddings',
  'embedding_jobs', 'schema_migrations',
] as const;

const blobUrl = /^https:\/\/[a-z0-9-]+\.private\.blob\.vercel-storage\.com\//i;
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 8_000 });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const { rows: extensionRows } = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'vector') ORDER BY extname",
    );
    const extensions = extensionRows.map(row => row.extname);

    const { rows: relationRows } = await client.query<{ name: string; present: boolean }>(
      `SELECT name, to_regclass('public.' || name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS name`,
      [tables],
    );
    const missingTables = relationRows.filter(row => !row.present).map(row => row.name);
    if (missingTables.length) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ ok: false, missing_tables: missingTables, extensions }, null, 2));
      process.exitCode = 1;
    } else {
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const result = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
        counts[table] = result.rows[0]?.count ?? 0;
      }

      const { rows: orphanRows } = await client.query<{
        tasks_without_goal: number;
        subtasks_without_parent: number;
        note_files_without_note: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM tasks t
             WHERE t.goal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.id=t.goal_id)) AS tasks_without_goal,
          (SELECT COUNT(*)::int FROM tasks t
             WHERE t.parent_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id=t.parent_task_id)) AS subtasks_without_parent,
          (SELECT COUNT(*)::int FROM task_note_files f
             WHERE NOT EXISTS (SELECT 1 FROM task_notes n WHERE n.id=f.note_id)) AS note_files_without_note
      `);

      const { rows: fileRows } = await client.query<{ kind: string; id: string; file_path: string }>(`
        SELECT 'resource' AS kind, id, file_path FROM resources WHERE file_path IS NOT NULL
        UNION ALL
        SELECT 'task_note_file' AS kind, id, file_path FROM task_note_files WHERE file_path IS NOT NULL
      `);
      const missingLocalFiles = fileRows
        .filter(row => !blobUrl.test(row.file_path) && !fs.existsSync(row.file_path))
        .map(row => ({ kind: row.kind, id: row.id }));
      const localFiles = fileRows.filter(row => !blobUrl.test(row.file_path)).length;
      const privateBlobs = fileRows.length - localFiles;
      const orphans = orphanRows[0] ?? { tasks_without_goal: 0, subtasks_without_parent: 0, note_files_without_note: 0 };
      const orphanTotal = Object.values(orphans).reduce((sum, value) => sum + Number(value), 0);
      const requiredExtensionsPresent = extensions.includes('pgcrypto') && extensions.includes('vector');
      const ok = orphanTotal === 0 && missingLocalFiles.length === 0 && requiredExtensionsPresent;

      await client.query('COMMIT');
      console.log(JSON.stringify({
        ok,
        read_only: true,
        extensions,
        required_extensions_present: requiredExtensionsPresent,
        counts,
        orphans,
        storage: {
          local_files: localFiles,
          private_blobs: privateBlobs,
          missing_local_files: missingLocalFiles,
        },
      }, null, 2));
      if (!ok) process.exitCode = 1;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
} catch (err) {
  console.error('[data-check] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
