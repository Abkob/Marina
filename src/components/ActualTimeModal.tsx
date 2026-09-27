import { useRef, useState } from 'react';
import { Check, Clock, X } from 'lucide-react';
import { formatTaskTime, parseTaskTimeInput } from '../utils/taskTime';
import { ModalFrame } from './ModalFrame';

interface Props {
  taskTitle: string;
  estimatedMinutes: number | null | undefined;
  onLog: (actualMinutes: number) => void;
  onSkip: () => void;
}

export function ActualTimeModal({ taskTitle, estimatedMinutes, onLog, onSkip }: Props) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleLog = () => {
    const t = draft.trim();
    if (!t) return;
    const parsed = parseTaskTimeInput(t);
    if (parsed !== null) onLog(parsed);
  };

  return (
    <ModalFrame
      onClose={onSkip}
      titleId="actual-time-modal-title"
      overlayClassName="bg-black/40"
      className="w-full max-w-sm mx-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-2xl"
      initialFocusRef={inputRef}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100">
            <Check size={14} className="text-emerald-600" />
          </span>
          <h2 id="actual-time-modal-title" className="font-mono text-[10px] font-bold uppercase tracking-widest text-emerald-600">
            Task Complete
          </h2>
        </div>
        <button
          onClick={onSkip}
          aria-label="Skip actual time entry"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500"
        >
          <X size={14} />
        </button>
      </div>

      <p className="text-sm font-bold text-gray-900 leading-snug mb-1 line-clamp-2">
        {taskTitle}
      </p>

      {estimatedMinutes != null && (
        <p className="font-mono text-[10px] text-gray-400 mb-4">
          Estimated: <span className="text-gray-600 font-semibold">{formatTaskTime(estimatedMinutes)}</span>
        </p>
      )}
      {estimatedMinutes == null && <div className="mb-4" />}

      <label htmlFor="actual-time-input" className="block font-mono text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">
        How long did it actually take?
      </label>
      <div className="relative mb-4">
        <Clock size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
        <input
          id="actual-time-input"
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value.replace(/[^\d.hm\s]/gi, ''))}
          onKeyDown={e => { if (e.key === 'Enter') handleLog(); }}
          placeholder="e.g. 1h 30m, 45m, 2h"
          className="w-full rounded-xl border border-gray-200 bg-[#f8f9fa] pl-8 pr-3 py-2.5 text-sm text-gray-800 outline-none focus:border-[#4648d4] focus:bg-white transition-all placeholder:text-gray-300"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={onSkip}
          className="flex-1 rounded-xl border border-gray-200 bg-white py-2 text-[11px] font-mono font-bold uppercase tracking-wider text-gray-500 hover:bg-gray-50 transition-colors"
        >
          Skip
        </button>
        <button
          onClick={handleLog}
          disabled={!draft.trim()}
          className="flex-1 rounded-xl bg-[#4648d4] py-2 text-[11px] font-mono font-bold uppercase tracking-wider text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          Log Time
        </button>
      </div>
    </ModalFrame>
  );
}
