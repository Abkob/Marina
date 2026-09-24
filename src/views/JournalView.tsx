import { usePersistentDraft } from '../hooks/usePersistentDraft';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Circle, RefreshCw, Trash2, Link2, X, Check } from 'lucide-react';
import { useJournalEntries, useJournalLinks, useInvalidate, useSearch, type DBJournalEntry, type DBJournalLink } from '../api/hooks';
import { useAppStore } from '../store/useAppStore';
import { apiFetch, apiPost, apiDelete } from '../utils/apiFetch';
import { ProposalsPanel } from '../components/ProposalsPanel';
import { EntityTopicChips } from '../components/EntityTopicChips';

const MOOD_EMOJI: Record<string, string> = {
  great: '😄', good: '🙂', neutral: '😐', bad: '😕', terrible: '😞',
};

function StatusDot({ status }: { status: DBJournalEntry['ingestion_status'] }) {
  const color =
    status === 'processed'    ? 'bg-green-400' :
    status === 'failed' || status === 'needs_review' ? 'bg-red-400' :
    'bg-amber-400 animate-pulse';
  const label =
    status === 'processed'   ? 'Processed' :
    status === 'failed'      ? 'Failed' :
    status === 'needs_review' ? 'Needs review' :
    'Processing…';
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      <span className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">{label}</span>
    </span>
  );
}

// Entity types the manual-link endpoint accepts (server MANUAL_LINK_TARGETS)
const LINKABLE_TYPES = new Set(['goal', 'task', 'milestone', 'resource', 'meeting']);

/** Search-and-attach: manually link this entry to any goal/task/resource/etc.
 *  Manual links are authoritative — re-ingestion never removes them. */
function ManualLinkAdder({ entryId, onLinked }: { entryId: string; onLinked: () => void }) {
  const [q, setQ] = useState('');
  const { data } = useSearch(q);
  const { triggerToast } = useAppStore();
  const candidates = (data?.results ?? []).filter(r => LINKABLE_TYPES.has(r.entity_type)).slice(0, 6);

  const link = async (entityType: string, entityId2: string, title: string) => {
    try {
      await apiPost(`/api/journal/${entryId}/links`, { target_type: entityType, target_id: entityId2, relationship: 'mentions' });
      setQ('');
      onLinked();
      triggerToast(`Manually linked to "${title}" — survives re-ingestion.`, 'success');
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    }
  };

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <Link2 size={11} className="text-gray-500 shrink-0" />
        <input
          aria-label="Search entities to link to this journal entry"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Link manually: search goals, tasks, resources…"
          className="flex-1 bg-gray-900/60 border border-gray-800 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>
      {q.trim() && candidates.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {candidates.map(r => (
            <button
              key={`${r.entity_type}-${r.entity_id}`}
              onClick={() => link(r.entity_type, r.entity_id, r.title)}
              aria-label={`Link ${r.title} to journal entry`}
              className="w-full text-left text-[11px] px-2 py-1 rounded hover:bg-gray-800 text-gray-300 flex items-center gap-2"
            >
              <span className="font-mono text-[9px] uppercase text-indigo-400">{r.entity_type}</span>
              <span className="truncate">{r.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EntryLinks({ entryId }: { entryId: string }) {
  const { data: links, refetch } = useJournalLinks(entryId);
  const { triggerToast } = useAppStore();

  const removeLink = async (linkId: string) => {
    try {
      await apiDelete(`/api/journal/${entryId}/links/${linkId}`);
      refetch();
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    }
  };

  return (
    <>
      {!links?.length
        ? <p className="text-xs text-gray-500 italic">No linked entities yet — AI extraction adds them, or link manually below.</p>
        : (
          <div className="overflow-x-auto" role="region" aria-label="Journal linked records" tabIndex={0}><table className="w-full text-[11px] font-mono border-collapse mt-1">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="pb-1 pr-3 font-normal">Type</th>
                <th className="pb-1 pr-3 font-normal">Entity</th>
                <th className="pb-1 pr-3 font-normal">Relationship</th>
                <th className="pb-1 pr-3 font-normal">Confidence</th>
                <th className="pb-1 pr-3 font-normal">Source</th>
                <th className="pb-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {(links as DBJournalLink[]).map(l => (
                <tr key={l.id} className="border-t border-gray-800 group">
                  <td className="py-1 pr-3 text-indigo-300">{l.target_type}</td>
                  <td className="py-1 pr-3 text-gray-300 truncate max-w-[180px]">
                    {l.target_title ?? `${l.target_id.slice(0, 8)}…`}
                  </td>
                  <td className="py-1 pr-3 text-gray-400">{l.relationship}</td>
                  <td className="py-1 pr-3 text-gray-400">{(l.confidence * 100).toFixed(0)}%</td>
                  <td className="py-1 pr-3">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase ${l.created_by === 'manual' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-gray-800 text-gray-500'}`}>
                      {l.created_by ?? 'ai'}
                    </span>
                  </td>
                  <td className="py-1 text-right">
                    <button
                      onClick={() => removeLink(l.id)}
                      title="Remove link"
                      aria-label={`Remove link to ${l.target_title ?? l.target_id}`}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-gray-600 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100 focus:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      <ManualLinkAdder entryId={entryId} onLinked={() => refetch()} />
    </>
  );
}

/** Task candidates the AI extracted FROM this entry — one log can become many
 *  tasks. Each is a durable proposal: nothing exists until you accept it. */
function EntryTaskCandidates({ entryId }: { entryId: string }) {
  const { triggerToast } = useAppStore();
  const { data: proposals = [] } = useQuery<Array<{ id: string; action_type: string; action_payload: string; explanation: string | null; source_id: string | null; status: string }>>({
    queryKey: ['proposals'],
    queryFn: () => apiFetch('/api/ai/proposals'),
  });
  const mine = proposals.filter(p => p.source_id === entryId && p.status === 'pending');

  const decide = async (id: string, verb: 'apply' | 'reject') => {
    try {
      await apiPost(`/api/ai/proposals/${id}/${verb}`, {});
      triggerToast(verb === 'apply' ? 'Task created.' : 'Dismissed — won’t come back.', 'success');
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    }
  };

  if (!mine.length) return null;
  return (
    <div>
      <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1.5">
        Extracted actions <span className="normal-case">— accept to create real tasks</span>
      </p>
      <div className="space-y-1">
        {mine.map(p => {
          let title = p.explanation ?? '';
          try { title = (JSON.parse(p.action_payload) as { title?: string }).title ?? title; } catch { /* ignore */ }
          return (
            <div key={p.id} className="flex items-center gap-2 bg-gray-900/60 border border-gray-800 rounded-lg px-2.5 py-1.5">
              <span className="text-[10px] font-mono text-indigo-400 shrink-0 uppercase">{p.action_type.replace('create_', '+')}</span>
              <span className="flex-1 text-[11px] text-gray-300 truncate">{title}</span>
              <button onClick={() => decide(p.id, 'apply')} className="w-6 h-6 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 flex items-center justify-center" title="Create it" aria-label={`Create extracted action ${title}`}>
                <Check size={11} />
              </button>
              <button onClick={() => decide(p.id, 'reject')} className="w-6 h-6 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center" title="Dismiss (persists)" aria-label={`Dismiss extracted action ${title}`}>
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TagChips({ entry }: { entry: DBJournalEntry }) {
  let manual: string[] = [];
  let ai: string[] = [];
  try { manual = JSON.parse(entry.tags_json || '[]'); } catch { /* ignore */ }
  try { ai = JSON.parse(entry.ai_tags_json || '[]'); } catch { /* ignore */ }
  if (!manual.length && !ai.length) return null;
  return (
    <div>
      <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1.5">Tags <span className="normal-case">(purple = yours · ✦ = AI)</span></p>
      <div className="flex flex-wrap gap-1.5 items-center">
      {manual.map(t => (
        <span key={`m-${t}`} className="text-[10px] font-mono bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 px-1.5 py-0.5 rounded-full" title="Manual tag — never overwritten by AI">
          {t}
        </span>
      ))}
        {ai.filter(t => !manual.includes(t)).map(t => (
          <span key={`a-${t}`} className="text-[10px] font-mono bg-gray-800 text-gray-400 border border-gray-700 px-1.5 py-0.5 rounded-full" title="AI-extracted tag">
            ✦ {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function EntryCard({ entry }: { entry: DBJournalEntry }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();
  const { triggerToast } = useAppStore();

  const snippet = entry.summary ?? entry.raw_text.slice(0, 150);
  const mood = entry.mood ? (MOOD_EMOJI[entry.mood] ?? entry.mood) : null;
  const isTerminalError = entry.ingestion_status === 'failed' || entry.ingestion_status === 'needs_review';

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/journal/${entry.id}/ingest`, { method: 'POST' });
      invalidate.journal();
      triggerToast('Retrying AI ingestion…', 'success');
    } catch {
      triggerToast('Retry failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || !confirm('Delete this journal entry? This will remove all linked facts and work sessions.')) return;
    setBusy(true);
    try {
      await apiFetch(`/api/journal/${entry.id}`, { method: 'DELETE' });
      invalidate.journal();
      triggerToast('Entry deleted', 'success');
    } catch {
      triggerToast('Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-gray-800 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(v => !v);
          }
        }}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} journal entry ${entry.entry_date}`}
        className="w-full cursor-pointer text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-900/30 transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
      >
        <span className="mt-0.5 text-gray-600 shrink-0">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-mono font-bold text-white">{entry.entry_date}</span>
            {mood && <span className="text-base leading-none">{mood}</span>}
            <StatusDot status={entry.ingestion_status} />
          </div>
          <p className="text-sm text-gray-400 leading-relaxed line-clamp-2">{snippet}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2" onClick={e => e.stopPropagation()}>
          {isTerminalError && (
            <button
              onClick={handleRetry}
              disabled={busy}
              title="Retry AI ingestion"
              aria-label="Retry AI ingestion"
              className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-400/10 transition-colors disabled:opacity-40"
            >
              <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={busy}
            title="Delete entry"
            aria-label={`Delete journal entry ${entry.entry_date}`}
            className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-40"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-800 pt-3 space-y-4">
          <div>
            <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1.5">Raw Entry</p>
            <pre className="font-mono text-xs text-gray-300 bg-gray-900/60 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">{entry.raw_text}</pre>
          </div>

          {entry.summary && (
            <div>
              <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1.5">AI Summary</p>
              <p className="text-sm text-gray-300 leading-relaxed">{entry.summary}</p>
            </div>
          )}

          <TagChips entry={entry} />

          <EntryTaskCandidates entryId={entry.id} />

          <div>
            <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1.5">Topics</p>
            <EntityTopicChips entityType="journal_entry" entityId={entry.id} dark />
          </div>

          <div>
            <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1.5">Linked Entities</p>
            <EntryLinks entryId={entry.id} />
          </div>
        </div>
      )}
    </div>
  );
}

export function JournalView() {
  const [text, setText] = usePersistentDraft('journal');
  const [entryDate, setEntryDate] = usePersistentDraft('journal-date');
  const [submitting, setSubmitting] = useState(false);
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('30d');
  const [jumpDate, setJumpDate] = useState('');
  const [search, setSearch] = useState('');
  const { data: entries, isLoading } = useJournalEntries();
  const invalidate = useInvalidate();
  const { triggerToast } = useAppStore();

  const handleSubmit = async () => {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      await apiPost('/api/journal', { raw_text: text.trim(), entry_date: entryDate || localToday() });
      setText('');
      invalidate.journal();
      triggerToast(!entryDate || entryDate === localToday()
        ? 'Logged — AI is extracting tasks, links, and time…'
        : `Logged for ${entryDate} — AI is extracting…`, 'success');
    } catch (err) {
      triggerToast(`Failed to save: ${String(err)}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Date-first pipeline: filter by range / jumped date / text, then group by day ──
  const cutoff = range === 'all' ? '' : localDaysAgo(range === '7d' ? 7 : 30);
  const q = search.trim().toLowerCase();
  const filtered = (entries ?? []).filter(e => {
    if (jumpDate) return e.entry_date === jumpDate;
    if (cutoff && e.entry_date < cutoff) return false;
    if (q && !e.raw_text.toLowerCase().includes(q) && !(e.summary ?? '').toLowerCase().includes(q)) return false;
    return true;
  });
  const byDay = new Map<string, typeof filtered>();
  for (const e of filtered) {
    if (!byDay.has(e.entry_date)) byDay.set(e.entry_date, []);
    byDay.get(e.entry_date)!.push(e);
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  const hiddenCount = (entries?.length ?? 0) - filtered.length;

  return (
    <div className="mobile-journal max-w-2xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-headline text-2xl font-bold text-white mb-1">Journal</h1>
          <p className="text-sm text-gray-500">Keep a record of your day and what you worked on.</p>
        </div>
      </div>

      {/* Composer — supports backdating */}
      <div className="bg-surface rounded-xl border border-gray-700 p-4 space-y-3">
        <textarea
          aria-label="Journal entry text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="What did you work on? (e.g. 'Spent 45 minutes on the ECG paper draft…')"
          rows={3}
          className="w-full bg-transparent text-sm text-gray-200 placeholder-gray-600 resize-none outline-none leading-relaxed"
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
        />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <input
              aria-label="Journal entry date"
              type="date"
              value={entryDate || localToday()}
              max={localToday()}
              onChange={e => setEntryDate(e.target.value || localToday())}
              className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-[11px] font-mono text-gray-300 focus:outline-none focus:border-indigo-500"
              title="Log for a different day (backdate)"
            />
            {entryDate && entryDate !== localToday() && (
              <button onClick={() => setEntryDate(localToday())} className="text-[10px] font-mono text-indigo-400 hover:underline" aria-label="Set journal date to today">today</button>
            )}
            <span className="text-[10px] font-mono text-gray-600 hidden sm:inline">Cmd+Enter to log</span>
          </div>
          <button
            onClick={handleSubmit}
            disabled={!text.trim() || submitting}
            aria-label="Log journal entry"
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition-colors"
          >
            {submitting ? 'Logging…' : 'Log entry'}
          </button>
        </div>
      </div>

      {/* Date navigation: range chips + jump-to-date + text search */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['7d', '30d', 'all'] as const).map(r => (
          <button
            key={r}
            onClick={() => { setRange(r); setJumpDate(''); }}
            aria-pressed={range === r && !jumpDate}
            className={`px-2.5 py-1 rounded-full text-[10px] font-mono uppercase border transition-colors ${
              range === r && !jumpDate ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-500 border-gray-700 hover:text-gray-300'
            }`}
          >
            {r === '7d' ? 'Last 7 days' : r === '30d' ? 'Last 30 days' : 'All'}
          </button>
        ))}
        <input
          aria-label="Jump to journal date"
          type="date"
          value={jumpDate}
          onChange={e => setJumpDate(e.target.value)}
          className={`bg-gray-900 border rounded-lg px-2 py-1 text-[11px] font-mono focus:outline-none focus:border-indigo-500 ${jumpDate ? 'border-indigo-500 text-indigo-300' : 'border-gray-700 text-gray-400'}`}
          title="Jump to one specific day"
        />
        {jumpDate && (
          <button onClick={() => setJumpDate('')} className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-900 hover:text-gray-300" aria-label="Clear journal date filter"><X size={12} /></button>
        )}
        <div className="relative flex-1 min-w-[160px]">
          <input
            aria-label="Search journal entries"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search entries…"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1 text-[11px] text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-indigo-500"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-600 hover:bg-gray-900 hover:text-gray-300" aria-label="Clear journal search"><X size={11} /></button>
          )}
        </div>
      </div>

      {/* AI Proposals */}
      <ProposalsPanel />

      {/* Timeline grouped by day */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 bg-surface rounded-xl border border-gray-800 animate-pulse" />
          ))}
        </div>
      ) : !days.length ? (
        <div className="text-center py-16 text-gray-600">
          <Circle size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {entries?.length
              ? 'Nothing in this range — widen the filter or clear the search.'
              : 'No journal entries yet. Write your first one above.'}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {days.map(day => (
            <section key={day}>
              <div className="sticky top-16 z-10 bg-canvas-bg/95 backdrop-blur py-1.5 mb-2 flex items-baseline gap-2">
                <h2 className="text-[12px] font-bold text-gray-300">{humanDay(day)}</h2>
                <span className="text-[10px] font-mono text-gray-600">{day}</span>
                {byDay.get(day)!.length > 1 && (
                  <span className="text-[10px] font-mono text-gray-600">· {byDay.get(day)!.length} entries</span>
                )}
              </div>
              <div className="space-y-2.5">
                {byDay.get(day)!.map(entry => <EntryCard key={entry.id} entry={entry} />)}
              </div>
            </section>
          ))}
          {hiddenCount > 0 && !jumpDate && range !== 'all' && (
            <button onClick={() => setRange('all')} className="w-full text-center text-[11px] font-mono text-gray-500 hover:text-gray-300 py-2">
              show {hiddenCount} older entr{hiddenCount === 1 ? 'y' : 'ies'} ↓
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function humanDay(dateStr: string): string {
  if (dateStr === localToday()) return 'Today';
  if (dateStr === localDaysAgo(1)) return 'Yesterday';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}
