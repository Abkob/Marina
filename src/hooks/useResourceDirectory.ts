import { useEffect, useState } from 'react';
import { apiPost } from '../utils/apiFetch';
import { selectionTarget, type ResourceSelection } from '../components/ResourceContextPicker';

export function useResourceDirectory(selection: ResourceSelection | null) {
  const [status, setStatus] = useState<{ message: string; url?: string; error?: boolean }>({ message: '' });
  useEffect(() => {
    let cancelled = false;
    if (!selection) { setStatus({ message: '' }); return; }
    setStatus({ message: 'Checking selected resources…' });
    void (async () => {
      try {
        if (selection.kind === 'resource') {
          await apiPost('/api/google-drive/sync', { resource_id: selection.id });
          if (!cancelled) setStatus({ message: 'Source checked. New or changed content may still be indexing.' });
          return;
        }
        let cursor: string | undefined; let checked = 0; let skipped = 0; let failures = 0;
        do {
          const page = await apiPost<{ checked: number; skipped: number; errors: string[]; next_cursor: string | null; folder_url: string }>('/api/google-drive/refresh-directory', {
            ...selectionTarget(selection), include_subtasks: selection.include_subtasks, cursor,
          });
          if (cancelled) return;
          checked += page.checked; skipped += page.skipped; failures += page.errors.length; cursor = page.next_cursor ?? undefined;
          setStatus({ url: page.folder_url, error: failures > 0,
            message: `${cursor ? 'Checking folder' : 'Folder checked'} · ${checked} files${skipped ? ` · ${skipped} unsupported` : ''}${failures ? ` · ${failures} failed; reselect to retry` : ''}${cursor ? '…' : '. Changed files are queued for indexing.'}` });
        } while (cursor && !cancelled);
      } catch (error) { if (!cancelled) setStatus({ message: error instanceof Error ? error.message : 'Could not refresh this folder.', error: true }); }
    })();
    return () => { cancelled = true; };
  }, [selection?.id, selection?.kind, selection?.include_subtasks]);
  return status;
}
