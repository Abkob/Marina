import type { DBNote, NoteType } from '../schema';
import { apiFetch, apiPost, apiPatch, apiDelete, ApiError } from '../../utils/apiFetch';

const API = '/api';

export async function getNotes(_type?: NoteType): Promise<DBNote[]> {
  return apiFetch<DBNote[]>(`${API}/notes`);
}

export async function getNoteById(noteId: string): Promise<DBNote | undefined> {
  try {
    return await apiFetch<DBNote>(`${API}/notes/${noteId}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

export async function createNote(
  data: Omit<DBNote, 'id' | 'created_at' | 'updated_at'>
): Promise<string> {
  const { id } = await apiPost<{ id: string }>(`${API}/notes`, data);
  return id;
}

export async function updateNoteContent(noteId: string, content: string): Promise<void> {
  await apiPatch(`${API}/notes/${noteId}`, { content });
}

export async function setNoteCompleted(noteId: string, completed: boolean, content?: string): Promise<void> {
  await apiPatch(`${API}/notes/${noteId}`, { completed, ...(content !== undefined ? { content } : {}) });
}

export async function updateNote(
  noteId: string,
  updates: Partial<Omit<DBNote, 'id' | 'created_at'>>
): Promise<void> {
  await apiPatch(`${API}/notes/${noteId}`, updates);
}

export async function deleteNote(noteId: string): Promise<void> {
  await apiDelete(`${API}/notes/${noteId}`);
}

export async function applyNoteSuggestedAction(noteId: string, _targetGoalId: string): Promise<void> {
  await updateNote(noteId, { suggested_action_applied: true });
}

export async function ignoreNoteSuggestedAction(noteId: string): Promise<void> {
  await updateNote(noteId, { suggested_action_ignored: true });
}

export async function linkNoteToGoal(noteId: string, goalId: string, confidence: number): Promise<void> {
  await apiPost(`${API}/edges`, {
    source_id: noteId, source_type: 'note',
    target_id: goalId, target_type: 'goal',
    relationship: 'mentioned_in',
    metadata: JSON.stringify({ confidence, via: 'OO_classification' }),
  });
}

export async function recordNoteTaskExtraction(noteId: string, taskId: string): Promise<void> {
  await apiPost(`${API}/edges`, {
    source_id: noteId, source_type: 'note',
    target_id: taskId, target_type: 'task',
    relationship: 'extracted_to',
    metadata: null,
  });
}
