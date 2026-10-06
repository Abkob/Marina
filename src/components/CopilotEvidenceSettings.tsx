import type {EmbeddingTrialOption} from '../../shared/embeddingTrial';
import {EmbeddingModelTrials} from './EmbeddingModelTrials';

export type EvidenceModels = { reranker: string; vision: string; ocr: string; structure: string };
export type EvidenceModelCatalog = {
  defaults: EvidenceModels;
  options: Record<keyof EvidenceModels, Array<{ model: string; label: string }>>;
  embeddings: { model: string; label: string; change_requires_reindex: boolean; trials?: EmbeddingTrialOption[] };
};
const labels = { ocr: 'Read scanned text', vision: 'Understand images & charts', structure: 'Extract page structure', reranker: 'Rank search passages' };

export function CopilotEvidenceSettings({ catalog, value, disabled, onChange }: {
  catalog: EvidenceModelCatalog | null;
  value: Partial<EvidenceModels>;
  disabled: boolean;
  onChange: (value: Partial<EvidenceModels>) => void;
}) {
  if (!catalog) return <p className="text-xs text-slate-500" role="status">Document model choices are unavailable. Reopen this panel to retry.</p>;
  return <div className="space-y-4 border-t border-slate-100 pt-4">
    {(['ocr', 'structure', 'vision', 'reranker'] as const).map(role => <div key={role}>
      <label htmlFor={`copilot-${role}`} className="mb-1.5 block text-sm font-medium">{labels[role]}</label>
      <select id={`copilot-${role}`} className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" disabled={disabled}
        value={value[role] ?? catalog.defaults[role]} onChange={event => onChange({ ...value, [role]: event.target.value })}>
        {catalog.options[role].map(option => <option key={option.model} value={option.model}>{option.label}{option.model === catalog.defaults[role] ? ' · recommended' : ''}</option>)}
      </select>
    </div>)}
    <p className="text-xs leading-relaxed text-slate-500">Applies to your next message and is recorded with the reply. Selected pages and passages are sent to NVIDIA. Pages are inspected on request, not automatically across the library. If vision is busy, enabled OCR can return text with an explicit fallback notice.</p>
    <p className="text-xs leading-relaxed text-slate-500">Search index: {catalog.embeddings.label}. Changing the embedding model requires rebuilding the library index.</p>
    {catalog.embeddings.trials && <EmbeddingModelTrials options={catalog.embeddings.trials} disabled={disabled} />}
    <p className="text-xs leading-relaxed text-slate-500">Kimi and Muse can read text and layout as well as images. Their transcriptions have no OCR confidence scores or bounding boxes. Chat models can change without rebuilding the search index.</p>
    <button type="button" disabled={disabled} onClick={() => onChange({ ...catalog.defaults })} className="min-h-11 rounded-lg px-2 text-xs text-slate-500 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-400">Restore recommended document models</button>
  </div>;
}
