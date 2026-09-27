import type { DBResource, ResourceLog, ResourceReadState, ResourceStats, ResourceType } from '../schema';
import { apiFetch, apiPost, apiPatch, apiDelete } from '../../utils/apiFetch';
import { normalizedUploadType, uploadToPrivateBlob } from '../../utils/blobUpload';

export type MentionSourceType = 'note' | 'task' | 'braindump' | 'goal';

const API = '/api';

// ── Collection ────────────────────────────────────────────────────────────────

export async function getResourcesForGoal(goalId: string): Promise<DBResource[]> {
  return apiFetch<DBResource[]>(`${API}/resources?goal_id=${goalId}`);
}

export async function getAllResources(): Promise<DBResource[]> {
  return apiFetch<DBResource[]>(`${API}/resources`);
}

export async function getResourcesForTask(taskId: string): Promise<DBResource[]> {
  return apiFetch<DBResource[]>(`${API}/resources?task_id=${taskId}`);
}

export async function createResource(
  data: { title: string; url: string | null; type: ResourceType; info: string },
  goalId: string,
  taskId?: string,
): Promise<string> {
  const { id } = await apiPost<{ id: string }>(`${API}/resources`, {
    ...data,
    attach_to_id: taskId ?? goalId,
    attach_to_type: taskId ? 'task' : 'goal',
  });
  return id;
}

export async function uploadResource(file: File, goalId: string, taskId?: string): Promise<string> {
  const blob = await uploadToPrivateBlob(file, 'resource');
  if (blob) {
    const { id } = await apiPost<{ id: string }>(`${API}/resources/register-blob`, {
      blob: { url: blob.url, pathname: blob.pathname },
      original_name: file.name,
      mime_type: normalizedUploadType(file),
      size: file.size,
      attach_to_id: taskId ?? goalId,
      attach_to_type: taskId ? 'task' : 'goal',
    });
    return id;
  }
  const form = new FormData();
  form.append('file', file);
  form.append('attach_to_id', taskId ?? goalId);
  form.append('attach_to_type', taskId ? 'task' : 'goal');
  const { id } = await apiFetch<{ id: string }>(`${API}/resources/upload`, { method: 'POST', body: form });
  return id;
}

export async function detachResource(resourceId: string, targetType: 'task' | 'goal', targetId: string): Promise<void> {
  await apiDelete(`${API}/resources/${resourceId}/attachments/${targetType}/${targetId}`);
}

export async function getAllResourcesGrouped(
  goalId: string,
  taskIds: string[],
): Promise<{ goalResources: DBResource[]; taskResources: Record<string, DBResource[]> }> {
  const [goalResources, ...taskResourceArrays] = await Promise.all([
    getResourcesForGoal(goalId),
    ...taskIds.map(id => getResourcesForTask(id).then(res => [id, res] as const)),
  ]);
  const taskResources: Record<string, DBResource[]> = {};
  for (const [taskId, res] of taskResourceArrays as [string, DBResource[]][]) {
    if (res.length) taskResources[taskId] = res;
  }
  return { goalResources: goalResources as DBResource[], taskResources };
}

export async function deleteResource(resourceId: string): Promise<void> {
  await apiDelete(`${API}/resources/${resourceId}`);
}

export function detectResourceType(input: string): ResourceType {
  const isLink = input.startsWith('http://') || input.startsWith('https://');
  if (isLink && input.toLowerCase().includes('figma')) return 'figma';
  if (isLink) return 'link';
  return 'document';
}

export async function createStandaloneResource(data: {
  title: string;
  type: ResourceType;
  url?: string | null;
  info?: string;
}): Promise<string> {
  const { id } = await apiPost<{ id: string }>(`${API}/resources`, {
    title: data.title,
    type: data.type,
    url: data.url ?? null,
    info: data.info ?? '',
  });
  return id;
}

// ── @mention edges ────────────────────────────────────────────────────────────

export async function getMentionsForItem(
  sourceType: MentionSourceType,
  sourceId: string,
): Promise<(DBResource & { edge_id: string })[]> {
  return apiFetch<(DBResource & { edge_id: string })[]>(
    `${API}/resources/mentions?source_id=${sourceId}&source_type=${sourceType}`,
  );
}

export async function addMention(
  sourceType: MentionSourceType,
  sourceId: string,
  resourceId: string,
): Promise<string> {
  const { id } = await apiPost<{ id: string }>(`${API}/resources/mentions`, {
    source_id: sourceId, source_type: sourceType, resource_id: resourceId,
  });
  return id;
}

export async function removeMention(edgeId: string): Promise<void> {
  await apiDelete(`${API}/resources/mentions/${edgeId}`);
}

// ── Single resource ───────────────────────────────────────────────────────────

export async function getResource(id: string): Promise<DBResource> {
  return apiFetch<DBResource>(`${API}/resources/${id}`);
}

export async function updateResource(
  id: string,
  patch: Partial<Pick<DBResource, 'title' | 'type' | 'url' | 'info' | 'read_state' | 'next_action' | 'tags_json'>>,
): Promise<void> {
  await apiPatch(`${API}/resources/${id}`, patch);
}

// ── Resource profile data ─────────────────────────────────────────────────────

export interface ResourceReference {
  edge_id: string;
  source_id: string;
  source_type: string;
  source_title: string | null;
  source_content: string | null;
  parent_title: string | null;
  created_at: string;
}

export async function getResourceReferences(resourceId: string): Promise<ResourceReference[]> {
  return apiFetch<ResourceReference[]>(`${API}/resources/${resourceId}/references`);
}

export async function getResourceStats(resourceId: string): Promise<ResourceStats> {
  return apiFetch<ResourceStats>(`${API}/resources/${resourceId}/stats`);
}

export async function getResourceLogs(resourceId: string): Promise<ResourceLog[]> {
  return apiFetch<ResourceLog[]>(`${API}/resources/${resourceId}/logs`);
}

export async function addResourceLog(resourceId: string, content: string, isInsight: boolean): Promise<string> {
  const { id } = await apiPost<{ id: string }>(`${API}/resources/${resourceId}/logs`, {
    content, is_insight: isInsight,
  });
  return id;
}

export async function deleteResourceLog(resourceId: string, logId: string): Promise<void> {
  await apiDelete(`${API}/resources/${resourceId}/logs/${logId}`);
}

// ── Resource graph data ───────────────────────────────────────────────────────

export interface ResourceGraphNode {
  id: string;
  label: string;
  nodeType: 'resource' | 'task' | 'goal';
  meta?: { subtype?: string; completed?: boolean; status?: string; goal_id?: string; actual_minutes?: number };
}
export interface ResourceGraphEdge {
  source: string;
  target: string;
  rel: 'mentions' | 'contains' | 'co_cited';
}
export interface ResourceGraphData {
  nodes: ResourceGraphNode[];
  edges: ResourceGraphEdge[];
}

export async function getResourceGraph(resourceId: string): Promise<ResourceGraphData> {
  return apiFetch<ResourceGraphData>(`${API}/resources/${resourceId}/graph`);
}

// ── File upload ───────────────────────────────────────────────────────────────

export async function uploadResourceFile(file: File): Promise<string> {
  const blob = await uploadToPrivateBlob(file, 'resource');
  if (blob) {
    const { id } = await apiPost<{ id: string }>(`${API}/resources/register-blob`, {
      blob: { url: blob.url, pathname: blob.pathname },
      original_name: file.name,
      mime_type: normalizedUploadType(file),
      size: file.size,
    });
    return id;
  }
  const fd = new FormData();
  fd.append('file', file);
  // multipart upload — must not set Content-Type manually (browser sets boundary)
  const { id } = await apiFetch<{ id: string }>(`${API}/resources/upload`, { method: 'POST', body: fd });
  return id;
}

// ── Read state cycling ────────────────────────────────────────────────────────

const READ_STATE_CYCLE: ResourceReadState[] = ['Unread', 'Reading', 'Done', 'Shelved'];

export function nextReadState(current: ResourceReadState): ResourceReadState {
  const idx = READ_STATE_CYCLE.indexOf(current);
  return READ_STATE_CYCLE[(idx + 1) % READ_STATE_CYCLE.length];
}
