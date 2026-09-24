import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';

const openDialogs: HTMLElement[] = [];
let previousBodyOverflow = '';
let phoneScrollLock: { top: string; position: string; width: string; scrollY: number } | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalFrameProps {
  children: ReactNode;
  onClose: () => void;
  titleId: string;
  className: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  zClassName?: string;
  overlayClassName?: string;
}

export function ModalFrame({
  children,
  onClose,
  titleId,
  className,
  initialFocusRef,
  zClassName = 'z-50',
  overlayClassName = 'bg-black/60',
}: ModalFrameProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (openDialogs.length === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
        phoneScrollLock = { top: document.body.style.top, position: document.body.style.position, width: document.body.style.width, scrollY: window.scrollY };
        document.body.style.position = 'fixed';
        document.body.style.top = `-${phoneScrollLock.scrollY}px`;
        document.body.style.width = '100%';
      }
    }
    openDialogs.push(dialog);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    (initialFocusRef?.current ?? focusables[0] ?? dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = openDialogs.indexOf(dialog);
      if (index !== -1) openDialogs.splice(index, 1);
      if (openDialogs.length === 0) {
        document.body.style.overflow = previousBodyOverflow;
        if (phoneScrollLock) {
          const saved = phoneScrollLock;
          document.body.style.top = saved.top;
          document.body.style.position = saved.position;
          document.body.style.width = saved.width;
          phoneScrollLock = null;
          window.scrollTo({ top: saved.scrollY, behavior: 'instant' });
        }
      }
      previous?.focus({ preventScroll: true });
    };
  }, [initialFocusRef]);

  return createPortal(
    <div
      className={`modal-overlay fixed inset-0 ${zClassName} ${overlayClassName} backdrop-blur-sm flex items-center justify-center p-4`}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className={`mobile-touch-modal ${className}`}
        onMouseDown={event => event.stopPropagation()}
      >
        {children}
      </motion.div>
    </div>, document.body
  );
}
