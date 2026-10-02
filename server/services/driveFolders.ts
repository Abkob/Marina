import type pg from 'pg';
import { activeGoalSql, activeTaskSql } from '../utils/archiveVisibility.js';
import { DRIVE_FOLDER_MIME, driveError, driveRequest, generateDriveId } from './googleDriveClient.js';

export type ResourceTarget = { attach_to_id?: string; attach_to_type?: 'goal' | 'task' };
export type FolderEntity = { id: string; title: string; type: 'goal' | 'milestone' | 'task' | 'library' };

/** Resolve IDs in SQL; names are display text, never directory identity. */
export async function resourceFolderPath(client: Pick<pg.PoolClient, 'query'>, target: ResourceTarget): Promise<FolderEntity[]> {
  if (!target.attach_to_id && !target.attach_to_type) return [{ id: 'library', title: 'Library', type: 'library' }];
  if (!target.attach_to_id || !target.attach_to_type) throw driveError('Choose a goal or task for this resource.');
  const path: FolderEntity[] = [];
  let goalId = target.attach_to_type === 'goal' ? target.attach_to_id : null;
  let milestoneId: string | null = null;
  if (target.attach_to_type === 'task') {
    let id: string | null = target.attach_to_id;
    const seen = new Set<string>();
    while (id) {
      if (seen.has(id) || seen.size >= 48) throw driveError('The task hierarchy contains a cycle or is too deep. Correct it before uploading.', 409);
      seen.add(id);
      const task = (await client.query<{ id: string; title: string; goal_id: string | null; milestone_id: string | null; parent_task_id: string | null }>(
        `SELECT t.id,t.title,t.goal_id,t.milestone_id,t.parent_task_id FROM tasks t WHERE t.id=$1 AND ${activeTaskSql('t.id')}`, [id])).rows[0];
      if (!task) throw driveError('The selected task or one of its parents is unavailable.', 404);
      path.unshift({ id: task.id, title: task.title, type: 'task' });
      goalId ??= task.goal_id; milestoneId ??= task.milestone_id;
      id = task.parent_task_id;
    }
  }
  if (milestoneId) {
    const milestone = (await client.query<{ id: string; title: string; goal_id: string }>('SELECT id,title,goal_id FROM goal_milestones WHERE id=$1', [milestoneId])).rows[0];
    if (!milestone || (goalId && milestone.goal_id !== goalId)) throw driveError('The task goal and milestone no longer agree.', 409);
    goalId ??= milestone.goal_id;
    path.unshift({ id: milestone.id, title: milestone.title, type: 'milestone' });
  }
  if (goalId) {
    const goal = (await client.query<{ id: string; title: string }>(`SELECT g.id,g.title FROM goals g WHERE g.id=$1 AND ${activeGoalSql('g.id')}`, [goalId])).rows[0];
    if (!goal) throw driveError('The selected goal is unavailable.', 404);
    path.unshift({ ...goal, type: 'goal' });
  }
  return path;
}

export async function ensureResourceFolder(client: pg.PoolClient, token: string, rootId: string, target: ResourceTarget) {
  const path = await resourceFolderPath(client, target);
  let parent = rootId;
  for (const entity of path) {
    // Serialize concurrent uploads and recover a create whose response was lost.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`marina-drive-folder:${parent}:${entity.type}:${entity.id}`]);
    const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const params = new URLSearchParams({ q: `trashed=false and mimeType='${DRIVE_FOLDER_MIME}' and '${escape(parent)}' in parents and appProperties has { key='marinaEntityType' and value='${entity.type}' } and appProperties has { key='marinaEntityId' and value='${escape(entity.id)}' }`, fields: 'files(id)', pageSize: '2' });
    const found = await (await driveRequest(token, `files?${params}`)).json() as { files: { id: string }[] };
    if (found.files.length > 1) throw driveError('Duplicate Marina folders exist for this goal or task. Resolve them before uploading.', 409);
    let id = found.files[0]?.id;
    if (!id) {
      id = await generateDriveId(token);
      await driveRequest(token, 'files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: entity.title.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180) || entity.type,
          mimeType: DRIVE_FOLDER_MIME, parents: [parent], appProperties: { marinaEntityType: entity.type, marinaEntityId: entity.id } }) });
    }
    parent = id;
  }
  return { folder_id: parent, folder_url: `https://drive.google.com/drive/folders/${parent}`, path };
}
