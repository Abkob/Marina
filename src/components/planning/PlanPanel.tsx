import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, ClipboardList, RefreshCw, RotateCcw } from 'lucide-react';
import { apiFetch, apiPost, ApiError } from '../../utils/apiFetch';
import { assertBoundedPayload, effortLabel } from '../../../shared/planningContracts';
import { emptyPlanContent, planContentSchema, planningContextResponseSchema, type PlanContent, type PlanningContextResponse, type PlanningRoot } from '../../../shared/planningState';
import { ScenarioStatus } from './ScenarioStatus';

type Draft = { base: number; content: PlanContent; key: string };
const button = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-2 text-xs text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-40';
const field = 'mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 focus:outline-indigo-400';
const localKey = (root: PlanningRoot) => `marina-plan-draft-v1:${root.kind}:${root.id}`;
function LineField({label,value,disabled,onChange}:{label:string;value:string[];disabled:boolean;onChange:(lines:string[])=>void}) {
  const canonical=value.join('\n'); const [text,setText]=useState(canonical);
  useEffect(()=>setText(canonical),[canonical]);
  return <textarea aria-label={label} className={field} rows={2} maxLength={15029} value={text} disabled={disabled}
    onChange={event=>{setText(event.target.value);onChange(event.target.value.split('\n').filter(line=>line.trim().length>0));}}/>;
}
function restoreDraft(root: PlanningRoot): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(localKey(root)) ?? 'null'); assertBoundedPayload(raw);
    if (!raw || !Number.isInteger(raw.base) || raw.base < 0 || typeof raw.key !== 'string') return null;
    return { base: raw.base, key: raw.key, content: { ...planContentSchema.parse(raw.content),work_items:[] } };
  } catch { return null; }
}
/** Root-keyed inner instance prevents a late response from a previous task
 * from being presented as the newly selected task's planning context. */
export function PlanPanel({ root }: { root: PlanningRoot }) {
  return <RootPlanPanel key={`${root.kind}:${root.id}`} root={root} />;
}
function RootPlanPanel({ root }: { root: PlanningRoot }) {
  const [open,setOpen] = useState(false); const [context,setContext] = useState<PlanningContextResponse | null>(null);
  const [draft,setDraft] = useState<Draft | null>(() => restoreDraft(root));
  const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [storageError,setStorageError] = useState(false);
  const [forget,setForget] = useState(false); const sequence = useRef(0); const alive = useRef(true);
  const [history,setHistory] = useState<Array<{version:number;origin:string;operation:string}>>([]);
  const scope = useMemo(() => {
    const now = new Date(); const date = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const to = new Date(now); to.setDate(to.getDate()+6);
    return { root, from: date(now), to: date(to), include_subtasks: false };
  },[root.kind,root.id]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; },[]);
  useEffect(() => {
    try { if (draft) localStorage.setItem(localKey(root),JSON.stringify({ ...draft,content:{...draft.content,work_items:[]} })); else localStorage.removeItem(localKey(root)); setStorageError(false); }
    catch { setStorageError(true); }
  },[draft,root.kind,root.id]);
  const load = async () => {
    const request = ++sequence.current; setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ root_kind: root.kind,root_id:root.id,from:scope.from,to:scope.to });
      const value = await apiFetch(`/api/planning/context?${params}`); assertBoundedPayload(value);
      const next = planningContextResponseSchema.parse(value);
      if (alive.current && request === sequence.current) setContext(next);
    } catch (e) { if (alive.current && request === sequence.current) { setContext(null); setError(e instanceof ApiError ? e.message : 'The plan could not be loaded. Your draft is still available.'); } }
    finally { if (alive.current && request === sequence.current) setBusy(false); }
  };
  useEffect(() => { if (open) void load(); },[open]);
  const plan = context?.plan; const content = { ...(draft?.content ?? plan?.content ?? emptyPlanContent()),work_items:plan?.content.work_items ?? [] };
  const conflict = Boolean(draft && plan && draft.base !== plan.version);
  const change = (patch: Partial<PlanContent>) => setDraft({ base: draft?.base ?? plan?.version ?? 0, content: { ...content,...patch }, key: crypto.randomUUID() });
  const create = async () => {
    setBusy(true); setError('');
    try { await apiPost('/api/planning/plans',{root}); if (alive.current) await load(); }
    catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : 'Could not create the plan.'); setBusy(false); } }
  };
  const save = async () => {
    if (!draft || !plan || !context) return; setBusy(true); setError('');
    try {
      if(!planContentSchema.safeParse(content).success){setError('Use at most 30 decisions and 30 questions, each up to 500 characters.');setBusy(false);return;}
      await apiPost(`/api/planning/plans/${plan.id}/revisions`,{ scope, revision: { base_version:draft.base,idempotency_key:draft.key,snapshot_token:context.snapshot_token,content } });
      if (!alive.current) return;
      setDraft(null); await load();
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 409) { await load(); setError(e.message); }
      else setError(e instanceof Error ? e.message : 'Could not save. Your draft is still available.');
      setBusy(false);
    }
  };
  const lifecycle = async (operation: 'archive'|'restore'|'forget') => {
    if (!plan) return; setBusy(true); setError('');
    try {
      await apiPost(`/api/planning/plans/${plan.id}/lifecycle`,{ operation,base_version:plan.version,idempotency_key:crypto.randomUUID() });
      if (!alive.current) return;
      if (operation === 'forget') setDraft(null);
      setForget(false); await load();
    } catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : 'Could not update the plan.'); setBusy(false); } }
  };
  const showHistory = async () => {
    if(!plan)return;
    try{const result=await apiFetch<{revisions:Array<{version:number;origin:string;operation:string}>}>(`/api/planning/plans/${plan.id}/history`);if(alive.current)setHistory(result.revisions);}
    catch{if(alive.current)setError('Revision history could not be loaded.');}
  };
  const recover = async (version:number) => {
    if(!plan)return;setBusy(true);
    try{
      const params=new URLSearchParams({root_kind:root.kind,root_id:root.id,from:scope.from,to:scope.to});
      const result=await apiFetch<{content:unknown}>(`/api/planning/plans/${plan.id}/revisions/${version}?${params}`);
      const content=planContentSchema.parse(result.content);
      if(alive.current)setDraft({base:plan.version,key:crypto.randomUUID(),content});
    }catch{if(alive.current)setError('This revision could not be recovered.');}finally{if(alive.current)setBusy(false);}
  };
  return <section className="my-4 rounded-xl border border-slate-200 bg-white" aria-label="Task or goal plan">
    <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500" aria-label={draft ? 'Plan, unsaved draft' : 'Plan'} aria-expanded={open} onClick={() => setOpen(!open)}>
      <ClipboardList size={15} aria-hidden="true" /><span className="flex-1">Plan</span>{draft && <span className="text-[10px] text-slate-500">Unsaved</span>}<ChevronDown size={14} className={open ? 'rotate-180' : ''} />
    </button>
    {open && <div className="space-y-3 border-t border-slate-100 p-3 sm:p-4">
      {error && <p role="alert" className="text-sm text-amber-800">{error}</p>}
      {storageError && <p role="alert" className="text-xs text-amber-800">This browser could not preserve the unsaved draft. Keep this page open until you save.</p>}
      {busy && <p role="status" className="text-xs text-slate-500">Loading or saving plan…</p>}
      {!context && !busy && <button className={button} onClick={() => void load()}><RefreshCw size={14} />Retry</button>}
      {context && <>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500"><span className="max-w-full truncate rounded-md bg-slate-50 px-2 py-1">{root.kind}: {context.root.title}</span><span>{context.evidence.resources.length} linked sources{context.evidence.omitted ? ` · ${context.evidence.omitted} not shown` : ''}</span><span>Calendar context: all commitments</span></div>
        {!plan ? <div><p className="text-sm text-slate-500">Keep the outcome, approach, decisions and open questions for this {root.kind} together.</p><button className={button} disabled={busy} onClick={() => void create()}>Start planning</button></div> : <>
          <div className="flex items-center justify-between gap-2"><p className="text-xs text-slate-500">{plan.state === 'current' ? 'Saved plan' : plan.state === 'archived' ? 'Archived plan' : plan.state === 'stale' ? 'Context changed — review the plan' : 'Draft plan'} · revision {plan.version}</p><button className={button} disabled={busy} aria-label="Refresh plan" title="Refresh" onClick={() => void load()}><RefreshCw size={14}/></button></div>
          {plan.redacted_items > 0 && <p role="status" className="text-xs text-amber-800">Some source-based work is hidden because its evidence is unavailable or changed.</p>}
          {context.evaluations.map(row=><ScenarioStatus key={row.id} state={row.state} conditional={row.evaluation?.feasibility==='conditional'} assumptions={row.evaluation?.assumptions} onRefresh={()=>void load()}/>)}
          {conflict && <div role="alert" className="rounded-lg border border-amber-200 p-3 text-sm"><p>A newer revision is saved. Your draft from revision {draft!.base} is preserved.</p><details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-xs">Review the saved version</summary><p className="whitespace-pre-wrap">{plan.content.outcome}</p><p className="whitespace-pre-wrap">{plan.content.approach}</p></details><button className={button} disabled={busy} onClick={() => setDraft({ ...draft!,base:plan.version,key:crypto.randomUUID() })}>Use my draft as the next revision</button></div>}
          <label className="block text-xs text-slate-600">What does done look like?<textarea aria-label="Plan outcome" className={field} rows={2} maxLength={4000} value={content.outcome} disabled={busy || plan.state === 'archived'} onChange={e => change({outcome:e.target.value})}/></label>
          <label className="block text-xs text-slate-600">Approach<textarea aria-label="Plan approach" className={field} rows={3} maxLength={8000} value={content.approach} disabled={busy || plan.state === 'archived'} onChange={e => change({approach:e.target.value})}/></label>
          <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-slate-500">Decisions and open questions</summary>
            <label className="block text-xs text-slate-600">Decisions — one per line<LineField label="Plan decisions" value={content.decisions} disabled={busy || plan.state === 'archived'} onChange={decisions=>change({decisions})}/></label>
            <label className="mt-3 block text-xs text-slate-600">Open questions — one per line<LineField label="Plan questions" value={content.questions} disabled={busy || plan.state === 'archived'} onChange={questions=>change({questions})}/></label>
          </details>
          {content.work_items.map(item => <div key={item.reference.id} className="flex justify-between gap-3 text-sm"><span>{item.title}</span><span className="shrink-0 text-xs text-slate-500">{effortLabel(item.effort)}</span></div>)}
          <div className="flex flex-wrap items-center gap-1">
            <button className={button} disabled={busy} onClick={()=>void showHistory()}>History</button>
            {plan.state !== 'archived' ? <><button className={button} disabled={busy || !draft || conflict} onClick={() => void save()}>Save plan</button><button className={button} disabled={busy || Boolean(draft)} aria-label="Archive plan" title="Archive plan" onClick={() => void lifecycle('archive')}><Archive size={14}/></button></> : <><button className={button} disabled={busy} onClick={() => void lifecycle('restore')}><RotateCcw size={14}/>Restore plan</button><button className={button} disabled={busy} onClick={() => setForget(!forget)}>Forget plan content</button></>}
            {draft && <button className={button} disabled={busy} onClick={() => setDraft(null)}>Discard local draft</button>}
          </div>
          {history.length>0 && <details open><summary className="min-h-11 cursor-pointer py-3 text-xs text-slate-500">Recent revisions</summary>{history.map(row=><div key={row.version} className="flex items-center justify-between gap-2 text-xs text-slate-500"><span>Revision {row.version} · {row.operation} · {row.origin}</span><button className={button} disabled={busy || Boolean(draft) || plan.state==='archived'} onClick={()=>void recover(row.version)}>Load as draft</button></div>)}</details>}
          {forget && <div className="rounded-lg border border-slate-200 p-3 text-xs text-slate-600"><p>This clears saved plan text and work items from all its revisions. Tasks, resources and original files stay. Revision metadata and existing backups remain.</p><button className={button} disabled={busy} onClick={() => void lifecycle('forget')}>Confirm forget plan content</button><button className={button} onClick={() => setForget(false)}>Cancel</button></div>}
        </>}
      </>}
    </div>}
  </section>;
}
