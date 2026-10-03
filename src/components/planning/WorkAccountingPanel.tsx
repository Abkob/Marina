import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiPatch } from '../../utils/apiFetch';
import { formatTaskTime } from '../../utils/taskTime';
import type { WorkAccounting } from '../../../shared/workAccounting';

export interface WorkAccountingResponse {
  work: WorkAccounting;
  window: { from: string; to: string };
  as_of: string;
  versions: { work: number; logs: number; forecast: number };
  forecast_updated_at: string | null;
}
const button = 'min-h-11 min-w-11 rounded-lg px-3 text-xs text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-40';
const minutes = (value: number | null) => value === null ? 'Unknown' : value === 0 ? '0 min' : formatTaskTime(value);

export function WorkAccountingPanel({ taskId }: { taskId: string }) {
  return <TaskWorkAccounting key={taskId} taskId={taskId} />;
}
function TaskWorkAccounting({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftVersions, setDraftVersions] = useState<WorkAccountingResponse['versions'] | null>(null);
  const cache = useQueryClient();
  const url = `/api/tasks/${encodeURIComponent(taskId)}/work-accounting`;
  const result = useQuery({ queryKey: ['tasks', taskId, 'work-accounting'], queryFn: () => apiFetch<WorkAccountingResponse>(url), staleTime: 10_000 });
  const data = result.data;
  useEffect(() => { setSaved(false); }, [draft]);
  const save = async (reset = false) => {
    if (!data || busy) return;
    const value = Number(draft);
    if (!reset && (!draft.trim() || !Number.isSafeInteger(value) || value < 0 || value > 60_000_000)) {
      setError('Enter a whole number of minutes, including 0 if no work remains.'); return;
    }
    setBusy(true); setError(''); setSaved(false);
    try {
      await apiPatch(url, { minutes: reset ? null : value, expected: reset ? data.versions : draftVersions ?? data.versions });
      await cache.invalidateQueries({ queryKey: ['tasks'] });
      await cache.invalidateQueries({ queryKey: ['schedule-preview'] });
      setSaved(true);
      setDraftVersions(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save. Your forecast is still in the field.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Work and calendar time" className="my-4 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">
    {result.isPending ? <p className="py-2 text-xs text-slate-500">Loading time details…</p> : result.isError ? <p role="alert" className="py-2 text-xs text-amber-700">Time details could not load. <button className={button} onClick={() => void result.refetch()}>Retry</button></p> : data && <>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2 sm:grid-cols-4">
        {([['Logged', data.work.logged_minutes], ['Work remaining', data.work.remaining_minutes], ['Reserved', data.work.reserved_minutes], ['Needs calendar time', data.work.unscheduled_minutes]] as const).map(([label, value]) => <div key={label}><p className="text-[11px] text-slate-500">{label}</p><p className="mt-1 font-medium text-slate-800">{minutes(value)}</p></div>)}
      </div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${button} -ml-3`}>Time details{data.work.remaining_state !== 'known' ? ' · review needed' : ''}</button>
      {open && <div className="border-t border-slate-100 py-3 text-xs leading-relaxed text-slate-600">
        <p>Own task only. Reservations cover {data.window.from}–{data.window.to}; reserved time is still work to do.</p>
        <p className="mt-2">{data.work.remaining_basis === 'forecast' ? `Your remaining-work forecast, saved ${data.forecast_updated_at?.slice(0, 10)}.` : data.work.remaining_basis === 'completed' ? 'This task is marked complete.' : data.work.remaining_state === 'overrun' ? 'The original estimate is exhausted, but this task is unfinished. Remaining work is unknown.' : data.work.remaining_state === 'stale_forecast' ? 'Your forecast needs review because the task or its work log changed.' : data.work.remaining_state === 'invalid' ? 'Some time data is invalid and needs correction.' : data.work.remaining_basis === 'estimate_minus_logged' ? 'Approximation: original estimate minus logged work. Time spent does not prove progress.' : 'No remaining-work estimate is available.'}</p>
        {data.work.stale_reservation_count > 0 && <p className="mt-2 text-amber-700">{data.work.stale_reservation_count} reservation(s) need review: changed work, ambiguous allocation, or outside the task’s dates. They still occupy the calendar.</p>}
        {data.work.remaining_basis !== 'completed' && <form onSubmit={event => { event.preventDefault(); void save(); }} className="mt-3">
          <label className="block" htmlFor={`forecast-${taskId}`}>Your current forecast (minutes remaining)</label>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <input id={`forecast-${taskId}`} type="number" min="0" max="60000000" step="1" value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setDraftVersions(previous => previous ?? data.versions); }} className="min-h-11 w-32 rounded-lg border border-slate-200 px-3 focus:outline-indigo-500" />
            <button type="submit" className={button} disabled={busy}>Save forecast</button>
            <button type="button" className={button} disabled={busy} onClick={() => void save(true)}>Use original estimate</button>
            <button type="button" className={button} disabled={busy} onClick={async () => {
              setError(''); const refreshed = await result.refetch();
              if (refreshed.data) setDraftVersions(refreshed.data.versions);
              await Promise.all([cache.invalidateQueries({ queryKey: ['tasks'] }), cache.invalidateQueries({ queryKey: ['work-sessions'] })]);
            }}>Refresh</button>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">This does not change your original estimate or mark the task complete. New or corrected logs require a forecast review.</p>
        </form>}
        {error && <p role="alert" className="mt-2 text-amber-700">{error}</p>}
        {saved && <p role="status" className="mt-2 text-emerald-700">Forecast saved.</p>}
      </div>}
    </>}
  </section>;
}
