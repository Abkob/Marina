import type { DBResource } from '../db/schema';
import { uploadMime, UPLOAD_TYPES } from '../../shared/uploadPolicy';

export function resourceMime(resource: Pick<DBResource, 'mime_type' | 'original_name' | 'file_path' | 'url'>): string {
  if (resource.mime_type) return resource.mime_type;
  const source = resource.original_name || resource.file_path || resource.url || '';
  let filename = source;
  try { filename = new URL(source).pathname; } catch { filename = source.split('?')[0].split('#')[0]; }
  return uploadMime(filename) ?? 'application/octet-stream';
}
export function canPreviewResource(resource: DBResource): boolean {
  return Boolean(resource.url) && resource.file_validation !== 'pending' && resource.file_validation !== 'invalid'
    && Object.values(UPLOAD_TYPES).includes(resourceMime(resource));
}

export type ResourceProcessing = {
  status: 'not_started' | 'queued' | 'running' | 'ready' | 'no_text' | 'unsupported' | 'failed';
  stage: 'extract' | 'embed' | null; error?: string | null; error_code?: string | null;
  chunks: number; embedded: number; worker_available?: boolean;
  total_pages?: number; visual_pages_ready?: number; visual_pages_failed?: number;
  mime_type?: string;
};
export const isProcessing = (status?: string) => status === 'queued' || status === 'running';
export function processingLabel(state: ResourceProcessing): string {
  if (state.worker_available === false && isProcessing(state.status)) return 'File saved. Background processing needs to be connected.';
  if (state.error) return state.error + (state.status === 'queued' ? ' Retrying automatically.' : '');
  if (state.total_pages && isProcessing(state.status) && state.stage === 'extract') return `Analyzing pages · ${state.visual_pages_ready ?? 0}/${state.total_pages} complete${state.visual_pages_failed ? ` · ${state.visual_pages_failed} with incomplete visual evidence` : ''}`;
  if (state.status === 'queued') return state.stage === 'embed' ? 'File saved · waiting to index' : 'File saved · waiting to check';
  if (state.status === 'running') return state.stage === 'embed' ? 'Preparing search index…' : 'Checking file and extracting text…';
  if (state.status === 'ready') return `Ready for search and citations${state.visual_pages_failed ? ` · ${state.visual_pages_failed} pages have incomplete visual evidence; re-index to retry` : ''}`;
  if (state.status === 'not_started') return 'File saved · not indexed yet';
  return 'File saved · no searchable text';
}
