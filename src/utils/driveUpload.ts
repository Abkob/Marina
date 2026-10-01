import { apiFetch, ApiError } from './apiFetch';
import type { UploadProgressListener } from './blobUpload';
type Position = { offset: number; complete: boolean; chunk_bytes?: number };
const CHUNK_BYTES = 2 * 1024 * 1024;
export async function uploadDriveChunks(file: File, id: string, progress?: UploadProgressListener) {
  const base = `/api/uploads/resources/${encodeURIComponent(id)}`;
  const position = () => apiFetch<Position>(`${base}/drive-session`, { method: 'POST', signal: AbortSignal.timeout(90_000) });
  const valid = (value: Position) => {
    if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > file.size || (value.complete && value.offset !== file.size)) throw new Error('Drive returned an invalid upload position.');
    return value;
  };
  let current = valid(await position()); let failures = 0; let stalled = 0;
  while (current.offset < file.size && !current.complete) {
    progress?.({ phase: 'uploading', percentage: current.offset / file.size * 100 });
    const start = current.offset;
    try {
      current = valid(await apiFetch<Position>(`${base}/drive-chunk?offset=${start}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(start, Math.min(start + CHUNK_BYTES, file.size)),
        signal: AbortSignal.timeout(90_000),
      }));
      failures = 0;
    } catch (error) {
      if (error instanceof ApiError && ![404, 409, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      if (++failures > 3) throw error;
      // Ask Drive which bytes arrived before retransmitting after a lost response.
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** failures));
      current = valid(await position());
    }
    stalled = current.offset > start ? 0 : stalled + 1;
    if (stalled > 3) throw new Error('Drive upload is not progressing. Check your connection and retry.');
  }
  progress?.({ phase: 'uploading', percentage: 100 });
}
