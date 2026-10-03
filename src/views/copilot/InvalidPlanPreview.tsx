import { RefreshCw } from 'lucide-react';
import { INVALID_PREVIEW_MESSAGE } from '../../../shared/calendarPlanContract';

export function InvalidPlanPreview({ onRetry }: { onRetry?: () => void }) {
  return <div role="alert" className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
    <p>{INVALID_PREVIEW_MESSAGE}</p>
    {onRetry && <button type="button" onClick={onRetry} className="mt-1 inline-flex min-h-11 min-w-11 items-center gap-2 rounded-lg px-2 text-xs text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
      <RefreshCw size={14} aria-hidden="true" /> Reload conversation
    </button>}
  </div>;
}
