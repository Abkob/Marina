import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tab = 'Copilot' | 'Brain Dump' | 'Goals' | 'Work' | 'Resources' | 'Gantt' | 'Journal' | 'Graph' | 'Topics' | 'Schedule' | 'Usage' | 'Settings' | 'Testing';

export interface ToastMsg {
  id: number;
  text: string;
  type: 'success' | 'info' | 'error';
}

type StoreUpdater<T> = T | ((current: T) => T);

export interface CopilotAttachmentState {
  id: string;
  title: string;
  indexing: boolean;
}

export interface CopilotStoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions?: unknown[];
  feasibility?: unknown;
  citations?: unknown[];
  plan?: unknown;
  planOptions?: unknown;
  scheduleDayView?: unknown;
  overdueTasksView?: unknown;
  runtime?: unknown;
  serverMsgId?: string;
  timestamp: string;
  error?: string;
}

const DEFAULT_GOAL_CATEGORIES = [
  'Work',
  'Personal',
  'Health',
  'Learning',
  'Home',
  'Money',
  'Creative',
  'Admin',
];

interface AppStore {
  // ─── Navigation (persisted) ───────────────────────────────────────────────
  currentTab:        Tab;
  selectedGoalId:    string | null;
  focusedTaskId:     string | null;
  workTaskId:        string | null;
  focusedResourceId: string | null;
  activeNoteId:      string;
  goalsFilter:       'Active' | 'Completed' | 'Archived';
  searchQuery:       string;
  goalCategories:    string[];

  // ─── Schedule UI (persisted) ──────────────────────────────────────────────
  selectedEventId: string | null;
  isDrawerOpen:    boolean;

  // ─── App chrome (persisted) ───────────────────────────────────────────────
  sidebarCollapsed: boolean;

  // ─── Ephemeral UI ─────────────────────────────────────────────────────────
  isOptimizing:    boolean;
  toast:           ToastMsg | null;
  isNotificationOpen: boolean;
  spotlightTaskId: string | null;
  spotlightDeadlineId: string | null;

  // ─── Copilot live state (persisted) ───────────────────────────────────────
  copilotActiveSessionId: string | null;
  copilotDraft: string;
  copilotMessages: CopilotStoredMessage[];
  copilotAttachment: CopilotAttachmentState | null;

  // ─── Modals ───────────────────────────────────────────────────────────────
  newGoalModalOpen:     boolean;
  newNoteModalOpen:     boolean;
  newEventModalOpen:    boolean;
  addResourceModalOpen: boolean;
  addResourceGoalId:    string | null;
  goalTitlePrefill:     string;

  // ─── Brain Dump OO trigger ────────────────────────────────────────────────
  isOOPopupOpen: boolean;
  ooContextText: string;

  // ─── Setters ──────────────────────────────────────────────────────────────
  setCurrentTab:        (tab: Tab) => void;
  setSelectedGoalId:    (id: string | null) => void;
  setFocusedTaskId:     (id: string | null) => void;
  setWorkTaskId:        (id: string | null) => void;
  setFocusedResourceId: (id: string | null) => void;
  /** Atomically navigate to a goal detail page — avoids the two-set race where
   *  setCurrentTab clears selectedGoalId before setSelectedGoalId restores it. */
  navigateToGoal:       (goalId: string) => void;
  navigateToResource:   (resourceId: string) => void;
  setActiveNoteId:      (id: string) => void;
  setGoalsFilter:       (f: 'Active' | 'Completed' | 'Archived') => void;
  setSearchQuery:       (q: string) => void;
  addGoalCategory:      (name: string) => void;
  removeGoalCategory:   (name: string) => void;
  setSelectedEventId:   (id: string | null) => void;
  setIsDrawerOpen:      (open: boolean) => void;
  toggleSidebar:        () => void;
  setIsOptimizing:      (v: boolean) => void;
  setIsNotificationOpen:(open: boolean) => void;
  setTaskSpotlight:     (taskId: string | null) => void;
  setDeadlineSpotlight: (deadlineId: string | null) => void;
  clearSpotlight:       () => void;
  setCopilotActiveSessionId: (id: string | null) => void;
  setCopilotDraft:           (draft: string) => void;
  setCopilotMessages:        (messages: StoreUpdater<CopilotStoredMessage[]>) => void;
  setCopilotAttachment:      (attachment: StoreUpdater<CopilotAttachmentState | null>) => void;
  clearCopilotConversation:  () => void;

  // ─── Toast ────────────────────────────────────────────────────────────────
  triggerToast: (text: string, type?: ToastMsg['type']) => void;
  clearToast:   () => void;

  // ─── Modal controls ───────────────────────────────────────────────────────
  openNewGoalModal:     (titlePrefill?: string) => void;
  closeNewGoalModal:    () => void;
  openNewNoteModal:     () => void;
  closeNewNoteModal:    () => void;
  openNewEventModal:    () => void;
  closeNewEventModal:   () => void;
  openAddResourceModal: (goalId: string) => void;
  closeAddResourceModal:() => void;

  // ─── OO popup ─────────────────────────────────────────────────────────────
  triggerOOPopup: (contextText: string) => void;
  closeOOPopup:   () => void;

  // ─── Confirm dialog ───────────────────────────────────────────────────────
  confirmOpen:    boolean;
  confirmMessage: string;
  confirmOnOk:    (() => void) | null;
  showConfirm:    (message: string, onOk: () => void) => void;
  closeConfirm:   () => void;

  // ─── Completion report modal ──────────────────────────────────────────────
  completionReportTaskId: string | null;
  openCompletionReport:   (taskId: string) => void;
  closeCompletionReport:  () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // ─── Initial UI state ────────────────────────────────────────────────
      currentTab:        'Goals',
      selectedGoalId:    null,
      focusedTaskId:     null,
      workTaskId:        null,
      focusedResourceId: null,
      activeNoteId:      '',
      goalsFilter:     'Active',
      searchQuery:     '',
      goalCategories:  DEFAULT_GOAL_CATEGORIES,

      selectedEventId: null,
      isDrawerOpen:    true,

      sidebarCollapsed: false,

      isOptimizing:       false,
      toast:              null,
      isNotificationOpen: false,
      spotlightTaskId:    null,
      spotlightDeadlineId:null,
      copilotActiveSessionId: null,
      copilotDraft: '',
      copilotMessages: [],
      copilotAttachment: null,

      newGoalModalOpen:     false,
      newNoteModalOpen:     false,
      newEventModalOpen:    false,
      addResourceModalOpen: false,
      addResourceGoalId:    null,
      goalTitlePrefill:     '',

      isOOPopupOpen: false,
      ooContextText: '',

      confirmOpen:    false,
      confirmMessage: '',
      confirmOnOk:    null,

      completionReportTaskId: null,

      // ─── Setters ──────────────────────────────────────────────────────────
      setCurrentTab:         (tab)  => set({ currentTab: tab, selectedGoalId: null, focusedTaskId: null }),
      setSelectedGoalId:     (id)   => set({ selectedGoalId: id, focusedTaskId: null }),
      setFocusedTaskId:      (id)   => set({ focusedTaskId: id }),
      setWorkTaskId:         (id)   => set({ workTaskId: id }),
      setFocusedResourceId:  (id)   => set({ focusedResourceId: id }),
      navigateToGoal:        (goalId) => set({ currentTab: 'Goals', selectedGoalId: goalId, focusedTaskId: null }),
      navigateToResource:    (resourceId) => set({ currentTab: 'Resources', focusedResourceId: resourceId }),
      setActiveNoteId:       (id)   => set({ activeNoteId: id }),
      setGoalsFilter:        (f)    => set({ goalsFilter: f }),
      setSearchQuery:        (q)    => set({ searchQuery: q }),
      addGoalCategory:       (name) => set((s) => {
        const trimmed = name.trim();
        if (!trimmed) return {};
        const exists = s.goalCategories.some(c => c.toLowerCase() === trimmed.toLowerCase());
        if (exists) return {};
        return { goalCategories: [...s.goalCategories, trimmed] };
      }),
      removeGoalCategory:    (name) => set((s) => {
        if (s.goalCategories.length <= 1) return {};
        return { goalCategories: s.goalCategories.filter(c => c !== name) };
      }),
      setSelectedEventId:    (id)   => set({ selectedEventId: id }),
      setIsDrawerOpen:       (open) => set({ isDrawerOpen: open }),
      toggleSidebar:         () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setIsOptimizing:       (v)    => set({ isOptimizing: v }),
      setIsNotificationOpen: (open) => set({ isNotificationOpen: open }),
      setTaskSpotlight:      (taskId) => set({ spotlightTaskId: taskId, spotlightDeadlineId: null }),
      setDeadlineSpotlight:  (deadlineId) => set({ spotlightDeadlineId: deadlineId, spotlightTaskId: null }),
      clearSpotlight:        () => set({ spotlightTaskId: null, spotlightDeadlineId: null }),
      setCopilotActiveSessionId: (id) => set({ copilotActiveSessionId: id }),
      setCopilotDraft:           (draft) => set({ copilotDraft: draft }),
      setCopilotMessages:        (messages) => set((s) => ({
        copilotMessages: typeof messages === 'function' ? messages(s.copilotMessages) : messages,
      })),
      setCopilotAttachment:      (attachment) => set((s) => ({
        copilotAttachment: typeof attachment === 'function' ? attachment(s.copilotAttachment) : attachment,
      })),
      clearCopilotConversation:  () => set({
        copilotActiveSessionId: null,
        copilotDraft: '',
        copilotMessages: [],
        copilotAttachment: null,
      }),

      // ─── Toast ────────────────────────────────────────────────────────────
      triggerToast: (text, type = 'success') => {
        const id = Date.now();
        set({ toast: { id, text, type } });
        setTimeout(() => {
          set((s) => (s.toast?.id === id ? { toast: null } : {}));
        }, 4000);
      },
      clearToast: () => set({ toast: null }),

      // ─── Modal controls ───────────────────────────────────────────────────
      openNewGoalModal:      (titlePrefill = '') =>
        set({ newGoalModalOpen: true, goalTitlePrefill: titlePrefill }),
      closeNewGoalModal:     () => set({ newGoalModalOpen: false, goalTitlePrefill: '' }),
      openNewNoteModal:      () => set({ newNoteModalOpen: true }),
      closeNewNoteModal:     () => set({ newNoteModalOpen: false }),
      openNewEventModal:     () => set({ newEventModalOpen: true }),
      closeNewEventModal:    () => set({ newEventModalOpen: false }),
      openAddResourceModal:  (goalId) =>
        set({ addResourceModalOpen: true, addResourceGoalId: goalId }),
      closeAddResourceModal: () =>
        set({ addResourceModalOpen: false, addResourceGoalId: null }),

      // ─── OO popup ─────────────────────────────────────────────────────────
      triggerOOPopup: (contextText) => set({ isOOPopupOpen: true, ooContextText: contextText }),
      closeOOPopup:   ()            => set({ isOOPopupOpen: false, ooContextText: '' }),

      showConfirm:  (message, onOk) => set({ confirmOpen: true, confirmMessage: message, confirmOnOk: onOk }),
      closeConfirm: ()              => set({ confirmOpen: false, confirmMessage: '', confirmOnOk: null }),

      openCompletionReport:  (taskId) => set({ completionReportTaskId: taskId }),
      closeCompletionReport: ()       => set({ completionReportTaskId: null }),
    }),
    {
      name: 'marina-os-ui-v1',
      // Persist navigation, schedule drawer, and Copilot live-session state.
      partialize: (state) => ({
        currentTab:        state.currentTab,
        activeNoteId:      state.activeNoteId,
        selectedGoalId:    state.selectedGoalId,
        focusedTaskId:     state.focusedTaskId,
        workTaskId:        state.workTaskId,
        focusedResourceId: state.focusedResourceId,
        selectedEventId:   state.selectedEventId,
        isDrawerOpen:      state.isDrawerOpen,
        sidebarCollapsed:  state.sidebarCollapsed,
        goalsFilter:       state.goalsFilter,
        goalCategories:    state.goalCategories,
        copilotActiveSessionId: state.copilotActiveSessionId,
        copilotDraft:           state.copilotDraft,
        copilotAttachment:      state.copilotAttachment,
      }),
    }
  )
);
