import { Timer } from 'lucide-react';
import { useCloudWorkTimer } from '../hooks/useCloudWorkTimer';
import { useAppStore } from '../store/useAppStore';

export function WorkTimerIndicator({ compact = false }: { compact?: boolean }) {
  const { timer, nowMs, error } = useCloudWorkTimer();
  const { setCurrentTab, setWorkTaskId } = useAppStore();
  if (!timer && !error) return null;
  const seconds = timer ? Math.max(0, Math.floor((nowMs - Date.parse(timer.startedAt)) / 1000)) : 0;
  const elapsed = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  const title = timer?.routineTitle ?? timer?.title ?? 'Focus timer';
  return <button
    onClick={() => { if (timer?.taskId) setWorkTaskId(timer.taskId); setCurrentTab('Work'); }}
    aria-label={timer ? `Open running timer for ${title}` : 'Open timer sync status'}
    title={error ?? `${title} · Synced across your devices`}
    className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 font-mono tabular-nums transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-gray-400 ${compact ? 'text-[10px] text-gray-400' : 'text-xs text-gray-500'}`}
  >
    <Timer size={compact ? 12 : 14} strokeWidth={1.5} className={error ? 'text-amber-600' : undefined} />
    {!compact && timer && <span className="max-w-28 truncate font-sans">{title}</span>}
    <span>{timer ? elapsed : 'Timer offline'}</span>
  </button>;
}
