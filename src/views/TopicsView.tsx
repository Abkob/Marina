import { MobileDisclosure } from '../components/MobileDisclosure';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Tags, Check, X, Sparkles, Trash2, RefreshCw, Target, CheckSquare, BookOpen, FileText, Calendar, StickyNote, Diamond } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { apiFetch, apiPost, apiDelete } from '../utils/apiFetch';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Topic {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  status: 'active' | 'archived' | 'merged';
  member_count: number;
  suggestion_count: number;
  created_at: string;
}

interface Membership {
  id: string;
  topic_id: string;
  entity_type: string;
  entity_id: string;
  source: 'manual' | 'imported' | 'ai_suggested' | 'ai_accepted';
  status: 'suggested' | 'accepted' | 'rejected' | 'superseded';
  confidence: number;
  evidence_json: string;
  reason_codes: string;
  entity_title: string | null;
  topic_name?: string;
}

const TYPE_ICONS: Record<string, typeof Target> = {
  goal: Target,
  task: CheckSquare,
  milestone: Diamond,
  resource: BookOpen,
  journal_entry: FileText,
  meeting: Calendar,
  note: StickyNote,
};

function parseReasons(m: Membership): string[] {
  try { return JSON.parse(m.reason_codes); } catch { return []; }
}

function evidenceSummary(m: Membership): string {
  try {
    const ev = JSON.parse(m.evidence_json) as {
      cosine?: { score: number; nearest_member: string };
      graph?: { via: string[] };
      alias?: { matched: string[] };
    };
    const parts: string[] = [];
    if (ev.cosine) parts.push(`semantic similarity ${(ev.cosine.score * 100).toFixed(0)}% to ${ev.cosine.nearest_member.split(':')[0]} member`);
    if (ev.graph) parts.push(`graph-connected via ${ev.graph.via.length} link${ev.graph.via.length > 1 ? 's' : ''}`);
    if (ev.alias) parts.push(`title matches "${ev.alias.matched.join('", "')}"`);
    return parts.join(' · ') || 'manually asserted';
  } catch {
    return '';
  }
}

// ── Suggestion inbox ──────────────────────────────────────────────────────────

function SuggestionInbox() {
  const qc = useQueryClient();
  const { triggerToast } = useAppStore();
  const { data: suggestions = [] } = useQuery<Membership[]>({
    queryKey: ['topic-suggestions'],
    queryFn: () => apiFetch<Membership[]>('/api/topics/suggestions'),
  });

  const decide = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'accept' | 'reject' }) =>
      apiPost(`/api/topics/suggestions/${id}/${verb}`, {}),
    onSuccess: (_d, { verb }) => {
      qc.invalidateQueries({ queryKey: ['topic-suggestions'] });
      qc.invalidateQueries({ queryKey: ['topics'] });
      qc.invalidateQueries({ queryKey: ['topic-members'] });
      triggerToast(verb === 'accept' ? 'Added to topic.' : 'Suggestion rejected — it will not reappear.', 'success');
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  if (!suggestions.length) {
    return (
      <p className="text-xs text-gray-400 font-mono px-1 py-3">
        No pending suggestions. Run “Find suggestions” to generate some.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {suggestions.map(s => {
        const Icon = TYPE_ICONS[s.entity_type] ?? FileText;
        return (
          <div key={s.id} data-testid="topic-suggestion" className="bg-white border border-gray-200 rounded-xl p-3 flex items-start gap-3">
            <Icon size={14} className="text-gray-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-gray-900 truncate">{s.entity_title ?? s.entity_id}</p>
              <p className="text-[10px] font-mono text-gray-400 uppercase mt-0.5">
                {s.entity_type.replace('_', ' ')} → {s.topic_name} · {(s.confidence * 100).toFixed(0)}%
              </p>
              <p className="text-[11px] text-gray-500 mt-1">{evidenceSummary(s)}</p>
              <div className="flex gap-1 mt-1 flex-wrap">
                {parseReasons(s).map(r => (
                  <span key={r} className="text-[9px] font-mono bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded uppercase">{r.replace(/_/g, ' ')}</span>
                ))}
              </div>
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button
                onClick={() => decide.mutate({ id: s.id, verb: 'accept' })}
                disabled={decide.isPending}
                className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 flex items-center justify-center disabled:opacity-50"
                title="Accept"
                aria-label={`Accept topic suggestion for ${s.entity_title ?? s.entity_id}`}
              >
                <Check size={13} />
              </button>
              <button
                onClick={() => decide.mutate({ id: s.id, verb: 'reject' })}
                disabled={decide.isPending}
                className="w-7 h-7 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 flex items-center justify-center disabled:opacity-50"
                title="Reject (won't reappear)"
                aria-label={`Reject topic suggestion for ${s.entity_title ?? s.entity_id}`}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Topic member list ─────────────────────────────────────────────────────────

function TopicMembers({ topic }: { topic: Topic }) {
  const qc = useQueryClient();
  const { triggerToast } = useAppStore();
  const { data: members = [] } = useQuery<Membership[]>({
    queryKey: ['topic-members', topic.id],
    queryFn: () => apiFetch<Membership[]>(`/api/topics/${topic.id}/members`),
  });

  const remove = useMutation({
    mutationFn: (membershipId: string) => apiDelete(`/api/topics/${topic.id}/members/${membershipId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topic-members', topic.id] });
      qc.invalidateQueries({ queryKey: ['topics'] });
      triggerToast('Membership removed.', 'success');
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  if (!members.length) {
    return <p className="text-xs text-gray-400 font-mono py-2">No members yet — add entities manually or accept suggestions.</p>;
  }

  return (
    <div className="space-y-1.5">
      {members.map(m => {
        const Icon = TYPE_ICONS[m.entity_type] ?? FileText;
        return (
          <div key={m.id} className="group flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-gray-50">
            <Icon size={13} className="text-gray-400 shrink-0" />
            <span className="flex-1 text-[12px] text-gray-800 truncate">{m.entity_title ?? m.entity_id}</span>
            <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded ${
              m.source === 'manual' ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-500'
            }`}>
              {m.source === 'manual' ? 'manual' : 'ai'}
            </span>
            <button
              onClick={() => remove.mutate(m.id)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 focus:opacity-100"
              title={m.source === 'manual' ? 'Remove' : 'Remove (rejects future re-suggestion)'}
              aria-label={`Remove ${m.entity_title ?? m.entity_id} from ${topic.name}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function TopicsView() {
  const qc = useQueryClient();
  const { triggerToast, showConfirm } = useAppStore();
  const [newName, setNewName] = useState('');
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);

  const deleteTopic = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/topics/${id}`),
    onSuccess: () => {
      setSelectedTopicId(null);
      qc.invalidateQueries({ queryKey: ['topics'] });
      qc.invalidateQueries({ queryKey: ['topic-suggestions'] });
      qc.invalidateQueries({ queryKey: ['entity-topics'] });
      triggerToast('Topic deleted. The records that were in it are untouched.', 'info');
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  const { data: topics = [], isLoading } = useQuery<Topic[]>({
    queryKey: ['topics'],
    queryFn: () => apiFetch<Topic[]>('/api/topics'),
  });

  const createTopic = useMutation({
    mutationFn: (name: string) => apiPost<Topic>('/api/topics', { name }),
    onSuccess: (t) => {
      setNewName('');
      setSelectedTopicId(t.id);
      qc.invalidateQueries({ queryKey: ['topics'] });
      triggerToast(`Topic "${t.name}" created.`, 'success');
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  const generate = useMutation({
    mutationFn: () => apiPost<{ suggestions_created: number }>('/api/topics/suggestions/generate', {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['topic-suggestions'] });
      qc.invalidateQueries({ queryKey: ['topics'] });
      triggerToast(
        r.suggestions_created
          ? `Found ${r.suggestions_created} new candidate${r.suggestions_created > 1 ? 's' : ''} for review.`
          : 'No new candidates found — everything nearby is already organized or was rejected.',
        r.suggestions_created ? 'success' : 'info',
      );
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  const selected = topics.find(t => t.id === selectedTopicId) ?? null;

  return (
    <div className="max-w-[1100px] mx-auto px-4 md:px-10 py-6 animate-fade-in">
      <div className="mobile-toolbar flex justify-between items-end mb-6">
        <div>
          <h2 className="font-headline text-2xl font-bold text-black flex items-center gap-2">
            <Tags size={20} /> Topics
          </h2>
          <p className="text-xs font-mono text-gray-400 uppercase tracking-widest mt-1">
            Group related work, reading and ideas.
          </p>
        </div>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending || topics.length === 0}
          aria-label="Find topic membership candidates"
          className="p-2 px-3 bg-[#EEF2FF] hover:bg-[#c0c1ff]/20 text-[#4648d4] border border-[#c0c1ff] rounded-lg font-sans font-bold text-xs flex items-center gap-1.5 transition-all disabled:opacity-50"
          title={topics.length === 0 ? 'Create a topic first' : 'Generate explainable membership suggestions'}
        >
          {generate.isPending
            ? <RefreshCw size={13} className="animate-spin" />
            : <Sparkles size={13} />}
          Find suggestions
        </button>
      </div>

      <div className="mb-4"><MobileDisclosure title="How topics work" storageKey="topics-help"><div className="bg-[#EEF2FF] border border-[#4648d4]/15 rounded-xl px-4 py-3 mb-5 text-[12px] text-gray-600 leading-relaxed">
        <b className="text-[#4648d4]">Topics = your tags, grown up.</b> Tag any record (resource, task, journal) with a
        topic’s name and it <b>joins that topic automatically</b> — your word is authoritative. Creating a topic here
        retroactively pulls in everything already tagged with its name. AI-extracted tags only <i>suggest</i> membership
        and wait in the inbox. Add members directly from any goal/resource/journal page via the
        <span className="font-mono text-[10px] bg-white px-1 rounded border border-gray-200 mx-1">＋ chip</span>
        too. <b>“Find suggestions”</b> adds semantic suggestions (meaning, links, names). Chat, search and the graph all
        use your topics to pull the right context.
      </div></MobileDisclosure></div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Topic list + creation */}
        <div className="lg:col-span-4 space-y-3">
          <form
            onSubmit={(e) => { e.preventDefault(); if (newName.trim()) createTopic.mutate(newName.trim()); }}
            className="flex gap-2"
          >
            <label htmlFor="new-topic-name" className="sr-only">New topic name</label>
            <input
              id="new-topic-name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="New topic name…"
              className="min-w-0 flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#4648d4]"
            />
            <button
              type="submit"
              disabled={!newName.trim() || createTopic.isPending}
              aria-label="Create topic"
              className="px-3 py-2 bg-black text-white rounded-lg disabled:opacity-40"
            >
              <Plus size={13} />
            </button>
          </form>

          {isLoading && <p className="text-xs text-gray-400 font-mono">Loading topics…</p>}
          {!isLoading && topics.length === 0 && (
            <div className="bg-[#EEF2FF] rounded-xl p-5 border border-dashed border-[#4648d4]/20 text-center text-xs text-gray-600">
              Create your first topic, add a few entities manually, then run “Find suggestions”
              to let semantic search suggest what else belongs.
            </div>
          )}
          {topics.map(t => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              aria-pressed={t.id === selectedTopicId}
              aria-label={`${t.id === selectedTopicId ? 'Collapse' : 'Open'} topic ${t.name}`}
              onClick={() => setSelectedTopicId(t.id === selectedTopicId ? null : t.id)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedTopicId(t.id === selectedTopicId ? null : t.id);
                }
              }}
              className={`group w-full text-left bg-white border rounded-xl p-3.5 transition-all cursor-pointer ${
                t.id === selectedTopicId ? 'border-[#4648d4] ring-1 ring-[#4648d4]/30' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-bold text-gray-900 truncate">{t.name}</span>
                <span className="text-[10px] font-mono text-gray-400 shrink-0">
                  {t.member_count} member{t.member_count !== 1 ? 's' : ''}
                  {t.suggestion_count > 0 && (
                    <span className="text-[#4648d4] font-bold"> · {t.suggestion_count} pending</span>
                  )}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    showConfirm(
                      `Delete topic "${t.name}"? Its ${t.member_count} membership${t.member_count !== 1 ? 's' : ''} disappear, but the goals/tasks/resources themselves are NOT deleted.`,
                      () => deleteTopic.mutate(t.id),
                    );
                  }}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                  title="Delete this topic"
                  aria-label={`Delete topic ${t.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {t.description && <p className="text-[11px] text-gray-500 mt-1 truncate">{t.description}</p>}
            </div>
          ))}

          {selected && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-[11px] font-mono text-gray-400 uppercase tracking-wider mb-2">Members of {selected.name}</p>
              <TopicMembers topic={selected} />
            </div>
          )}
        </div>

        {/* Suggestion inbox */}
        <div className="lg:col-span-8">
          <p className="text-[11px] font-mono text-gray-400 uppercase tracking-wider mb-2">
            Suggestion inbox — each candidate explains why it matched
          </p>
          <SuggestionInbox />
        </div>
      </div>
    </div>
  );
}
