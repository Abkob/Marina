import type { DBTaskNoteFile } from '../schema';
import { apiFetch, apiDelete } from '../../utils/apiFetch';
import { normalizedUploadType, uploadToPrivateBlob } from '../../utils/blobUpload';

const API = '/api/task-note-files';

export async function addNoteFile(noteId: string, file: File): Promise<string> {
  const blob = await uploadToPrivateBlob(file, 'note');
  if (blob) {
    const { ids } = await apiFetch<{ ids: string[] }>(`${API}/register-blob/${noteId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blob: { url: blob.url, pathname: blob.pathname },
        original_name: file.name,
        mime_type: normalizedUploadType(file),
        size: file.size,
      }),
    });
    return ids[0];
  }
  const form = new FormData();
  form.append('files', file);
  // multipart upload — must not set Content-Type manually (browser sets boundary)
  const { ids } = await apiFetch<{ ids: string[] }>(`${API}/${noteId}`, { method: 'POST', body: form });
  return ids[0];
}

export async function getNoteFilesForNote(noteId: string): Promise<DBTaskNoteFile[]> {
  const rows = await apiFetch<Array<Omit<DBTaskNoteFile, 'blob'> & { file_path?: string }>>(`${API}/${noteId}`);
  // Return with a synthetic blob placeholder — actual data streamed via file_url
  return rows.map(row => ({
    ...row,
    blob: null as unknown as Blob,
    file_url: `/api/task-note-files/data/${row.id}`,
  }));
}

export async function deleteNoteFile(fileId: string): Promise<void> {
  await apiDelete(`${API}/file/${fileId}`);
}

export async function deleteNoteFilesForNotes(_noteIds: string[]): Promise<void> {
  // Server handles cascade deletion
}
