import { useId, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { ModalFrame } from './ModalFrame';

export function MobileSheet({ title, onClose, children, initialFocusRef }: {
  title: string; onClose: () => void; children: ReactNode; initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  return <ModalFrame titleId={titleId} onClose={onClose} initialFocusRef={initialFocusRef} className="mobile-sheet w-full max-w-lg rounded-3xl bg-white p-5 text-slate-800 shadow-xl">
    <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-200" aria-hidden="true" />
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
      <button onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="mobile-icon-button shrink-0 text-slate-500"><X size={20} /></button>
    </div>
    {children}
  </ModalFrame>;
}
