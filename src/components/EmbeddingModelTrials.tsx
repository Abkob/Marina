import {useEffect, useRef, useState} from 'react';
import type {EmbeddingTrialOption, EmbeddingTrialResult} from '../../shared/embeddingTrial';
import {apiFetch} from '../utils/apiFetch';

export function EmbeddingModelTrials({options, disabled}: {options: EmbeddingTrialOption[]; disabled: boolean}) {
  const [selected, setSelected] = useState(options[0]?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EmbeddingTrialResult | null>(null);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const option = options.find(row => row.model === selected);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  async function run() {
    if (disabled || !option?.configured || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 50_000);
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await apiFetch<EmbeddingTrialResult>('/api/ai/embedding-models/trial', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model: selected}), signal: controller.signal,
      });
      if (active.current === controller) setResult(response);
    } catch {
      if (active.current === controller) setError(controller.signal.aborted
        ? 'The sample search timed out. You can try again.'
        : 'The sample search could not finish. Check the NVIDIA connection or try again later.');
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }
  if (!options.length) return null;
  return <details className="text-xs text-slate-500">
    <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-2 focus:outline-none focus:ring-2 focus:ring-indigo-400">Try a search model</summary>
    <div className="space-y-3 px-2 pb-2 pt-1">
      <label htmlFor="embedding-trial-model" className="block">Sample search model</label>
      <select id="embedding-trial-model" disabled={disabled || busy}
        className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        value={selected} onChange={event => {setSelected(event.target.value); setError(''); setResult(null);}}>
        {options.map(row => <option key={row.model} value={row.model}>{row.label}</option>)}
      </select>
      <p className="leading-relaxed">Uses six sample documents and three questions. Your library search index stays unchanged. Using this model for your library requires rebuilding its index.</p>
      {!option?.configured && <p role="status">Configure the NVIDIA connection to try this model.</p>}
      <button type="button" disabled={disabled || busy || !option?.configured} onClick={run} style={{minHeight:44}}
        className="min-h-11 rounded-lg px-2 text-slate-500 hover:text-slate-900 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-400">
        {busy ? 'Trying sample search…' : 'Try sample search'}
      </button>
      {result && <p role="status" className="leading-relaxed">Correct source matches: {result.correct_top_matches}/{result.total_queries} · {(result.elapsed_ms / 1000).toFixed(2)}s. This small trial does not establish overall quality or reliability.</p>}
      {error && <p role="alert" className="leading-relaxed text-amber-700">{error}</p>}
    </div>
  </details>;
}
