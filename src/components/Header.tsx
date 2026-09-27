import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Zap, Bell, X, Target, CheckSquare, FileText, BookOpen, Calendar, StickyNote } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '../store/useAppStore';
import { useSearch, useOrgInbox, useAllTasks, useGoals } from '../api/hooks';
import { apiFetch } from '../utils/apiFetch';
import { taskContextMap } from '../utils/taskContext';

interface ReadyResponse {
  status: 'ready' | 'degraded' | 'not_ready';
  db: string;
  models?: {
    primary?: { model: string; status: string };
    fallback?: { model: string; status: string };
    reachable?: boolean;
  };
  warnings?: string[];
}

const TYPE_ICONS: Record<string, typeof Target> = {
  goal: Target,
  task: CheckSquare,
  resource: BookOpen,
  journal_entry: FileText,
  meeting: Calendar,
  note: StickyNote,
};

/** Small debounce so typing doesn't fire a search per keystroke. */
function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function GlobalSearch({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void } = {}) {
  const { navigateToGoal, navigateToResource, setFocusedTaskId, setWorkTaskId, setCurrentTab, triggerToast } = useAppStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const debouncedQ = useDebounced(q, 250);
  const { data, isFetching } = useSearch(debouncedQ);
  const { data: tasks = [] } = useAllTasks();
  const { data: goals = [] } = useGoals();
  const contexts = useMemo(() => taskContextMap(tasks, goals), [tasks, goals]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const goTo = (r: { entity_type: string; entity_id: string; goal_id?: string | null; title: string }) => {
    setOpen(false);
    setQ('');
    onNavigate?.();
    if (r.entity_type === 'goal') return navigateToGoal(r.entity_id);
    if (r.entity_type === 'task' && r.goal_id) { navigateToGoal(r.goal_id); setFocusedTaskId(r.entity_id); return; }
    if (r.entity_type === 'task') { setWorkTaskId(r.entity_id); setCurrentTab('Work'); return; }
    if (r.entity_type === 'resource') return navigateToResource(r.entity_id);
    if (r.entity_type === 'journal_entry') return setCurrentTab('Journal');
    if (r.entity_type === 'note') return setCurrentTab('Brain Dump');
    if (r.entity_type === 'meeting' || r.entity_type === 'event') return setCurrentTab('Schedule');
    triggerToast(`No direct view for ${r.entity_type} yet — found "${r.title}"`, 'info');
  };

  const results = data?.results ?? [];

  return (
    <div ref={boxRef} className={mobile ? 'mobile-global-search relative' : 'relative group hidden lg:block'}>
      <Search className={`absolute left-3 text-gray-400 ${mobile ? 'top-4' : 'top-1/2 -translate-y-1/2'}`} size={mobile ? 18 : 14} />
      <input
        type="text"
        aria-label="Search everything"
        placeholder="Search everything…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => q && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setQ('');
          }
        }}
        className={mobile ? 'w-full rounded-2xl bg-slate-100 py-3 pl-10 pr-3 text-slate-900 outline-none focus:ring-2 focus:ring-indigo-200' : 'bg-[#f3f4f5] border-none rounded-full py-1.5 pl-9 pr-4 font-mono text-[11px] text-black placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-300 transition-all w-40 group-focus-within:w-64'}
      />
      {open && debouncedQ.trim() && (
        <div role="listbox" aria-label="Search results" className={mobile ? 'mt-3 max-h-[50dvh] overflow-y-auto rounded-xl border border-slate-100 py-1.5' : 'absolute top-9 right-0 w-80 max-h-96 overflow-y-auto bg-white shadow-2xl rounded-xl border border-gray-200 py-1.5 z-50'}>
          {isFetching && <p className="px-3 py-2 text-[11px] text-gray-400 font-mono">Searching…</p>}
          {!isFetching && results.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-gray-400 font-mono">No matches for “{debouncedQ}”</p>
          )}
          {data?.vector_degraded && (
            <p className="px-3 py-1 text-[10px] text-amber-600 font-mono border-b border-gray-100">
              Semantic search unavailable — showing keyword matches only
            </p>
          )}
          {results.map((r, i) => {
            const Icon = TYPE_ICONS[r.entity_type] ?? FileText;
            return (
              <button
                key={`${r.entity_type}-${r.entity_id ?? i}`}
                onClick={() => goTo(r)}
                role="option"
                aria-selected="false"
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-start gap-2.5"
              >
                <Icon size={13} className="text-gray-400 mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[12px] font-bold text-gray-900 truncate">{r.title}</span>
                  {r.entity_type === 'task' && contexts.get(r.entity_id) && <span className="mt-0.5 block truncate text-xs text-slate-500" title={contexts.get(r.entity_id)}>{contexts.get(r.entity_id)}</span>}
                  <span className="block text-[10px] font-mono text-gray-400 uppercase">{r.entity_type.replace('_', ' ')}</span>
                  {r.snippet && <span className="block text-[10px] text-gray-500 truncate mt-0.5">{r.snippet}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {mobile && !q && <p className="mt-4 text-sm leading-6 text-slate-500">Find goals, tasks, notes and resources by name or content.</p>}
    </div>
  );
}

function SystemStatusButton() {
  const { triggerToast } = useAppStore();
  const { data } = useQuery<ReadyResponse>({
    queryKey: ['health-ready'],
    queryFn: () => apiFetch<ReadyResponse>('/api/health/ready'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const degraded = data && data.status !== 'ready';
  const dotColor = !data ? 'bg-gray-300' : data.status === 'ready' ? 'bg-emerald-500' : 'bg-amber-500';

  const showDetails = () => {
    if (!data) return triggerToast('System status unknown — server unreachable?', 'error');
    const primary = data.models?.primary;
    const fallback = data.models?.fallback;
    const parts = [
      `DB: ${data.db}`,
      primary ? `model: ${primary.model} (${primary.status})` : null,
      fallback ? `fallback: ${fallback.model} (${fallback.status})` : null,
    ].filter(Boolean);
    const warning = data.warnings?.[0];
    triggerToast(warning ?? parts.join(' · '), degraded ? 'error' : 'success');
  };

  return (
    <button
      onClick={showDetails}
      title="System status"
      aria-label="Show system status"
      className="text-gray-400 hover:text-black transition-colors flex items-center justify-center w-8 h-8 rounded-full hover:bg-gray-100 relative"
    >
      <Zap size={15} />
      <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full border border-white ${dotColor}`} />
    </button>
  );
}

export function Header() {
  const {
    isNotificationOpen, setIsNotificationOpen, sidebarCollapsed,
  } = useAppStore();
  const { data: inbox } = useOrgInbox();
  const inboxTotal = inbox?.total ?? 0;

  useEffect(() => {
    if (!isNotificationOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsNotificationOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isNotificationOpen, setIsNotificationOpen]);

  return (
    <>
      <header className={`fixed top-0 right-0 left-0 ${sidebarCollapsed ? 'md:left-[64px]' : 'md:left-[260px]'} transition-[left] duration-200 h-16 z-40 bg-white/90 backdrop-blur-md hidden md:flex justify-between items-center px-6 border-b border-gray-100`}>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="font-headline text-lg font-black text-black tracking-tight">Marina</span>
            <div className="bg-[#EEF2FF] border border-[#c0c1ff]/40 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase text-[#4648d4] font-bold">
              OS 2.0
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <GlobalSearch />
          <SystemStatusButton />

          <button
            onClick={() => setIsNotificationOpen(!isNotificationOpen)}
            className="text-gray-400 hover:text-black transition-colors flex items-center justify-center w-8 h-8 rounded-full hover:bg-gray-100 relative"
            title="Organization inbox"
            aria-label={`Organization inbox${inboxTotal ? `, ${inboxTotal} items` : ''}`}
            aria-expanded={isNotificationOpen}
          >
            <Bell size={15} />
            {inboxTotal > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-[#EF4444] rounded-full border border-white" />
            )}
          </button>

          <div className="flex items-center gap-2 pl-2 border-l border-gray-100">
            <img
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuC77RLeDDakGJQ4MP9wYcxIvZx0LhA3x49A5xlJOg4S4uEo34dcUMSBQVhKcZBFlyy4DyGXswu_nmLlGrM96KKrsDwJqdiwgn3Fq-1eo360fT94FzZEXJWyGw3kA5xy1tcXh-Gg4OaNLhI4M59l6zGRFM5KFSYJoyowOybjI-zdIKlvmZsMT3OpWwBsr7ftzsvCJZ2rsyvmpgtTinuxohWed8GXUyi1k1-OEHrRZdXUVXtQTu_RRoElUV-UE_b0WSUfslNnagddlw"
              alt="user"
              className="w-8 h-8 rounded-full border border-gray-100 object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      </header>

      {/* Notification panel — real organization inbox, not canned content */}
      {isNotificationOpen && (
        <div role="dialog" aria-label="Organization inbox" className="fixed top-16 right-4 w-80 bg-white/95 backdrop-blur shadow-2xl rounded-xl border border-gray-200 p-4 z-50 animate-fade-in text-xs">
          <div className="flex justify-between items-center gap-2 mb-3 text-black font-bold uppercase font-mono tracking-wider border-b border-gray-100 pb-2">
            <span>Organization Inbox{inboxTotal ? ` (${inboxTotal})` : ''}</span>
            <button
              onClick={() => setIsNotificationOpen(false)}
              aria-label="Close organization inbox"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black"
            >
              <X size={14} />
            </button>
          </div>
          <div className="space-y-3 max-h-[320px] overflow-y-auto">
            {!inbox && <p className="text-gray-400 font-mono text-[11px]">Loading…</p>}
            {inbox && inbox.total === 0 && (
              <p className="text-gray-400 font-mono text-[11px]">Nothing needs your attention right now.</p>
            )}
            {inbox?.sections.filter(s => s.items.length).map(section => (
              <div key={section.bucket}>
                <p className="font-bold text-gray-700 mb-1">{section.label} ({section.items.length})</p>
                {section.items.slice(0, 5).map((item, i) => (
                  <p key={i} className="text-gray-500 truncate pl-2 py-0.5">
                    {String(item.title ?? item.fact_text ?? item.explanation ?? item.id ?? '')}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
