import { useRef, useState } from 'react';
import { Check, RotateCcw, Upload } from 'lucide-react';
import { uploadResourceFile } from '../db/queries/resources';
import { ApiError } from '../utils/apiFetch';
import { ResourceContextPicker, selectionTarget, type ResourceSelection } from './ResourceContextPicker';
import { UPLOAD_ACCEPT, validateUploadFile, type UploadProgress } from '../utils/blobUpload';

type UploadItem = {
  id: string;
  file: File;
  phase: UploadProgress['phase'] | 'queued' | 'saved' | 'failed';
  percentage?: number;
  error?: string;
  retryable?: boolean;
  target?: { attach_to_id: string; attach_to_type: 'goal' | 'task' };
};

function statusLabel(item: UploadItem): string {
  if (item.phase === 'uploading') return item.percentage == null ? 'Uploading…'
    : item.percentage >= 100 ? 'Finishing upload…' : `Uploading ${Math.floor(item.percentage)}%`;
  return { queued: 'Waiting', preparing: 'Preparing…', saving: 'Saving to library…', saved: 'Saved', failed: 'Failed' }[item.phase];
}

function uploadError(error: unknown, saving: boolean): { error: string; retryable: boolean } {
  if (error instanceof ApiError && error.status === 401) {
    return { error: 'Your session expired. Sign in again, then retry.', retryable: true };
  }
  // Retrying reuses the server's upload ID, including when success was lost.
  if (saving && (!(error instanceof ApiError) || error.status >= 500)) {
    return { error: 'Could not confirm the save. Retry to check the same upload safely.', retryable: true };
  }
  if (error instanceof Error && /timeout|abort/i.test(error.name)) {
    return { error: 'The upload timed out. Check your connection and retry.', retryable: true };
  }
  if (error instanceof TypeError) {
    return { error: 'The connection was interrupted. Check your connection and retry.', retryable: true };
  }
  const message = error instanceof Error ? error.message : '';
  return {
    error: message && !/<[a-z][\s\S]*>/i.test(message) ? message.slice(0, 500) : 'Upload failed. Please try again.',
    retryable: true,
  };
}

export function ResourceUploadPanel({ onUploaded, onBusyChange }: {
  onUploaded: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [destination, setDestination] = useState<ResourceSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const running = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const update = (id: string, patch: Partial<UploadItem>) =>
    setItems(current => current.map(item => item.id === id ? { ...item, ...patch } : item));

  async function runUploads(pending: UploadItem[]) {
    if (running.current || !pending.length) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    try {
      // One file at a time keeps multipart uploads from competing for bandwidth.
      // Every file settles independently, so a failure cannot hide later saves.
      for (const item of pending) {
        let saving = false;
        update(item.id, { phase: 'preparing', error: undefined, percentage: undefined });
        try {
          await uploadResourceFile(item.file, progress => {
            saving = progress.phase === 'saving';
            update(item.id, progress);
          }, item.target);
          update(item.id, { phase: 'saved', percentage: 100 });
          onUploaded();
        } catch (error) {
          update(item.id, { phase: 'failed', ...uploadError(error, saving) });
          if (saving) onUploaded();
        }
      }
    } finally {
      running.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  function selectFiles(files: FileList | null) {
    if (running.current || !files?.length) return;
    const selected: UploadItem[] = Array.from(files, file => {
      const item: UploadItem = { id: crypto.randomUUID(), file, phase: 'queued', target: selectionTarget(destination) };
      try { validateUploadFile(file); }
      catch (error) { return { ...item, phase: 'failed', error: (error as Error).message, retryable: false }; }
      return item;
    });
    setItems(selected);
    void runUploads(selected.filter(item => item.phase === 'queued'));
  }

  const saved = items.filter(item => item.phase === 'saved').length;
  const failed = items.filter(item => item.phase === 'failed').length;

  return (
    <div>
      <ResourceContextPicker value={destination} onChange={setDestination} disabled={busy} uploads />
      <p className="mb-3 text-xs text-slate-400">Files are saved under Marina → {destination ? `${destination.kind} / ${destination.title}` : 'Library'}.</p>
      <input ref={fileRef} type="file" multiple accept={UPLOAD_ACCEPT} disabled={busy}
        className="hidden" aria-label="Choose resource files"
        onChange={event => { selectFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
      <button type="button" disabled={busy} aria-label="Upload resource files"
        aria-describedby="resource-upload-formats"
        onClick={() => fileRef.current?.click()}
        onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); selectFiles(event.dataTransfer.files); }}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-7 sm:py-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4648d4]/40 disabled:cursor-wait ${dragging ? 'border-[#4648d4] bg-[#EEF2FF]/60' : 'border-gray-200 bg-white hover:border-[#4648d4]/40'}`}>
        <Upload size={18} className="text-gray-400" aria-hidden="true" />
        <span className="text-sm font-medium text-gray-700">
          {busy ? 'Uploading files…' : dragging ? 'Drop to upload' : <><span className="sm:hidden">Choose files</span><span className="hidden sm:inline">Drop files here or browse</span></>}
        </span>
        <span id="resource-upload-formats" className="text-[11px] leading-relaxed text-gray-500">
          PDF, TXT, MD, CSV · PNG, JPG, GIF, WebP<br />Up to 50 MB per file
        </span>
      </button>
      {items.length > 0 && (
        <div className="mt-3 space-y-2">
          <p role="status" className="text-xs text-gray-500">
            {busy ? `${saved} of ${items.length} saved · Keep this page open` : `${saved} saved${failed ? ` · ${failed} failed` : ''}`}
          </p>
          <ul className="max-h-72 space-y-2 overflow-y-auto" aria-label="File upload progress">
            {items.map(item => (
              <li key={item.id} className="rounded-lg border border-gray-100 bg-white px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-700" title={item.file.name}>{item.file.name}</span>
                  <span className="shrink-0 text-[11px] text-gray-500">{statusLabel(item)}</span>
                  {item.phase === 'saved' && <Check size={14} className="shrink-0 text-emerald-600" aria-hidden="true" />}
                  {item.phase === 'failed' && item.retryable && (
                    <button type="button" disabled={busy} onClick={() => void runUploads([item])}
                      aria-label={`Retry ${item.file.name}`} title="Retry upload"
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4648d4]/40 disabled:opacity-40">
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
                {item.phase === 'uploading' && <progress aria-label={`Uploading ${item.file.name}`} max={100} value={item.percentage} className="mt-2 block h-1 w-full accent-[#4648d4]" />}
                {item.error && <p role="alert" className="mt-1 break-words text-xs leading-relaxed text-red-600">{item.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
