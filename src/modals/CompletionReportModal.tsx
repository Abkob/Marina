import { ModalFrame } from '../components/ModalFrame';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { CheckCircle, X } from 'lucide-react';
import { completeTask } from '../db/queries/tasks';
import { useAppStore } from '../store/useAppStore';

export function CompletionReportModal() {
  const { completionReportTaskId, closeCompletionReport, triggerToast } = useAppStore();
  const [note, setNote]     = useState('');
  const [busy, setBusy]     = useState(false);
  const textareaRef         = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (completionReportTaskId) {
      setNote('');
      setTimeout(() => textareaRef.current?.focus(), 80);
    }
  }, [completionReportTaskId]);

  const submit = async (skipNote = false) => {
    if (!completionReportTaskId || busy) return;
    setBusy(true);
    try {
      await completeTask(completionReportTaskId, skipNote ? '' : note.trim());
      triggerToast('Task completed.', 'success');
      closeCompletionReport();
    } finally {
      setBusy(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') closeCompletionReport();
  };

  return (
    <AnimatePresence>
      {completionReportTaskId && (
<ModalFrame titleId="completion-report-title" onClose={closeCompletionReport} initialFocusRef={textareaRef} className="mobile-sheet w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"><div onKeyDown={handleKey}>
            {/* Header */}
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
                <CheckCircle size={18} className="text-emerald-500" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="completion-report-title" className="font-bold text-gray-900 text-sm leading-tight">Task complete — how'd it go?</h2>
                <p className="text-xs text-gray-400 mt-0.5">Optional. Captured as a micro-retrospective on the task.</p>
              </div>
              <button aria-label="Close completion report" onClick={closeCompletionReport} className="text-gray-300 hover:text-gray-500 transition-colors mt-0.5">
                <X size={16} />
              </button>
            </div>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="What did you do? Any blockers, learnings, or things you'd do differently…"
              rows={4}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm
                text-gray-800 placeholder:text-gray-300 resize-none focus:outline-none
                focus:border-[#4648d4]/40 focus:bg-white transition-colors"
            />

            <p className="mt-1.5 text-[10px] font-mono text-gray-300 text-right">Ctrl+Enter to submit</p>

            {/* Actions */}
            <div className="mt-4 flex items-center gap-2 justify-end">
              <button
                onClick={() => submit(true)}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-xs font-mono text-gray-400 hover:text-gray-600
                  hover:bg-gray-100 transition-colors disabled:opacity-40"
              >
                Skip
              </button>
              <button
                onClick={() => submit(false)}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 text-white
                  hover:bg-emerald-600 active:scale-[0.98] transition-all disabled:opacity-40 shadow-sm"
              >
                {busy ? 'Saving…' : 'Mark Complete'}
              </button>
            </div>
          </div></ModalFrame>
      )}
    </AnimatePresence>
  );
}
