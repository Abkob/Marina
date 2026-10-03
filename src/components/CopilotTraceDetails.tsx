import { readEvaluationTrace, TRACE_FAILURE_LABELS, TRACE_PHASE_LABELS } from '../../shared/evaluationTrace';

/** Small, optional diagnostics inside the existing response disclosure. */
export function CopilotTraceDetails({ value }: { value: unknown }) {
  const trace = readEvaluationTrace(value);
  if (!trace || Date.parse(trace.expires_at) <= Date.now()) return <p className="mt-2 text-xs text-slate-500">Detailed diagnostics are unavailable or have expired.</p>;
  const omissions = trace.dropped_events + trace.omitted_sources;
  return <section aria-label="Response phases" className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-600">
    <ol className="space-y-2">
      {trace.events.slice(0, 8).map(event => <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span>{TRACE_PHASE_LABELS[event.phase]}{event.failure ? ` · ${TRACE_FAILURE_LABELS[event.failure]}` : ` · ${event.status}`}</span>
        {event.duration_ms !== undefined && <span className="tabular-nums">{(event.duration_ms / 1000).toFixed(1)}s</span>}
      </li>)}
    </ol>
    {!trace.events.length && <p>No phase measurements were recorded.</p>}
    {trace.events.length > 8 && <p className="mt-2">{trace.events.length - 8} more phase measurements recorded.</p>}
    {omissions > 0 && <p className="mt-2">Diagnostics are partial: {omissions} event or source details omitted.</p>}
    {trace.storage !== 'saved' && <p className="mt-2">These diagnostics could not be saved. This does not establish whether your changes were saved.</p>}
    <details className="mt-1">
      <summary className="flex min-h-11 cursor-pointer items-center rounded px-1 text-[11px] text-slate-500 focus-visible:outline-2 focus-visible:outline-indigo-500">Diagnostic identifiers</summary>
      <div className="space-y-1 break-all rounded bg-white p-2 font-mono text-[10px]">
        <p>Request: {trace.request_id}</p><p>Configuration: {trace.config_hash}</p>
        {trace.run_id && <p>Run: {trace.run_id}</p>}
        <p>Trace format: {trace.version}</p>
        {trace.events.slice(8).map(event => <p key={event.id}>{TRACE_PHASE_LABELS[event.phase]} · {event.status}{event.failure ? ` · ${TRACE_FAILURE_LABELS[event.failure]}` : ''}</p>)}
      </div>
    </details>
  </section>;
}
