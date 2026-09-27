import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '../hooks/useMediaQuery';

/** Secondary detail stays available without pushing the main phone action away. */
export function MobileDisclosure({ title, description, storageKey, children, defaultOpen = false }: {
  title: string; description?: string; storageKey: string; children: ReactNode; defaultOpen?: boolean;
}) {
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [open, setOpen] = useState(() => {
    try { const value = window.localStorage.getItem(`marina-section:${storageKey}`); return value === null ? defaultOpen : value === 'open'; }
    catch { return defaultOpen; }
  });
  if (!mobile) return <>{children}</>;
  return <details className="mobile-disclosure" open={open} onToggle={event => {
    const next = event.currentTarget.open;
    setOpen(next);
    try { window.localStorage.setItem(`marina-section:${storageKey}`, next ? 'open' : 'closed'); } catch { /* Private browsing still works. */ }
  }}>
    <summary><span className="min-w-0"><span className="block text-sm font-semibold">{title}</span>{description && <span className="mt-1 block text-xs font-normal text-slate-500">{description}</span>}</span><ChevronDown size={18} className="mobile-disclosure-chevron shrink-0" /></summary>
    <div className="mobile-disclosure-content">{open && children}</div>
  </details>;
}
