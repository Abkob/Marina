import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FlaskConical, Activity, ScrollText, FileUp, Search as SearchIcon, Tags, MessageSquare,
  CalendarDays, RefreshCw, Trash2, Check, X, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { apiFetch, apiPost, apiDelete } from '../utils/apiFetch';
import { uploadResourceFile } from '../db/queries/resources';

/* The Testing workbench drives every real pipeline against data YOU pick and
 * shows the raw outputs (status transitions, evidence JSON, similarity scores,
 * citations, proposal diffs). Nothing here is mocked — every button calls the
 * same production endpoints the rest of the app uses. */

// ── Shared bits ───────────────────────────────────────────────────────────────

function Bench({ icon: Icon, title, subtitle, children }: {
  icon: typeof Activity; title: string; subtitle: string; children: React.ReactNode;
}) {
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [open, setOpen] = useState(!mobile);
  return (
    <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${title}`} className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-gray-50 text-left">
        <Icon size={15} className="text-[#4648d4] shrink-0" />
        <span className="text-[13px] font-bold text-gray-900">{title}</span>
        <span className="text-[11px] text-gray-400 flex-1 truncate">{subtitle}</span>
        {open ? <ChevronDown size={13} className="text-gray-400" /> : <ChevronRight size={13} className="text-gray-400" />}
      </button>
      {open && <div className="px-4 pb-4 border-t border-gray-100 pt-3">{children}</div>}
    </section>
  );
}

function Raw({ data, label = 'raw output' }: { data: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  if (data === null || data === undefined) return null;
  return (
    <div className="mt-2">
      <button onClick={() => setOpen(o => !o)} className="text-[10px] font-mono text-gray-400 hover:text-gray-600 flex items-center gap-1">
        {open ? <ChevronDown size={9} /> : <ChevronRight size={9} />} {label}
      </button>
      {open && (
        <pre className="mt-1 text-[10px] font-mono bg-gray-900 text-emerald-300 rounded-lg p-3 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap break-all">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

const btn = 'px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors disabled:opacity-40';
const btnPrimary = `${btn} bg-[#EEF2FF] text-[#4648d4] border-[#c0c1ff] hover:bg-[#c0c1ff]/20`;
const btnPlain = `${btn} bg-white text-gray-700 border-gray-200 hover:bg-gray-50`;
const btnDanger = `${btn} bg-red-50 text-red-600 border-red-200 hover:bg-red-100`;
const inputCls = 'bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#4648d4] w-full';

// ── 1. System status ──────────────────────────────────────────────────────────

function SystemBench() {
  const { data: health, refetch: r1, isFetching: f1 } = useQuery<Record<string, unknown>>({
    queryKey: ['testing-health'], queryFn: () => apiFetch('/api/health'), staleTime: 10_000,
  });
  const { data: ready, refetch: r2 } = useQuery<Record<string, unknown>>({
    queryKey: ['testing-ready'], queryFn: () => apiFetch('/api/health/ready'), staleTime: 10_000,
  });
  const models = (ready?.models ?? {}) as { primary?: { model: string; status: string }; fallback?: { model: string; status: string } };
  const queue = (health?.queue ?? {}) as Record<string, number>;
  const worker = (health?.worker ?? {}) as Record<string, unknown>;
  return (
    <Bench icon={Activity} title="System status" subtitle="DB, models, embedding queue, schema version — live readiness">
      <div className="flex flex-wrap gap-2 text-[11px] font-mono">
        <span className={`px-2 py-1 rounded border ${health?.db === 'connected' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>db: {String(health?.db ?? '…')}</span>
        <span className={`px-2 py-1 rounded border ${health?.ollama === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>ollama: {String(health?.ollama ?? '…')}</span>
        <span className="px-2 py-1 rounded border bg-gray-50 border-gray-200 text-gray-700">primary: {models.primary?.model} ({models.primary?.status})</span>
        <span className="px-2 py-1 rounded border bg-gray-50 border-gray-200 text-gray-700">fallback: {models.fallback?.model} ({models.fallback?.status})</span>
        <span className="px-2 py-1 rounded border bg-gray-50 border-gray-200 text-gray-700">schema: {String(health?.schema_version ?? '?')} ({String(health?.migration_count ?? '?')} migrations)</span>
        <span className="px-2 py-1 rounded border bg-gray-50 border-gray-200 text-gray-700">
          jobs: {Object.entries(queue).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}
        </span>
        <span className="px-2 py-1 rounded border bg-gray-50 border-gray-200 text-gray-700">stale embeddings: {String(worker.stale_embeddings ?? 0)}</span>
      </div>
      {Array.isArray(ready?.warnings) && (ready!.warnings as string[]).map(w => (
        <p key={w} className="text-[11px] text-amber-600 mt-2">⚠ {w}</p>
      ))}
      <div className="mt-2 flex gap-2">
        <button className={btnPlain} onClick={() => { r1(); r2(); }}>{f1 ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <Raw data={{ health, ready }} />
    </Bench>
  );
}

// ── 2. Journal pipeline bench ─────────────────────────────────────────────────

interface JournalRow {
  id: string; entry_date: string; ingestion_status: string; summary: string | null;
  tags_json: string; ai_tags_json?: string; mood?: string | null;
}

function JournalBench() {
  const [text, setText] = useState('');
  const [manualTags, setManualTags] = useState('');
  const [journalId, setJournalId] = useState<string | null>(null);
  const [journal, setJournal] = useState<JournalRow | null>(null);
  const [links, setLinks] = useState<unknown[]>([]);
  const [sessions, setSessions] = useState<unknown[]>([]);
  const [embedding, setEmbedding] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async (id: string) => {
    const j = await apiFetch<JournalRow>(`/api/journal/${id}`);
    setJournal(j);
    if (j.ingestion_status === 'processed' || j.ingestion_status === 'failed' || j.ingestion_status === 'needs_review') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      const [l, ws, emb] = await Promise.all([
        apiFetch<unknown[]>(`/api/journal/${id}/links`),
        apiFetch<unknown[]>(`/api/work-sessions?journal_entry_id=${id}`).catch(() => []),
        apiFetch(`/api/embeddings/status/journal_entry/${id}`).catch(() => null),
      ]);
      setLinks(l); setSessions(ws); setEmbedding(emb);
    }
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const tags = manualTags.split(',').map(t => t.trim()).filter(Boolean);
      const { id } = await apiPost<{ id: string }>('/api/journal', {
        raw_text: text, tags_json: JSON.stringify(tags),
      });
      setJournalId(id); setJournal(null); setLinks([]); setSessions([]); setEmbedding(null);
      pollRef.current = setInterval(() => refresh(id).catch(() => {}), 4000);
      await refresh(id);
    } finally { setBusy(false); }
  };

  const cleanup = async () => {
    if (!journalId) return;
    await apiDelete(`/api/journal/${journalId}`);
    setJournalId(null); setJournal(null); setLinks([]); setSessions([]); setEmbedding(null);
  };

  const statusColor: Record<string, string> = {
    pending: 'bg-gray-100 text-gray-600', processing: 'bg-blue-50 text-blue-600',
    processed: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-600', needs_review: 'bg-amber-50 text-amber-700',
  };

  return (
    <Bench icon={ScrollText} title="Journal pipeline" subtitle="Write a test entry → watch extraction → summary, links, sessions, embedding. Manual tags must survive.">
      <textarea
        value={text} onChange={e => setText(e.target.value)} rows={3}
        placeholder="e.g. Spent 30 minutes on the design system reviewing button variants…"
        className={inputCls}
      />
      <div className="flex gap-2 mt-2 items-center flex-wrap">
        <input value={manualTags} onChange={e => setManualTags(e.target.value)} placeholder="manual tags, comma-separated (should never be overwritten)" className={`${inputCls} max-w-xs`} />
        <button className={btnPrimary} disabled={!text.trim() || busy} onClick={create}>Create & trace</button>
        {journalId && journal?.ingestion_status !== 'processing' && (
          <button className={btnPlain} onClick={() => apiPost(`/api/journal/${journalId}/ingest`, {}).then(() => { pollRef.current = setInterval(() => refresh(journalId).catch(() => {}), 4000); })}>Re-ingest</button>
        )}
        {journalId && <button className={btnDanger} onClick={cleanup}><Trash2 size={11} className="inline mr-1" />Delete test entry</button>}
      </div>
      {journal && (
        <div className="mt-3 space-y-1.5 text-[12px]">
          <p><span className={`font-mono text-[10px] px-1.5 py-0.5 rounded uppercase ${statusColor[journal.ingestion_status] ?? ''}`}>{journal.ingestion_status}</span>
            {journal.ingestion_status === 'processing' && <span className="text-gray-400 text-[10px] ml-2">polling every 4s…</span>}
          </p>
          {journal.summary && <p><b>Summary:</b> {journal.summary}</p>}
          <p><b>Manual tags:</b> <code className="text-[10px] bg-gray-100 px-1 rounded">{journal.tags_json}</code>
            {' '}<b>AI tags:</b> <code className="text-[10px] bg-gray-100 px-1 rounded">{journal.ai_tags_json ?? '[]'}</code></p>
          {links.length > 0 && <p><b>Links:</b> {links.map((l) => {
            const link = l as { target_type: string; target_title?: string; relationship: string; confidence: number; created_by: string };
            return `${link.target_type} "${link.target_title}" (${link.relationship}, ${link.confidence}, by ${link.created_by})`;
          }).join(' · ')}</p>}
          {sessions.length > 0 && <p><b>Work sessions:</b> {sessions.map(s => `${(s as { minutes: number }).minutes}min`).join(', ')}</p>}
          <Raw data={{ journal, links, sessions, embedding }} />
        </div>
      )}
    </Bench>
  );
}

// ── 3. Document pipeline bench ────────────────────────────────────────────────

function DocumentBench() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<Array<Record<string, unknown>>>([]);
  const [findQ, setFindQ] = useState('');
  const [findResults, setFindResults] = useState<Array<Record<string, unknown>> | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshChunks = async (id: string) => {
    setChunks(await apiFetch<Array<Record<string, unknown>>>(`/api/resources/${id}/chunks`));
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const id = await uploadResourceFile(file);
      setResourceId(id);
      setFindResults(null);
      // chunking + embedding are async — poll a few times
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        await refreshChunks(id);
      }
    } finally { setBusy(false); }
  };

  const search = async () => {
    const r = await apiFetch<{ results: Array<Record<string, unknown>> }>(`/api/search?q=${encodeURIComponent(findQ)}&types=resource_chunk`);
    setFindResults(r.results);
  };

  const cleanup = async () => {
    if (!resourceId) return;
    await apiDelete(`/api/resources/${resourceId}`);
    setResourceId(null); setChunks([]); setFindResults(null);
  };

  return (
    <Bench icon={FileUp} title="Document pipeline" subtitle="Upload YOUR PDF/text → exact-page chunks → embeddings → find its content semantically.">
      <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      <div className="flex gap-2 flex-wrap items-center">
        <button className={btnPrimary} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? <RefreshCw size={11} className="inline animate-spin mr-1" /> : null}{busy ? 'Processing…' : 'Upload a file'}
        </button>
        {resourceId && <button className={btnPlain} onClick={() => apiPost(`/api/resources/${resourceId}/rechunk`, {}).then(() => refreshChunks(resourceId))}>Re-chunk</button>}
        {resourceId && <button className={btnDanger} onClick={cleanup}><Trash2 size={11} className="inline mr-1" />Delete test file</button>}
      </div>
      {resourceId && (
        <div className="mt-3 text-[12px] space-y-1">
          <p><b>{chunks.length}</b> chunk{chunks.length !== 1 ? 's' : ''}
            {chunks.length > 0 && <> · embedded: <b>{chunks.filter(c => c.has_embedding).length}/{chunks.length}</b></>}</p>
          {chunks.slice(0, 5).map(c => (
            <p key={String(c.id)} className="text-gray-600 truncate">
              #{String(c.chunk_index)} {c.page_start != null ? `(p. ${c.page_start}–${c.page_end})` : ''} · {String(c.content_chars)} chars · {c.has_embedding ? '✓ embedded' : '… embedding pending'} — <span className="text-gray-400">{String(c.content_preview).slice(0, 80)}</span>
            </p>
          ))}
          <div className="flex gap-2 mt-2">
            <input value={findQ} onChange={e => setFindQ(e.target.value)} placeholder="Search for content FROM your file (semantic)" className={inputCls} />
            <button className={btnPlain} disabled={!findQ.trim()} onClick={search}>Find</button>
          </div>
          {findResults && (
            <div className="mt-1">
              {findResults.length === 0 && <p className="text-gray-400">No chunk matches.</p>}
              {findResults.slice(0, 5).map((r, i) => (
                <p key={i} className="text-gray-700">
                  <b>{Number(r.score).toFixed(3)}</b> · {String(r.title)} — <span className="text-gray-400">{String(r.snippet ?? '').slice(0, 90)}</span>
                </p>
              ))}
            </div>
          )}
          <Raw data={{ chunks, findResults }} />
        </div>
      )}
    </Bench>
  );
}

// ── 4. Search bench ───────────────────────────────────────────────────────────

function SearchBench() {
  const [q, setQ] = useState('');
  const [out, setOut] = useState<{ results: Array<Record<string, unknown>>; vector_degraded: boolean } | null>(null);
  const run = async () => setOut(await apiFetch(`/api/search?q=${encodeURIComponent(q)}`));
  return (
    <Bench icon={SearchIcon} title="Semantic search" subtitle="Any query → ranked results with real cosine scores. Try a paraphrase with no keyword overlap.">
      <div className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && q.trim() && run()} placeholder="e.g. UI widget style guide" className={inputCls} />
        <button className={btnPrimary} disabled={!q.trim()} onClick={run}>Search</button>
      </div>
      {out && (
        <div className="mt-2 text-[12px]">
          {out.vector_degraded && <p className="text-amber-600 mb-1">⚠ vector search degraded — keyword fallback used</p>}
          {out.results.length === 0 && <p className="text-gray-400">No results.</p>}
          {out.results.slice(0, 10).map((r, i) => (
            <p key={i} className="truncate">
              <b>{Number(r.score).toFixed(3)}</b>
              <span className="font-mono text-[10px] text-gray-400 uppercase mx-1.5">{String(r.entity_type).replace('_', ' ')}</span>
              {String(r.title)}
              {r.snippet ? <span className="text-gray-400"> — {String(r.snippet).slice(0, 70)}</span> : null}
            </p>
          ))}
          <Raw data={out} />
        </div>
      )}
    </Bench>
  );
}

// ── 5. Topic / cluster bench ──────────────────────────────────────────────────

function TopicBench() {
  const qc = useQueryClient();
  const { triggerToast } = useAppStore();
  const { data: topics = [] } = useQuery<Array<{ id: string; name: string; member_count: number; suggestion_count: number }>>({
    queryKey: ['topics'], queryFn: () => apiFetch('/api/topics'),
  });
  const [topicId, setTopicId] = useState('');
  const [genOut, setGenOut] = useState<Record<string, unknown> | null>(null);
  const [members, setMembers] = useState<Array<Record<string, unknown>>>([]);
  const [suggestions, setSuggestions] = useState<Array<Record<string, unknown>>>([]);
  const selected = topics.find(t => t.id === topicId);

  const load = async (id: string) => {
    const [m, s] = await Promise.all([
      apiFetch<Array<Record<string, unknown>>>(`/api/topics/${id}/members`),
      apiFetch<Array<Record<string, unknown>>>(`/api/topics/${id}/members?status=suggested`),
    ]);
    setMembers(m); setSuggestions(s);
  };

  const generate = async () => {
    const r = await apiPost<Record<string, unknown>>('/api/topics/suggestions/generate', topicId ? { topic_id: topicId } : {});
    setGenOut(r);
    if (topicId) await load(topicId);
    qc.invalidateQueries({ queryKey: ['topics'] });
    qc.invalidateQueries({ queryKey: ['topic-suggestions'] });
  };

  const decide = async (id: string, verb: 'accept' | 'reject') => {
    await apiPost(`/api/topics/suggestions/${id}/${verb}`, {});
    triggerToast(verb === 'accept' ? 'Accepted → canonical member.' : 'Rejected → will not reappear.', 'success');
    if (topicId) await load(topicId);
    qc.invalidateQueries({ queryKey: ['topics'] });
  };

  return (
    <Bench icon={Tags} title="Clusters & suggestions" subtitle="Pick YOUR topic → run generation → inspect the raw evidence (cosine, graph paths, alias matches).">
      <div className="flex gap-2 flex-wrap items-center">
        <select value={topicId} onChange={e => { setTopicId(e.target.value); if (e.target.value) load(e.target.value); }} className={`${inputCls} max-w-xs`}>
          <option value="">All active topics</option>
          {topics.map(t => <option key={t.id} value={t.id}>{t.name} ({t.member_count} members, {t.suggestion_count} pending)</option>)}
        </select>
        <button className={btnPrimary} onClick={generate}>Run candidate generation</button>
      </div>
      {genOut && <p className="text-[12px] mt-2"><b>{String(genOut.suggestions_created)}</b> new candidate(s) · run <code className="text-[10px] bg-gray-100 px-1 rounded">{String(genOut.run_id).slice(0, 8)}</code></p>}
      {selected && (
        <div className="mt-2 text-[12px] space-y-1">
          <p className="font-bold text-gray-700">Members ({members.length})</p>
          {members.slice(0, 8).map(m => (
            <p key={String(m.id)} className="text-gray-600 truncate">• {String(m.entity_title ?? m.entity_id)} <span className="font-mono text-[9px] uppercase text-gray-400">({String(m.source)})</span></p>
          ))}
          <p className="font-bold text-gray-700 mt-2">Pending suggestions ({suggestions.length})</p>
          {suggestions.map(s => {
            let ev: Record<string, unknown> = {};
            try { ev = JSON.parse(String(s.evidence_json)); } catch { /* ignore */ }
            const cos = (ev.cosine as { score?: number } | undefined)?.score;
            return (
              <div key={String(s.id)} className="flex items-center gap-2 border border-gray-100 rounded-lg px-2 py-1.5">
                <span className="flex-1 truncate">{String(s.entity_title ?? s.entity_id)}
                  <span className="text-gray-400 text-[10px] ml-1.5">
                    conf {Number(s.confidence).toFixed(2)}
                    {cos !== undefined && ` · cosine ${Number(cos).toFixed(3)}`}
                    {ev.graph ? ' · graph' : ''}{ev.alias ? ' · alias' : ''}
                  </span>
                </span>
                <button className="w-6 h-6 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100" title="Accept" onClick={() => decide(String(s.id), 'accept')}><Check size={11} className="mx-auto" /></button>
                <button className="w-6 h-6 rounded bg-red-50 text-red-500 hover:bg-red-100" title="Reject" onClick={() => decide(String(s.id), 'reject')}><X size={11} className="mx-auto" /></button>
              </div>
            );
          })}
          <Raw data={{ members, suggestions }} />
        </div>
      )}
    </Bench>
  );
}

// ── 6. Chat & citations bench ─────────────────────────────────────────────────

function ChatBench() {
  const [q, setQ] = useState('');
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setOut(null);
    try {
      setOut(await apiPost('/api/ai/chat', { messages: [{ role: 'user', content: q }] }));
    } catch (e) {
      setOut({ error: (e as Error).message });
    } finally { setBusy(false); }
  };
  const citations = (out?.citations ?? []) as Array<Record<string, unknown>>;
  const actions = (out?.actions ?? []) as Array<Record<string, unknown>>;
  return (
    <Bench icon={MessageSquare} title="Chat grounding & citations" subtitle="Ask anything → see the reply, every validated/rejected action, and exactly which of your records were in context and why.">
      <div className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && q.trim() && !busy && run()} placeholder="e.g. What have I been working on for the design system?" className={inputCls} />
        <button className={btnPrimary} disabled={!q.trim() || busy} onClick={run}>{busy ? <RefreshCw size={11} className="inline animate-spin" /> : 'Ask'}</button>
      </div>
      {busy && <p className="text-[11px] text-gray-400 font-mono mt-2">Waiting for the model… (cloud ≈ seconds; local fallback can take minutes)</p>}
      {out && (
        <div className="mt-2 text-[12px] space-y-2">
          {typeof out.error === 'string' && <p className="text-red-600">{out.error}</p>}
          {typeof out.reply === 'string' && <p className="whitespace-pre-wrap bg-gray-50 border border-gray-100 rounded-lg p-2.5">{out.reply}</p>}
          {actions.length > 0 && (
            <div>
              <p className="font-bold text-gray-700">Actions ({actions.length})</p>
              {actions.map((a, i) => (
                <p key={i} className={String(a.rejected_reason ? 'text-red-600' : 'text-gray-700')}>
                  {String(a.type)} {a.rejected_reason ? `— REJECTED: ${String(a.rejected_reason)}` : `→ proposal ${String(a.proposal_id ?? '').slice(0, 8)}`}
                </p>
              ))}
            </div>
          )}
          {citations.length > 0 && (
            <div>
              <p className="font-bold text-gray-700">Citations ({citations.length}) — what the model saw and why</p>
              <div className="max-h-56 overflow-y-auto">
                {citations.map((c, i) => (
                  <p key={i} className="truncate text-gray-600">
                    <span className="font-mono text-[9px] uppercase text-gray-400 mr-1">{String(c.entity_type).replace('_', ' ')}</span>
                    {String(c.title)}
                    <span className="font-mono text-[10px] text-gray-400 ml-1.5">
                      [{(c.matched_via as string[]).join('+')}{c.similarity !== undefined ? ` ${(Number(c.similarity) * 100).toFixed(0)}%` : ''}]
                    </span>
                    {Array.isArray(c.topics) && c.topics.length > 0 && <span className="text-indigo-500 text-[10px] ml-1">#{(c.topics as string[])[0]}</span>}
                  </p>
                ))}
              </div>
            </div>
          )}
          <Raw data={out} />
        </div>
      )}
    </Bench>
  );
}

// ── 7. Scheduler bench ────────────────────────────────────────────────────────

function SchedulerBench() {
  const qc = useQueryClient();
  const { triggerToast } = useAppStore();
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  const run = async () => {
    const r = await apiPost<Record<string, unknown>>('/api/ai/schedule/propose', { horizon_days: 14 });
    setOut(r);
    qc.invalidateQueries({ queryKey: ['proposals'] });
  };
  const decide = async (id: string, verb: 'apply' | 'reject') => {
    await apiPost(`/api/ai/proposals/${id}/${verb}`, {});
    triggerToast(verb === 'apply' ? 'Applied — start date written.' : 'Rejected.', 'success');
    for (const k of ['tasks', 'goal-tasks', 'schedule-preview', 'proposals']) qc.invalidateQueries({ queryKey: [k] });
    await run();
  };
  const sr = (out?.scheduler_result ?? {}) as Record<string, unknown>;
  const proposals = (out?.proposals ?? []) as Array<Record<string, unknown>>;
  return (
    <Bench icon={CalendarDays} title="Scheduler" subtitle="Run the deterministic scheduler → proposal diffs (nothing mutates until you apply).">
      <button className={btnPrimary} onClick={run}>Run scheduler & propose</button>
      {out && (
        <div className="mt-2 text-[12px] space-y-1.5">
          <p>
            status <b>{String(sr.status)}</b> · gap <b>{String(sr.gap_minutes)}m</b> ·
            unestimated <b>{(sr.unestimated_task_ids as string[] | undefined)?.length ?? 0}</b> ·
            overflow <b>{(sr.tasks_overflow as string[] | undefined)?.length ?? 0}</b>
          </p>
          {proposals.length === 0 && <p className="text-gray-400">No changes proposed — start dates already match, or nothing is schedulable.</p>}
          {proposals.map(p => {
            const before = (p.before as { start_date: string | null }).start_date ?? 'none';
            const after = (p.after as { start_date: string }).start_date;
            return (
              <div key={String(p.proposal_id)} className="flex items-center gap-2 border border-gray-100 rounded-lg px-2 py-1.5">
                <span className="flex-1 truncate">{String(p.title)} <span className="text-gray-400">— start <span className="line-through">{before}</span> → <b>{after}</b></span></span>
                <button className="w-6 h-6 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100" title="Apply" onClick={() => decide(String(p.proposal_id), 'apply')}><Check size={11} className="mx-auto" /></button>
                <button className="w-6 h-6 rounded bg-red-50 text-red-500 hover:bg-red-100" title="Reject" onClick={() => decide(String(p.proposal_id), 'reject')}><X size={11} className="mx-auto" /></button>
              </div>
            );
          })}
          <Raw data={out} />
        </div>
      )}
    </Bench>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function TestingView() {
  return (
    <div className="max-w-[900px] mx-auto px-4 md:px-10 py-6 animate-fade-in space-y-4">
      <div>
        <h2 className="font-headline text-2xl font-bold text-black flex items-center gap-2">
          <FlaskConical size={20} /> Diagnostics
        </h2>
        <p className="text-xs font-mono text-gray-400 uppercase tracking-widest mt-1">
          Check connections and troubleshoot your workspace.
        </p>
      </div>
      <SystemBench />
      <JournalBench />
      <DocumentBench />
      <SearchBench />
      <TopicBench />
      <ChatBench />
      <SchedulerBench />
    </div>
  );
}
