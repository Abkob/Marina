import { ModalFrame } from './ModalFrame';
import { useAppStore } from '../store/useAppStore';
import { useState } from 'react';

export function ConfirmModal() {
  const { confirmOpen, confirmMessage, confirmOnOk, closeConfirm } = useAppStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!confirmOpen) return null;

  const handleOk = async () => {
    if (pending) return;
    setPending(true); setError('');
    try { await confirmOnOk?.(); closeConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not finish. Please try again.'); }
    finally { setPending(false); }
  };
  const action = /^(Delete|Remove|Archive|Restore)\b/i.exec(confirmMessage)?.[1] ?? 'Confirm';

  return (
    <ModalFrame
      onClose={() => { if (!pending) closeConfirm(); }}
      titleId="confirm-modal-title"
      zClassName="z-[60]"
      overlayClassName="bg-black/50"
      className="bg-white rounded-xl border border-gray-200 shadow-2xl max-w-sm w-full p-6"
    >
      <h2 id="confirm-modal-title" className="sr-only">Confirm action</h2>
      <p className="text-sm font-semibold text-gray-800 leading-relaxed mb-6">{confirmMessage}</p>
      {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button
          onClick={closeConfirm}
          disabled={pending}
          className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-[#f8f9fa] hover:bg-gray-100 text-gray-500 font-semibold"
        >
          Cancel
        </button>
        <button
          onClick={handleOk}
          disabled={pending}
          className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-black text-white font-bold hover:opacity-90"
        >
          {pending ? 'Saving…' : action}
        </button>
      </div>
    </ModalFrame>
  );
}
