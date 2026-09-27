import { AnimatePresence, motion } from 'motion/react';
import { useAppStore } from '../store/useAppStore';

export function Toast() {
  const { toast } = useAppStore();

  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.id}
          initial={{ opacity: 0, y: -8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.96 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          role="status" aria-live="polite" className="mobile-toast fixed top-20 right-4 z-[60] flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg border border-black/10 bg-white"
        >
          <span
            className={`w-2 h-2 rounded-full animate-ping ${
              toast.type === 'success'
                ? 'bg-[#10B981]'
                : toast.type === 'error'
                ? 'bg-[#EF4444]'
                : 'bg-[#6063ee]'
            }`}
          />
          <span className="text-xs font-semibold font-mono uppercase tracking-wider text-black mr-1 bg-[#f3f4f5] py-0.5 px-1.5 rounded">
            {toast.type}
          </span>
          <p className="text-sm font-medium text-gray-800">{toast.text}</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
