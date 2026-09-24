import { useRef, useState, useEffect } from 'react';
import {
  ExternalLink, Eye, Plus, Search, Trash2, X, Upload,
  Link2, ArrowUpDown, BookOpen, CheckCircle2, Clock, Archive,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { FileViewerModal } from '../components/FileViewerModal';
import { ResourceTypeIcon } from '../components/ResourceMentionPicker';
import { ResourceProfilePage } from './ResourceProfilePage';
import {
  createStandaloneResource, deleteResource,
  updateResource, nextReadState, uploadResourceFile,
} from '../db/queries/resources';
import { useAllResources, useInvalidate } from '../api/hooks';
import { useAppStore } from '../store/useAppStore';
import type { DBResource, ResourceReadState, ResourceType } from '../db/schema';
import { parseTags } from '../db/schema';

// ─── Constants ────────────────────────────────────────────────────────────────
const RESOURCE_TYPES: { value: ResourceType; label: string }[] = [
  { value: 'paper',    label: 'Paper'    },
  { value: 'person',   label: 'Person'   },
  { value: 'dataset',  label: 'Dataset'  },
  { value: 'concept',  label: 'Concept'  },
  { value: 'link',     label: 'Link/URL' },
  { value: 'document', label: 'Document' },
  { value: 'figma',    label: 'Figma'    },
  { value: 'other',    label: 'Other'    },
];

const READ_STATE_CFG: Record<ResourceReadState, { bg: string; text: string; dot: string; label: string }> = {
  Unread:  { bg: 'bg-gray-100',      text: 'text-gray-500',    dot: 'bg-gray-400',    label: 'Unread'  },
  Reading: { bg: 'bg-[#EEF2FF]',     text: 'text-[#4648d4]',   dot: 'bg-[#4648d4]',  label: 'Reading' },
  Done:    { bg: 'bg-emerald-50',     text: 'text-emerald-600', dot: 'bg-emerald-400', label: 'Done'    },
  Shelved: { bg: 'bg-amber-50',       text: 'text-amber-600',   dot: 'bg-amber-400',   label: 'Shelved' },
};

const TYPE_ACCENTS: Record<string, string> = {
  paper: '#4648d4', person: '#10B981', dataset: '#f59e0b',
  concept: '#8b5cf6', link: '#06b6d4', document: '#6b7280',
  figma: '#f97316', other: '#9ca3af',
};

const VIEWABLE = new Set(['pdf','png','jpg','jpeg','gif','webp','svg','md','txt']);
function extOf(url: string) {
  try { return new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''; }
  catch { return url.split('.').pop()?.toLowerCase() ?? ''; }
}
function mimeOf(url: string) {
  const e = extOf(url);
  const m: Record<string,string> = { pdf:'application/pdf', png:'image/png', jpg:'image/jpeg',
    jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', md:'text/markdown', txt:'text/plain' };
  return m[e] ?? 'application/octet-stream';
}

type SortKey = 'newest' | 'oldest' | 'az' | 'type' | 'readstate';

// ─── Read state badge ─────────────────────────────────────────────────────────
function ReadStateBadge({ state, onClick }: { state: ResourceReadState; onClick: (e: React.MouseEvent) => void }) {
  const cfg = READ_STATE_CFG[state];
  return (
    <button
      onClick={onClick}
      aria-label={`Read state: ${cfg.label}. Click to cycle`}
      title="Click to cycle: Unread → Reading → Done → Shelved"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wide transition-all hover:opacity-75 shrink-0 ${cfg.bg} ${cfg.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </button>
  );
}

// ─── Stats strip ─────────────────────────────────────────────────────────────
function StatsStrip({ resources }: { resources: DBResource[] }) {
  const total   = resources.length;
  const unread  = resources.filter(r => r.read_state === 'Unread').length;
  const reading = resources.filter(r => r.read_state === 'Reading').length;
  const done    = resources.filter(r => r.read_state === 'Done').length;
  const shelved = resources.filter(r => r.read_state === 'Shelved').length;

  // Type breakdown
  const byCounts = RESOURCE_TYPES
    .map(t => ({ type: t.value, label: t.label, count: resources.filter(r => r.type === t.value).length }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);

  if (total === 0) return null;

  return (
    <div className="mobile-resource-stats mb-6 space-y-3">
      {/* Read state row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { icon: BookOpen,      label: 'Unread',  value: unread,  color: 'text-gray-500',    bg: 'bg-gray-50' },
          { icon: Clock,         label: 'Reading', value: reading, color: 'text-[#4648d4]',   bg: 'bg-[#EEF2FF]' },
          { icon: CheckCircle2,  label: 'Done',    value: done,    color: 'text-emerald-600', bg: 'bg-emerald-50' },
          { icon: Archive,       label: 'Shelved', value: shelved, color: 'text-amber-600',   bg: 'bg-amber-50' },
        ].map(({ icon: Icon, label, value, color, bg }) => (
          <div key={label} className={`rounded-xl px-4 py-3 border border-gray-100 ${bg} flex items-center gap-3`}>
            <Icon size={14} className={`${color} shrink-0`} />
            <div>
              <p className={`font-headline text-xl font-bold ${color}`}>{value}</p>
              <p className="font-mono text-[9px] text-gray-400 uppercase tracking-widest">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Type distribution */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        {byCounts.map(({ type, label, count }) => (
          <span key={type} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: TYPE_ACCENTS[type] }} />
            <span className="font-mono text-[10px] text-gray-500">{label}: <span className="font-bold text-gray-700">{count}</span></span>
          </span>
        ))}
        <span className="font-mono text-[10px] text-gray-400 ml-auto">{total} total</span>
      </div>
    </div>
  );
}

// ─── Resource card ────────────────────────────────────────────────────────────
function ResourceCard({
  resource, onOpen, onView, onDelete, onReadStateChange,
}: {
  resource: DBResource;
  onOpen: (r: DBResource) => void;
  onView: (r: DBResource) => void;
  onDelete: (r: DBResource) => void;
  onReadStateChange: (r: DBResource, state: ResourceReadState) => void;
}) {
  const canView = resource.url ? VIEWABLE.has(extOf(resource.url)) : false;
  const isLink  = resource.url?.startsWith('http');
  const tags    = parseTags(resource.tags_json ?? '[]').slice(0, 3);
  const accent  = TYPE_ACCENTS[resource.type] ?? '#9ca3af';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      onClick={() => onOpen(resource)}
      role="button"
      tabIndex={0}
      aria-label={`Open resource ${resource.title}`}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(resource);
        }
      }}
      className="group/card relative flex cursor-pointer flex-col rounded-xl border border-gray-150 bg-white shadow-sm hover:border-[#4648d4]/30 hover:shadow-md transition-all overflow-hidden focus:outline-none focus:ring-2 focus:ring-[#4648d4]/30"
    >
      {/* Accent bar */}
      <div className="h-[3px] w-full shrink-0" style={{ background: accent }} />

      <div className="flex items-start gap-3 p-4 flex-1 min-w-0">
        <div className="mt-0.5 shrink-0">
          <ResourceTypeIcon type={resource.type} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="text-sm font-semibold text-gray-900 leading-tight group-hover/card:text-[#4648d4] transition-colors line-clamp-2">
              {resource.title}
            </p>
            <div onClick={e => e.stopPropagation()}>
              <ReadStateBadge
                state={resource.read_state ?? 'Unread'}
                onClick={(e) => { e.stopPropagation(); onReadStateChange(resource, nextReadState(resource.read_state ?? 'Unread')); }}
              />
            </div>
          </div>

          {resource.info && (
            <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed mb-1.5">{resource.info}</p>
          )}
          {resource.url && (
            <p className="font-mono text-[9px] text-gray-300 truncate mb-2">{resource.url}</p>
          )}

          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="rounded-full border border-gray-100 px-2 py-0.5 font-mono text-[8px] uppercase tracking-wide text-gray-400">
              {resource.type}
            </span>
            {tags.map(tag => (
              <span key={tag} className="rounded-full bg-[#EEF2FF] px-2 py-0.5 font-mono text-[8px] text-[#4648d4]">
                {tag}
              </span>
            ))}
            <span className="ml-auto text-[9px] text-gray-300 font-mono shrink-0">
              {new Date(resource.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          </div>
        </div>
      </div>

      {/* Hover action strip */}
      <div
        className="flex items-center gap-1 px-4 py-2 border-t border-gray-50 opacity-0 group-hover/card:opacity-100 transition-opacity"
        onClick={e => e.stopPropagation()}
      >
        {canView && resource.url && (
          <button onClick={() => onView(resource)}
            aria-label={`Preview ${resource.title}`}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-mono text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors">
            <Eye size={11} /> Preview
          </button>
        )}
        {isLink && resource.url && (
          <a href={resource.url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-mono text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            onClick={e => e.stopPropagation()}>
            <ExternalLink size={11} /> Open
          </a>
        )}
        <button onClick={() => onDelete(resource)}
          aria-label={`Delete resource ${resource.title}`}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-mono text-gray-300 hover:bg-red-50 hover:text-red-400 transition-colors">
          <Trash2 size={11} /> Delete
        </button>
      </div>
    </motion.div>
  );
}

// ─── Add panel ────────────────────────────────────────────────────────────────
function AddPanel({ onAdded }: { onAdded: () => void }) {
  const [tab, setTab]         = useState<'link' | 'upload'>('link');
  const [title, setTitle]     = useState('');
  const [type, setType]       = useState<ResourceType>('paper');
  const [url, setUrl]         = useState('');
  const [info, setInfo]       = useState('');
  const [busy, setBusy]       = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const { triggerToast } = useAppStore();

  useEffect(() => { if (tab === 'link') titleRef.current?.focus(); }, [tab]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createStandaloneResource({ title: title.trim(), type, url: url.trim() || null, info: info.trim() });
      setTitle(''); setUrl(''); setInfo('');
      triggerToast('Resource added.', 'success');
      onAdded();
      titleRef.current?.focus();
    } finally { setBusy(false); }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      await Promise.all(Array.from(files).map(f => uploadResourceFile(f)));
      triggerToast(`${files.length} file${files.length > 1 ? 's' : ''} uploaded.`, 'success');
      onAdded();
    } catch { triggerToast('Upload failed.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-[#4648d4]/20 bg-[#EEF2FF]/30 p-5 mb-6">
      {/* Tabs */}
      <div className="flex items-center gap-0.5 mb-5 bg-white/60 rounded-lg p-0.5 w-fit border border-gray-200">
        {[
          { key: 'link' as const,   icon: Link2,   label: 'Link / Text' },
          { key: 'upload' as const, icon: Upload,  label: 'Upload File' },
        ].map(({ key, icon: Icon, label }) => (
          <button key={key} onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-[10px] font-bold uppercase tracking-wide transition-all ${
              tab === key ? 'bg-[#4648d4] text-white shadow-sm' : 'text-gray-400 hover:text-gray-700'
            }`}>
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>

      {tab === 'link' && (
        <form onSubmit={handleSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="resource-title-input" className="sr-only">Resource name</label>
              <input id="resource-title-input" ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                placeholder="Name *"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-[#4648d4] transition-colors" />
            </div>
            <div>
              <label htmlFor="resource-type-input" className="sr-only">Resource type</label>
              <select id="resource-type-input" value={type} onChange={e => setType(e.target.value as ResourceType)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-[#4648d4] transition-colors">
                {RESOURCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="resource-url-input" className="sr-only">Resource URL</label>
              <input id="resource-url-input" value={url} onChange={e => setUrl(e.target.value)} placeholder="URL (optional)"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-[#4648d4] transition-colors" />
            </div>
            <div className="sm:col-span-2">
              <input aria-label="Resource notes" value={info} onChange={e => setInfo(e.target.value)} placeholder="Notes — author, DOI, year… (optional)"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-[#4648d4] transition-colors" />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={!title.trim() || busy}
              aria-label="Add resource"
              className="inline-flex items-center gap-2 rounded-lg bg-[#4648d4] px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity">
              <Plus size={13} /> {busy ? 'Saving…' : 'Add Resource'}
            </button>
          </div>
        </form>
      )}

      {tab === 'upload' && (
        <div>
          <input ref={fileRef} type="file" multiple className="hidden" aria-label="Upload resource files"
            onChange={e => handleUpload(e.currentTarget.files)} />
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); handleUpload(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Upload resource files"
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
            className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed py-12 cursor-pointer transition-all ${
              dragging
                ? 'border-[#4648d4] bg-[#EEF2FF]/60'
                : 'border-gray-200 bg-white hover:border-[#4648d4]/40 hover:bg-[#EEF2FF]/20'
            }`}
          >
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${dragging ? 'bg-[#4648d4]' : 'bg-gray-100'}`}>
              <Upload size={18} className={dragging ? 'text-white' : 'text-gray-400'} />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-700">
                {busy ? 'Uploading…' : dragging ? 'Drop to upload' : 'Drop files here or click to browse'}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-gray-400">
                PDF, images, documents, any file · max 50 MB each
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────
export function ResourcesView() {
  const [search, setSearch]         = useState('');
  const [typeFilter, setTypeFilter] = useState<ResourceType | 'all'>('all');
  const [readFilter, setReadFilter] = useState<ResourceReadState | 'all'>('all');
  const [sort, setSort]             = useState<SortKey>('newest');
  const [showAdd, setShowAdd]       = useState(false);
  const [viewing, setViewing]       = useState<DBResource | null>(null);
  const { showConfirm, triggerToast, focusedResourceId, setFocusedResourceId } = useAppStore();
  const { data: resources = [] } = useAllResources();
  const invalidate = useInvalidate();

  // All hooks must run unconditionally — early return comes after

  if (focusedResourceId) return <ResourceProfilePage resourceId={focusedResourceId} />;

  const handleDelete = (r: DBResource) => {
    showConfirm(`Remove "${r.title}" from the library?`, async () => {
      await deleteResource(r.id);
      invalidate.resources();
      triggerToast('Resource removed.', 'info');
    });
  };

  const handleReadStateChange = async (r: DBResource, next: ResourceReadState) => {
    await updateResource(r.id, { read_state: next });
    invalidate.resources();
  };

  const usedTypes = Array.from(new Set(resources.map(r => r.type)));

  const filtered = resources
    .filter(r => {
      const q = search.toLowerCase();
      const matchSearch = !q || r.title.toLowerCase().includes(q) || (r.info ?? '').toLowerCase().includes(q);
      const matchType   = typeFilter === 'all' || r.type === typeFilter;
      const matchRead   = readFilter === 'all' || r.read_state === readFilter;
      return matchSearch && matchType && matchRead;
    })
    .sort((a, b) => {
      if (sort === 'newest')    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (sort === 'oldest')    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (sort === 'az')        return a.title.localeCompare(b.title);
      if (sort === 'type')      return a.type.localeCompare(b.type) || a.title.localeCompare(b.title);
      if (sort === 'readstate') {
        const order: ResourceReadState[] = ['Reading', 'Unread', 'Done', 'Shelved'];
        return order.indexOf(a.read_state ?? 'Unread') - order.indexOf(b.read_state ?? 'Unread');
      }
      return 0;
    });

  return (
    <>
      <div className="mobile-resources max-w-[960px] mx-auto px-4 md:px-10 py-6 animate-fade-in">
        {/* Header */}
        <div className="mobile-toolbar flex items-end justify-between gap-4 mb-6">
          <div>
            <h2 className="font-headline text-2xl font-bold text-black mb-1">Resource Library</h2>
            <p className="text-sm text-gray-500">
              Your files, links and reading, in one place.
            </p>
          </div>
          <button
            onClick={() => setShowAdd(v => !v)}
            aria-expanded={showAdd}
            aria-label={showAdd ? 'Close add resource panel' : 'Open add resource panel'}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-mono text-xs font-bold uppercase tracking-widest transition-all shadow-sm ${
              showAdd
                ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                : 'bg-[#4648d4] text-white hover:opacity-90'
            }`}
          >
            {showAdd ? <X size={13} /> : <Plus size={13} />}
            {showAdd ? 'Cancel' : 'Add Resource'}
          </button>
        </div>

        {/* Stats strip */}
        <StatsStrip resources={resources} />

        {/* Add panel (collapsible) */}
        <AnimatePresence>
          {showAdd && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <AddPanel onAdded={() => { invalidate.resources(); setShowAdd(false); }} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Search + sort + filter row */}
        {resources.length > 0 && (
          <div className="mb-5 space-y-3">
            <div className="flex items-center gap-2">
              {/* Search */}
              <div className="relative flex-1 min-w-0">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
                <input aria-label="Search resources" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search by name or notes…"
                  className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm text-gray-800 outline-none focus:border-[#4648d4] transition-colors" />
                {search && (
                  <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-300 hover:bg-gray-50 hover:text-gray-500" aria-label="Clear resource search">
                    <X size={12} />
                  </button>
                )}
              </div>
              {/* Sort */}
              <div className="relative shrink-0">
                <ArrowUpDown size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
                <select aria-label="Sort resources" value={sort} onChange={e => setSort(e.target.value as SortKey)}
                  className="appearance-none rounded-lg border border-gray-200 bg-white pl-7 pr-6 py-2 text-[11px] font-mono text-gray-600 outline-none focus:border-[#4648d4] transition-colors cursor-pointer">
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="az">A → Z</option>
                  <option value="type">By Type</option>
                  <option value="readstate">By Status</option>
                </select>
              </div>
            </div>

            {/* Type filter pills */}
            <div className="mobile-filter-strip flex flex-wrap gap-1.5">
              <button onClick={() => setTypeFilter('all')}
                aria-pressed={typeFilter === 'all'}
                className={`rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-wide transition-colors ${
                  typeFilter === 'all' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}>
                All ({resources.length})
              </button>
              {usedTypes.map(t => (
                <button key={t} onClick={() => setTypeFilter(t === typeFilter ? 'all' : t)}
                  aria-pressed={typeFilter === t}
                  className={`rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-wide transition-colors flex items-center gap-1 ${
                    typeFilter === t ? 'text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                  style={typeFilter === t ? { background: TYPE_ACCENTS[t] } : {}}>
                  {typeFilter === t && <span className="w-1.5 h-1.5 rounded-full bg-white/40 shrink-0" />}
                  {t}
                </button>
              ))}

              {/* Read state quick filter */}
              <div className="ml-auto flex gap-1">
                {(['Unread', 'Reading', 'Done'] as const).map(rs => {
                  const cfg = READ_STATE_CFG[rs];
                  const active = readFilter === rs;
                  return (
                    <button key={rs} onClick={() => setReadFilter(active ? 'all' : rs)}
                      aria-pressed={active}
                      className={`rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-wide transition-all flex items-center gap-1 ${
                        active ? `${cfg.bg} ${cfg.text} font-bold` : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                      }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${active ? cfg.dot : 'bg-gray-300'}`} />
                      {rs}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Grid */}
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 py-16 text-center">
            <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
              <Upload size={20} className="text-gray-300" />
            </div>
            <p className="text-sm font-semibold text-gray-500">
              {resources.length === 0 ? 'Library is empty — add a resource or upload a file above' : 'No resources match your filters'}
            </p>
            {resources.length === 0 && (
              <button onClick={() => setShowAdd(true)}
                aria-label="Add first resource"
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#4648d4] px-4 py-2 text-xs font-mono font-bold uppercase tracking-widest text-white hover:opacity-90 transition-opacity">
                <Plus size={12} /> Add first resource
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <AnimatePresence initial={false}>
              {filtered.map(r => (
                <ResourceCard
                  key={r.id}
                  resource={r}
                  onOpen={r => setFocusedResourceId(r.id)}
                  onView={setViewing}
                  onDelete={handleDelete}
                  onReadStateChange={handleReadStateChange}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      <AnimatePresence>
        {viewing && viewing.url && (
          <FileViewerModal
            key={viewing.id}
            src={viewing.url}
            name={viewing.title}
            mimeType={mimeOf(viewing.url)}
            onClose={() => setViewing(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
