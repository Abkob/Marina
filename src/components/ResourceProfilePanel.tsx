import { ModalFrame } from './ModalFrame';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { BookOpen, Database, ExternalLink, FileText, Globe, Lightbulb, Link, Package, Plus, Trash2, Users, X } from 'lucide-react';
import {
  getResource, updateResource,
  getResourceReferences, getResourceLogs,
  addResourceLog, deleteResourceLog,
} from '../db/queries/resources';
import { useAppStore } from '../store/useAppStore';
import type { DBResource, ResourceLog, ResourceType } from '../db/schema';
import type { ResourceReference } from '../db/queries/resources';
import { ResourceTypeIcon } from './ResourceMentionPicker';

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

const SOURCE_TYPE_LABEL: Record<string, string> = {
  note:      'Journal',
  task:      'Task',
  goal:      'Goal',
  braindump: 'Brain Dump',
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

type TimelineItem =
  | { kind: 'log';  data: ResourceLog }
  | { kind: 'ref';  data: ResourceReference };

// ─── Editable field ──────────────────────────────────────────────────────────
function EditableField({
  label, value, placeholder, multiline = false,
  onSave,
}: {
  label: string; value: string; placeholder: string;
  multiline?: boolean; onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  const props = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => { if (draft !== value) onSave(draft); },
    placeholder,
    className: 'w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 outline-none focus:border-[#4648d4] focus:bg-white transition-colors resize-none',
  };

  return (
    <div>
      <label className="block font-mono text-[9px] uppercase tracking-widest text-gray-400 mb-1">{label}</label>
      {multiline
        ? <textarea {...props} rows={3} />
        : <input {...props as React.InputHTMLAttributes<HTMLInputElement>} />
      }
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────
export function ResourceProfilePanel({
  resourceId,
  onClose,
}: {
  resourceId: string;
  onClose: () => void;
}) {
  const [resource, setResource]     = useState<DBResource | null>(null);
  const [logs, setLogs]             = useState<ResourceLog[]>([]);
  const [refs, setRefs]             = useState<ResourceReference[]>([]);
  const [logDraft, setLogDraft]     = useState('');
  const [busy, setBusy]             = useState(false);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const { showConfirm, triggerToast } = useAppStore();

  const load = () => {
    getResource(resourceId).then(setResource).catch(() => {});
    getResourceLogs(resourceId).then(setLogs).catch(() => {});
    getResourceReferences(resourceId).then(setRefs).catch(() => {});
  };

  useEffect(() => { load(); const id = setInterval(load, 2000); return () => clearInterval(id); }, [resourceId]);

  const save = async (patch: Partial<Pick<DBResource, 'title' | 'type' | 'url' | 'info'>>) => {
    if (!resource) return;
    await updateResource(resource.id, patch);
    setResource(prev => prev ? { ...prev, ...patch } : prev);
  };

  const handleAddLog = async () => {
    const content = logDraft.trim();
    if (!content) return;
    setBusy(true);
    try {
      await addResourceLog(resourceId, content, false);
      setLogDraft('');
      load();
    } finally { setBusy(false); }
  };

  const handleDeleteLog = (log: ResourceLog) => {
    showConfirm('Remove this log entry?', async () => {
      await deleteResourceLog(resourceId, log.id);
      setLogs(prev => prev.filter(l => l.id !== log.id));
    });
  };

  // Merge and sort timeline
  const timeline: TimelineItem[] = [
    ...logs.map(l => ({ kind: 'log' as const, data: l })),
    ...refs.map(r => ({ kind: 'ref' as const, data: r })),
  ].sort((a, b) => b.data.created_at.localeCompare(a.data.created_at));

  if (!resource) return null;

  return (
<ModalFrame titleId="resource-panel-title" onClose={onClose} overlayClassName="bg-black/20 md:!justify-end md:!p-0" className="mobile-sheet flex h-full w-full max-w-[500px] flex-col border-l border-gray-200 bg-white shadow-2xl"><h2 id="resource-panel-title" className="sr-only">Resource details</h2>
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
          <div className="mt-0.5">
            <ResourceTypeIcon type={resource.type} size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <input
              value={resource.title}
              onChange={e => setResource(prev => prev ? { ...prev, title: e.target.value } : prev)}
              onBlur={e => { if (e.target.value.trim() !== resource.title) save({ title: e.target.value.trim() }); }}
              className="w-full text-base font-bold text-gray-900 outline-none bg-transparent border-b border-transparent hover:border-gray-200 focus:border-[#4648d4] transition-colors pb-0.5"
            />
            <div className="mt-1 flex items-center gap-2">
              <select
                value={resource.type}
                onChange={e => save({ type: e.target.value as ResourceType })}
                className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-gray-500 outline-none cursor-pointer hover:bg-gray-200 transition-colors"
              >
                {RESOURCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <span className="font-mono text-[9px] text-gray-300">
                Added {new Date(resource.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          </div>
          <button aria-label="Close resource details" onClick={onClose} className="shrink-0 rounded-lg p-1.5 text-gray-300 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Meta fields */}
          <div className="space-y-3 border-b border-gray-100 px-5 py-4">
            <EditableField
              label="URL / Link"
              value={resource.url ?? ''}
              placeholder="https://…"
              onSave={url => save({ url: url || null })}
            />
            {resource.url?.startsWith('http') && (
              <a
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-[#4648d4] hover:underline"
              >
                <ExternalLink size={10} /> Open link
              </a>
            )}
            <EditableField
              label="Notes / Info"
              value={resource.info ?? ''}
              placeholder="Author, year, description, DOI…"
              multiline
              onSave={info => save({ info })}
            />
          </div>

          {/* Log entry composer */}
          <div className="border-b border-gray-100 px-5 py-4">
            <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Add to log</p>
            <textarea
              ref={logRef}
              value={logDraft}
              onChange={e => setLogDraft(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleAddLog(); }}
              rows={3}
              placeholder="New insight, update, or note about this resource… (Ctrl+Enter)"
              className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 outline-none focus:border-[#4648d4] focus:bg-white transition-colors"
            />
            <div className="mt-2 flex justify-end">
              <button
                onClick={handleAddLog}
                disabled={!logDraft.trim() || busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#4648d4] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={11} />
                Log
              </button>
            </div>
          </div>

          {/* Timeline */}
          <div className="px-5 py-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-gray-400">
                Activity &amp; References
              </p>
              <span className="font-mono text-[9px] text-gray-300">{timeline.length} events</span>
            </div>

            {timeline.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-300 italic">
                No activity yet — log a note or reference this resource somewhere.
              </p>
            ) : (
              <div className="relative">
                {/* Vertical guide line */}
                <div className="absolute left-[7px] top-0 bottom-0 w-px bg-gray-100" />
                <div className="space-y-1">
                  <AnimatePresence initial={false}>
                    {timeline.map(item => (
                      <motion.div
                        key={item.kind === 'log' ? `log-${item.data.id}` : `ref-${(item.data as ResourceReference).edge_id}`}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="group/item relative flex gap-3 pl-5"
                      >
                        {/* Dot */}
                        <div className={`absolute left-0 top-2 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-white ${
                          item.kind === 'log' ? 'bg-[#4648d4]' : 'bg-emerald-400'
                        }`} />

                        <div className="min-w-0 flex-1 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5 mb-1">
                          {item.kind === 'log' ? (
                            <>
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-xs text-gray-800 leading-relaxed whitespace-pre-wrap">{item.data.content}</p>
                                <button
                                  onClick={() => handleDeleteLog(item.data as ResourceLog)}
                                  className="shrink-0 opacity-0 group-hover/item:opacity-100 text-gray-300 hover:text-red-400 transition-all"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </div>
                              <p className="mt-1.5 font-mono text-[9px] text-gray-300">{fmtDate(item.data.created_at)}</p>
                            </>
                          ) : (() => {
                            const ref = item.data as ResourceReference;
                            return (
                              <>
                                <div className="flex items-center gap-1.5 mb-1">
                                  <span className="rounded-full bg-emerald-50 px-2 py-px font-mono text-[8px] uppercase tracking-wide text-emerald-600">
                                    {SOURCE_TYPE_LABEL[ref.source_type] ?? ref.source_type}
                                  </span>
                                  {ref.parent_title && (
                                    <span className="text-[10px] text-gray-500 truncate">in <span className="font-semibold">{ref.parent_title}</span></span>
                                  )}
                                  {!ref.parent_title && ref.source_title && (
                                    <span className="text-[10px] font-semibold text-gray-600 truncate">{ref.source_title}</span>
                                  )}
                                </div>
                                {ref.source_content && (
                                  <p className="text-[11px] text-gray-500 leading-relaxed line-clamp-3 italic">"{ref.source_content}{ref.source_content.length >= 200 ? '…' : ''}"</p>
                                )}
                                <p className="mt-1.5 font-mono text-[9px] text-gray-300">{fmtDate(ref.created_at)}</p>
                              </>
                            );
                          })()}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </div>
        </div>
    </ModalFrame>
  );
}
