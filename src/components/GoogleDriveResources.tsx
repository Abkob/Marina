import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Cloud, Folder, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import { apiFetch, apiPost } from '../utils/apiFetch';
import { resetUploadCapabilities } from '../utils/blobUpload';

type DriveStatus = { configured: boolean; connected: boolean; account_email: string | null; folder_url: string | null; last_error: string | null };
type DriveEntry = { id: string; name: string; folder: boolean; supported: boolean; resource_id?: string; size?: string };
type DrivePage = { files: DriveEntry[]; next_page_token?: string };
const subtleButton = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-2 text-xs text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:opacity-40';

export function GoogleDriveResources({ onImported }: { onImported: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pages, setPages] = useState<DriveEntry[]>([]);
  const [pageToken, setPageToken] = useState<string>();
  const status = useQuery<DriveStatus>({ queryKey: ['google-drive-status'], queryFn: () => apiFetch('/api/google-drive/status'), retry: false });
  const folder = folders.at(-1)?.id;
  const listing = useQuery<DrivePage>({ queryKey: ['google-drive-files', submittedSearch, folder], enabled: open && Boolean(status.data?.connected), retry: false,
    queryFn: () => apiFetch(`/api/google-drive/files?${new URLSearchParams({ ...(submittedSearch ? { search: submittedSearch } : {}), ...(folder ? { folder } : {}) })}`) });
  useEffect(() => { setPages(listing.data?.files ?? []); setPageToken(listing.data?.next_page_token); setSelected(new Set()); }, [listing.data, folder, submittedSearch]);
  useEffect(() => { resetUploadCapabilities(); }, [status.data?.connected]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('google') === 'error') { setError(params.get('google_message') ?? 'Google connection failed.'); setOpen(true); }
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (err) { setError(err instanceof Error ? err.message : 'Drive request failed. Please retry.'); }
    finally { setBusy(false); }
  }
  async function connect() {
    const result = await apiPost<{ authorization_url: string }>('/api/google-drive/connect', { return_to: window.location.pathname + window.location.search + window.location.hash });
    const url = new URL(result.authorization_url);
    if (url.origin !== 'https://accounts.google.com') throw new Error('Invalid Google authorization link.');
    window.location.assign(url.href);
  }
  async function importSelected() {
    let saved = 0; const failures: string[] = [];
    for (const id of selected) {
      try {
        const result = await apiPost<{ id: string }>('/api/google-drive/import', { file_id: id });
        saved++;
        setPages(current => current.map(file => file.id === id ? { ...file, resource_id: result.id } : file));
        setSelected(current => { const next = new Set(current); next.delete(id); return next; });
        setNotice(`${saved} added · Preparing for AI…`); onImported();
      } catch (err) { failures.push(`${pages.find(file => file.id === id)?.name ?? 'A file'}${err instanceof Error ? `: ${err.message}` : ''}`); }
    }
    await qc.invalidateQueries({ queryKey: ['google-drive-files'] });
    if (failures.length) setError(`Could not import ${failures.join(', ')}. Select these files and retry. Saved resources are preserved.`);
  }
  async function more() {
    if (!pageToken) return;
    const next = await apiFetch<DrivePage>(`/api/google-drive/files?${new URLSearchParams({ page: pageToken, ...(submittedSearch ? { search: submittedSearch } : {}), ...(folder ? { folder } : {}) })}`);
    setPages(current => [...current, ...next.files.filter(file => !current.some(prior => prior.id === file.id))]); setPageToken(next.next_page_token);
  }
  return <section className="mb-4 rounded-xl border border-gray-100 bg-white" aria-label="Google Drive resources">
    <div className="flex min-w-0 items-center gap-1 px-2">
      <button type="button" className={`${subtleButton} min-w-0 flex-1 justify-start`} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <Cloud size={15} className="shrink-0" aria-hidden="true" /><span className="shrink-0">Google Drive</span>
        <span className="hidden min-w-0 truncate text-gray-400 sm:inline">{status.data?.connected ? status.data.account_email : 'Store and import your documents'}</span>
        {open ? <ChevronDown size={13} className="ml-auto shrink-0" /> : <ChevronRight size={13} className="ml-auto shrink-0" />}
      </button>
      {status.data?.connected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-label="Drive connected" />}
      {status.isError && <button type="button" className={subtleButton} aria-label="Retry Drive status" onClick={() => status.refetch()}><RefreshCw size={13} /></button>}
    </div>
    {open && <div className="border-t border-gray-100 px-3 pb-3 sm:px-4">
      {status.isError && <p role="alert" className="py-2 text-xs text-red-600">Could not check Google Drive. Retry using the refresh button.</p>}
      {status.isPending && <p role="status" className="py-3 text-xs text-gray-500">Checking connection…</p>}
      {status.data && !status.data.connected && <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <p className="max-w-lg text-xs leading-relaxed text-gray-500">{status.data.configured ? 'Connect once. New uploads go to Marina Resources in your Drive. Choose existing files below to prepare them for AI.' : 'Google Drive connection is awaiting server setup.'}</p>
        <button type="button" className={subtleButton} disabled={busy || !status.data.configured} onClick={() => void action(connect)}>Connect Drive</button>
      </div>}
      {status.data?.connected && <>
        <div className="flex flex-wrap items-center gap-1 py-1">
          <p className="min-w-0 flex-1 truncate text-xs text-gray-500">{status.data.account_email}</p>
          {status.data.folder_url && <a className={subtleButton} href={status.data.folder_url} target="_blank" rel="noreferrer" aria-label="Open Marina Resources in Google Drive"><ExternalLink size={14} /></a>}
          <button type="button" className={subtleButton} disabled={busy} aria-label="Sync Google Drive resources" title="Check for changed files" onClick={() => void action(async () => {
            const result = await apiPost<{ checked: number }>('/api/google-drive/sync', {});
            setNotice(`Checked ${result.checked} resources. Changed documents will be indexed again.`); onImported(); await status.refetch();
          })}><RefreshCw size={14} /><span className="hidden sm:inline">Sync</span></button>
          <button type="button" className={subtleButton} disabled={busy} onClick={() => void action(connect)}>Reconnect</button>
        </div>
        <p className="mb-2 text-[11px] leading-relaxed text-gray-500">Only the Marina folder is browsed. Uploads use the chosen goal or task directory. Files added there in Drive are discovered when that context is selected in chat. Removing a resource keeps its Drive file.</p>
        <form className="flex gap-1" onSubmit={event => { event.preventDefault(); setSubmittedSearch(search); }}>
          <input aria-label="Search Google Drive files" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a document in Drive…" maxLength={200}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-200 px-3 text-sm outline-none focus:border-indigo-400" />
          <button type="submit" className={subtleButton}>Search</button>
        </form>
        <nav aria-label="Drive folder" className="flex flex-wrap items-center text-xs text-gray-500">
          <button type="button" className={subtleButton} disabled={busy} onClick={() => setFolders([])}>Marina</button>
          {folders.map((item, index) => <button type="button" key={item.id} className={`${subtleButton} max-w-40`} disabled={busy} onClick={() => setFolders(current => current.slice(0,index+1))}><ChevronRight size={11} /><span className="truncate">{item.name}</span></button>)}
        </nav>
        {listing.isFetching && <p role="status" className="py-2 text-xs text-gray-500">Loading Drive files…</p>}
        {listing.isError && <p role="alert" className="text-xs text-red-600">{listing.error.message} <button className={subtleButton} onClick={() => listing.refetch()}>Retry</button></p>}
        {!listing.isFetching && !listing.isError && !pages.length && <p className="py-3 text-xs text-gray-500">No files found.</p>}
        <ul className="max-h-72 overflow-y-auto" aria-label="Google Drive files">
          {pages.map(file => <li key={file.id} className="border-b border-gray-50 last:border-0">
            {file.folder ? <button type="button" className={`${subtleButton} w-full justify-start`} disabled={busy} onClick={() => setFolders(current => [...current, { id: file.id, name: file.name }])}>
              <Folder size={14} className="shrink-0" /><span className="truncate">{file.name}</span><ChevronRight size={12} className="ml-auto" />
            </button> : <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 px-2 text-xs">
              <input type="checkbox" aria-label={`Import ${file.name}`} disabled={busy || !file.supported || Boolean(file.resource_id)} checked={selected.has(file.id)} className="h-4 w-4 shrink-0 accent-indigo-600"
                onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })} />
              <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
              <span className="shrink-0 text-[10px] text-gray-400">{file.resource_id ? 'Added' : !file.supported ? 'Unsupported' : ''}</span>
            </label>}
          </li>)}
        </ul>
        <div className="flex items-center justify-between gap-2">
          {pageToken ? <button type="button" className={subtleButton} disabled={busy} onClick={() => void action(more)}>More files</button> : <span />}
          {selected.size > 0 && <button type="button" className={subtleButton} disabled={busy} onClick={() => void action(importSelected)}>{busy && <Loader2 size={13} className="animate-spin" />}Add {selected.size} to library</button>}
        </div>
        {status.data.last_error && <p role="alert" className="py-2 text-xs text-amber-700">{status.data.last_error}</p>}
      </>}
      {error && <p role="alert" className="break-words py-2 text-xs text-red-600">{error}</p>}
      {notice && <p role="status" className="py-2 text-xs text-gray-500">{notice}</p>}
    </div>}
  </section>;
}
