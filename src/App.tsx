import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Suspense, useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { apiFetch, setMutationListener } from './utils/apiFetch';

// Layout
import { Sidebar }   from './components/Sidebar';
import { Header }    from './components/Header';
import { MobileNav } from './components/MobileNav';
import { MobileHeader } from './components/MobileHeader';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from './hooks/useMediaQuery';
import { useMobileViewport } from './hooks/useMobileViewport';
import { useMobileNavigation } from './hooks/useMobileNavigation';
import { Toast }     from './components/Toast';
import { GoogleSyncPulse } from './components/GoogleSyncPulse';

// Views
import { CaptureView }      from './views/CaptureView';
import { GoalsDashboard }   from './views/GoalsDashboard';
import { GoalDetail }       from './views/GoalDetail';
import { TaskFocusView }    from './views/TaskFocusView';
import { WorkView }         from './views/WorkView';
import { ResourcesView }    from './views/ResourcesView';
import { SettingsView }     from './views/SettingsView';
import { CopilotView }      from './views/CopilotView';
import { GraphView }        from './views/GraphView';
import { TopicsView }       from './views/TopicsView';
import { ScheduleView }     from './views/ScheduleView';
import { MobileTimeline } from './views/MobileTimeline';
import { TestingView }      from './views/TestingView';
import { UsageManagerView } from './views/UsageManagerView';

// Modals
import { NewGoalWizard }    from './modals/NewGoalWizard';
import { NewNoteModal }     from './modals/NewNoteModal';
import { NewEventModal }    from './modals/NewEventModal';
import { AddResourceModal } from './modals/AddResourceModal';
import { ConfirmModal }            from './components/ConfirmModal';
import { CompletionReportModal }  from './modals/CompletionReportModal';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: 1,
    },
  },
});

// ── Global mutation → cache-invalidation map ──────────────────────────────────
// Every successful non-GET apiFetch invalidates the query keys its endpoint
// affects. Individual components used to (inconsistently) invalidate by hand;
// missing one meant stale UI until a manual refresh. This is the safety net
// that makes every write visible immediately, on every page.
const URL_INVALIDATION: Array<[RegExp, string[]]> = [
  [/^\/api\/tasks/,             ['tasks', 'goal-tasks', 'goals', 'goals-health', 'schedule-preview', 'data-readiness', 'task-notes', 'graph', 'entity-topics', 'topics']],
  [/^\/api\/goals/,             ['goals', 'goals-health', 'tasks', 'goal-tasks', 'schedule-preview', 'data-readiness', 'graph']],
  [/^\/api\/milestones/,        ['milestones', 'tasks', 'goals', 'goals-health', 'schedule-preview', 'graph']],
  [/^\/api\/goal-deadlines/,    ['deadlines', 'goals', 'goals-health', 'tasks', 'schedule-preview']],
  [/^\/api\/journal/,           ['journal', 'journal-links', 'work-sessions', 'tasks', 'goals', 'goals-health', 'schedule-preview', 'proposals', 'ai-proposals', 'graph', 'data-readiness', 'entity-topics', 'topics', 'topic-suggestions']],
  [/^\/api\/notes/,             ['notes']],
  [/^\/api\/resources/,         ['resources', 'resource-chunks', 'graph', 'data-readiness', 'entity-topics', 'topics']],
  [/^\/api\/meetings/,          ['meetings', 'meeting-task-links', 'schedule-preview']],
  [/^\/api\/events/,            ['events', 'event-task-links', 'schedule-preview']],
  [/^\/api\/edges/,             ['graph', 'resources', 'tasks', 'meeting-task-links', 'meetings', 'schedule-preview']],
  [/^\/api\/topics/,            ['topics', 'topic-suggestions', 'topic-members', 'entity-topics', 'graph-topic-members']],
  [/^\/api\/ai\/proposals/,     ['proposals', 'ai-proposals', 'tasks', 'goals', 'goals-health', 'milestones', 'schedule-preview', 'graph']],
  [/^\/api\/ai\/schedule/,      ['proposals', 'ai-proposals', 'tasks', 'goal-tasks', 'goals', 'goals-health', 'schedule-preview', 'events', 'event-task-links']],
  [/^\/api\/ai\/sessions/,      ['chat-sessions', 'proposals', 'ai-proposals']],
  [/^\/api\/work-sessions/,     ['work-sessions', 'work-session-stats', 'tasks', 'goals', 'goals-health', 'schedule-preview']],
  [/^\/api\/schedule-prefs/,    ['schedule-prefs', 'schedule-overrides', 'schedule-preview']],
  [/^\/api\/task-note-files/,   ['note-files']],
  [/^\/api\/event-task-links/,  ['event-task-links', 'events', 'schedule-preview']],
  [/^\/api\/entity-aliases/,    ['entity-aliases']],
];

const pendingInvalidations = new Map<string, number>();
let invalidationTimer: number | null = null;

function flushPendingInvalidations() {
  invalidationTimer = null;
  const entries = [...pendingInvalidations.entries()];
  pendingInvalidations.clear();

  for (const [key, queuedAt] of entries) {
    const queryKey = [key];
    const alreadyFetching = queryClient.isFetching({ queryKey }) > 0;
    const updatedSinceQueued = queryClient
      .getQueryCache()
      .findAll({ queryKey })
      .some(query => query.state.dataUpdatedAt >= queuedAt);

    if (alreadyFetching || updatedSinceQueued) continue;

    queryClient.invalidateQueries({
      queryKey,
      refetchType: 'active',
    });
  }
}

function queueInvalidation(key: string) {
  pendingInvalidations.set(key, Date.now());
  if (invalidationTimer !== null) return;
  invalidationTimer = window.setTimeout(flushPendingInvalidations, 160);
}

setMutationListener((_method, url) => {
  const path = url.split('?')[0];
  // Archiving/restoring a goal changes the visibility of every linked entity.
  if (/^\/api\/goals(?:\/|$)/.test(path)) void queryClient.invalidateQueries();
  const keysToInvalidate = new Set<string>();
  for (const [re, keys] of URL_INVALIDATION) {
    if (re.test(path)) {
      for (const key of keys) keysToInvalidate.add(key);
    }
  }
  if (keysToInvalidate.size === 0) keysToInvalidate.add('schedule-preview');

  for (const key of keysToInvalidate) {
    queueInvalidation(key);
  }
  if (!path.startsWith('/api/google/')) {
    window.dispatchEvent(new CustomEvent('marina:data-mutated', { detail: { path } }));
  }
});

function AppInner() {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  useMobileViewport();
  useMobileNavigation(isMobile);
  const {
    currentTab, selectedGoalId, focusedTaskId,
    setSelectedGoalId, setFocusedTaskId,
    newGoalModalOpen, newNoteModalOpen, newEventModalOpen, addResourceModalOpen,
    confirmOpen, sidebarCollapsed,
  } = useAppStore();

  // Validate that persisted selectedGoalId still exists
  useEffect(() => {
    if (!selectedGoalId) return;
    let cancelled = false;
    apiFetch(`/api/goals/${selectedGoalId}`)
      .catch((e: { status?: number }) => { if (!cancelled && e?.status === 404) setSelectedGoalId(null); });
    return () => { cancelled = true; };
  }, [selectedGoalId, setSelectedGoalId]);

  // Validate that persisted focusedTaskId still exists and belongs to the selected goal
  useEffect(() => {
    if (!selectedGoalId || !focusedTaskId) return;
    let cancelled = false;
    apiFetch<{ goal_id?: string }>(`/api/tasks/${focusedTaskId}`)
      .then((task) => { if (!cancelled && (!task || task.goal_id !== selectedGoalId)) setFocusedTaskId(null); })
      .catch(() => { if (!cancelled) setFocusedTaskId(null); });
    return () => { cancelled = true; };
  }, [selectedGoalId, focusedTaskId, setFocusedTaskId]);

  const renderContent = () => {
    if (currentTab === 'Copilot')   return <CopilotView />;
    if (currentTab === 'Brain Dump') return <CaptureView />;
    if (currentTab === 'Goals') {
      if (!selectedGoalId) return <GoalsDashboard />;
      return focusedTaskId ? <TaskFocusView /> : <GoalDetail />;
    }
    if (currentTab === 'Journal')   return <CaptureView />;
    if (currentTab === 'Graph')     return <GraphView />;
    if (currentTab === 'Topics')    return <TopicsView />;
    if (currentTab === 'Work')      return <WorkView />;
    if (currentTab === 'Schedule')  return <ScheduleView />;
    if (currentTab === 'Gantt')     return isMobile ? <MobileTimeline /> : <ScheduleView initialPage="timeline" />;
    if (currentTab === 'Testing')   return <TestingView />;
    if (currentTab === 'Usage')     return <UsageManagerView />;
    if (currentTab === 'Resources') return <ResourcesView />;
    if (currentTab === 'Settings')  return <SettingsView />;
    return null;
  };

  // Full-bleed tabs own their entire viewport below the header: no page
  // padding, no outer scroll — otherwise they become a scrollable "page
  // inside a page" with a dead white gutter underneath.
  const FULL_BLEED: ReadonlySet<string> = new Set(['Copilot', 'Graph']);
  const isFullBleed = FULL_BLEED.has(currentTab);

  return (
    <div className="bg-canvas-bg text-on-surface font-sans antialiased min-h-screen flex selection:bg-[#EEF2FF] selection:text-black">
      <GoogleSyncPulse />
      <Toast />
      {!isMobile && <Sidebar />}
      {!isMobile && <Header />}
      {isMobile && currentTab !== 'Copilot' && <MobileHeader />}
      <main
        data-page={currentTab}
        className={`app-main flex-1 min-w-0 w-full ${sidebarCollapsed ? 'md:pl-[64px]' : 'md:pl-[260px]'} transition-[padding] duration-200 overflow-x-hidden ${
          isFullBleed
            ? 'mobile-full-page pt-16 md:pt-16 h-screen overflow-y-hidden'
            : 'mobile-page pt-4 md:pt-[76px] pb-24 md:pb-8 min-h-screen'
        }`}
      >
        <AnimatePresence mode={isMobile ? 'sync' : 'wait'}>
          <motion.div
            key={currentTab + (selectedGoalId ?? '') + (focusedTaskId ?? '')}
            initial={isMobile ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: isMobile ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="app-page-content h-full min-w-0"
          >
            <Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading…</div>}>
              {renderContent()}
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>
      {isMobile && <MobileNav />}
      <AnimatePresence>
        {newGoalModalOpen     && <NewGoalWizard />}
        {newNoteModalOpen     && <NewNoteModal />}
        {newEventModalOpen    && <NewEventModal />}
        {addResourceModalOpen && <AddResourceModal />}
        {confirmOpen          && <ConfirmModal />}
        <CompletionReportModal />
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  );
}
