import { usePersistentDraft } from '../hooks/usePersistentDraft';
import { MobileDisclosure } from '../components/MobileDisclosure';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, Circle, Clock, FileText, Paperclip, Play, Plus, Search,
  Square, Timer, Trash2, Upload, X,
} from 'lucide-react';
import {
  useAllTasks, useCreateWorkSession, useDeleteWorkSession, useAllGoals,
  useInvalidate, useNoteFiles, useTask, useTaskNotes, useTaskWorkSessions,
} from '../api/hooks';
import { EntityTopicChips } from '../components/EntityTopicChips';
import { TaskTree } from '../components/TaskTree';
import { FileViewerModal } from '../components/FileViewerModal';
import { useAppStore } from '../store/useAppStore';
import type { DBTask, DBTaskNote, DBTaskNoteFile } from '../db/schema';
import { addTaskNote, deleteTaskNote, toggleTask, touchTask } from '../db/queries/tasks';
import { addNoteFile, deleteNoteFile } from '../db/queries/noteFiles';
import { formatTaskTime, getRolledUpActualTime, getRolledUpTime } from '../utils/taskTime';
import { getEffectiveTaskDueDate, getInheritedTaskDueDate } from '../utils/taskDates';
import { getWorkTasks } from '../utils/taskTree';
import { readActiveWorkTimer, writeActiveWorkTimer, WORK_TIMER_STORAGE_KEY, type ActiveWorkTimer } from '../utils/workTimer';
import { apiPost } from '../utils/apiFetch';

function formatStopwatch(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function toDateTimeLocal(value: string | Date) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatSessionDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function FileChip({ file, onView }: { file: DBTaskNoteFile; onView: () => void }) {
  const invalidate = useInvalidate();
  const { triggerToast } = useAppStore();
  const isViewable = file.mime_type.startsWith('image/') || file.mime_type === 'application/pdf';

  const remove = async () => {
    await deleteNoteFile(file.id);
    invalidate.noteFiles(file.note_id);
    triggerToast('File removed.', 'info');
  };

  return (
    <span className="group/file inline-flex max-w-full items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] shadow-sm">
      <FileText size={11} className="shrink-0 text-gray-400" />
      <button
        onClick={isViewable ? onView : undefined}
        className={`min-w-0 truncate font-medium ${isViewable ? 'text-gray-700 hover:text-[#4648d4]' : 'text-gray-500'}`}
        title={file.name}
        aria-label={isViewable ? `Open file ${file.name}` : file.name}
      >
        {file.name}
      </button>
      <button onClick={remove} className="flex h-6 w-6 items-center justify-center rounded-md text-gray-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-400 group-hover/file:opacity-100 focus:opacity-100" aria-label={`Remove file ${file.name}`}>
        <X size={10} />
      </button>
    </span>
  );
}

function WorkNoteItem({
  note,
  onDelete,
  onViewFile,
}: {
  note: DBTaskNote;
  onDelete: () => void;
  onViewFile: (file: DBTaskNoteFile) => void;
}) {
  const { data: files = [] } = useNoteFiles(note.id);

  return (
    <article className="group/note border-b border-gray-100 py-3 last:border-0">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <time className="font-mono text-[9px] uppercase tracking-widest text-gray-300">
          {formatSessionDate(note.created_at)} {new Date(note.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </time>
        <button onClick={onDelete} className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-200 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-400 group-hover/note:opacity-100 focus:opacity-100" aria-label="Delete work note">
          <Trash2 size={12} />
        </button>
      </div>
      {note.content && note.content !== '-' && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{note.content}</p>
      )}
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map(file => (
            <FileChip key={file.id} file={file} onView={() => onViewFile(file)} />
          ))}
        </div>
      )}
    </article>
  );
}

export function WorkView() {
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const {
    workTaskId,
    setWorkTaskId,
    triggerToast,
    showConfirm,
    setCurrentTab,
  } = useAppStore();
  const invalidate = useInvalidate();
  const queryClient = useQueryClient();
  const { data: taskData, isPlaceholderData: tasksPlaceholder } = useAllTasks();
  const { data: goalData, isPlaceholderData: goalsPlaceholder } = useAllGoals();
  const allTasks = taskData ?? [];
  const goals = goalData ?? [];
  const tasksReady = taskData !== undefined && goalData !== undefined && !tasksPlaceholder && !goalsPlaceholder;
  const { data: selectedTask } = useTask(workTaskId);
  const { data: notes = [] } = useTaskNotes(workTaskId);
  const { data: sessions = [] } = useTaskWorkSessions(workTaskId);
  const createSession = useCreateWorkSession();
  const deleteSession = useDeleteWorkSession();

  const [activeTimer, setActiveTimer] = useState<ActiveWorkTimer | null>(readActiveWorkTimer);
  const [nowMs, setNowMs] = useState(Date.now());
  const [timerNotes, setTimerNotes] = useState(activeTimer?.notes ?? '');
  const [savingTimer, setSavingTimer] = useState(false);
  const stoppingTimerRef = useRef(false);
  const [adjustRoutineTime, setAdjustRoutineTime] = useState(false);
  const [routineMinutesToSave, setRoutineMinutesToSave] = useState('');
  const [routineTimeError, setRoutineTimeError] = useState('');
  const [manualMinutes, setManualMinutes] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualWhen, setManualWhen] = useState(() => toDateTimeLocal(new Date()));
  const [journalDraft, setJournalDraft] = usePersistentDraft(`work:${workTaskId ?? 'none'}`);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [viewingFile, setViewingFile] = useState<DBTaskNoteFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    writeActiveWorkTimer(activeTimer);
  }, [activeTimer]);

  useEffect(() => {
    setAdjustRoutineTime(false);
    setRoutineMinutesToSave('');
    setRoutineTimeError('');
  }, [activeTimer?.sessionId, activeTimer?.taskId]);

  useEffect(() => {
    const syncTimer = (event: StorageEvent) => {
      if (event.key === WORK_TIMER_STORAGE_KEY) setActiveTimer(readActiveWorkTimer());
    };
    window.addEventListener('storage', syncTimer);
    return () => window.removeEventListener('storage', syncTimer);
  }, []);

  useEffect(() => {
    if (!activeTimer) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeTimer]);

  const goalById = useMemo(() => new Map(goals.map(g => [g.id, g])), [goals]);
  const workTasks = useMemo(() => tasksReady ? getWorkTasks(allTasks, goals) : [], [allTasks, goals, tasksReady]);
  const taskOptions = useMemo(() => {
    return [...workTasks]
      .sort((a, b) => {
        const ap = a.status === 'in_progress' ? 0 : a.completed ? 2 : 1;
        const bp = b.status === 'in_progress' ? 0 : b.completed ? 2 : 1;
        if (ap !== bp) return ap - bp;
        return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.title.localeCompare(b.title);
      });
  }, [workTasks]);

  useEffect(() => {
    if (!tasksReady || taskOptions.some(task => task.id === workTaskId)) return;
    const starter = taskOptions.find(t => t.status === 'in_progress' && !t.completed) ?? taskOptions.find(t => !t.completed);
    const nextId = starter?.id ?? null;
    if (nextId !== workTaskId) setWorkTaskId(nextId);
  }, [workTaskId, taskOptions, setWorkTaskId, tasksReady]);

  const eligibleTask = taskOptions.find(t => t.id === workTaskId);
  const currentTask = eligibleTask ? (selectedTask?.id === workTaskId ? selectedTask : eligibleTask) : null;
  const timerTask = activeTimer ? allTasks.find(t => t.id === activeTimer.taskId) ?? null : null;
  const activeRoutine = activeTimer?.routineId ? activeTimer : null;
  const timerTitle = activeRoutine?.routineTitle ?? workTasks.find(task => task.id === activeTimer?.taskId)?.title ?? 'your task';
  const currentGoal = currentTask?.goal_id ? goalById.get(currentTask.goal_id) ?? null : null;
  const effectiveDueDate = currentTask ? getEffectiveTaskDueDate(currentTask, allTasks) : null;
  const inheritedDueDate = currentTask ? getInheritedTaskDueDate(currentTask, allTasks) : null;
  const directLogged = sessions.reduce((sum, s) => sum + (s.minutes ?? 0), 0);
  const actualRollup = currentTask ? getRolledUpActualTime(currentTask, allTasks) : null;
  const totalLogged = actualRollup?.minutes ?? directLogged;
  const estimated = currentTask ? getRolledUpTime(currentTask, allTasks).minutes : null;
  const progress = estimated ? Math.round((totalLogged / estimated) * 100) : null;

  const startTimer = async () => {
    if (!currentTask || activeTimer) return;
    const existingTimer = readActiveWorkTimer();
    if (existingTimer) {
      setActiveTimer(existingTimer);
      triggerToast('A focus timer is already running. Stop it before starting another.', 'info');
      return;
    }
    const next = { taskId: currentTask.id, startedAt: new Date().toISOString(), notes: timerNotes.trim() };
    writeActiveWorkTimer(next);
    setActiveTimer(next);
    setTimerNotes('');
    triggerToast('Timer started.', 'success');
    await touchTask(currentTask.id).catch(() => {});
  };

  const stopTimer = async () => {
    if (!activeTimer || stoppingTimerRef.current) return;
    const started = new Date(activeTimer.startedAt);
    const ended = new Date();
    const elapsedMinutes = Math.max(1, Math.round((ended.getTime() - started.getTime()) / 60_000));
    let minutes = elapsedMinutes;
    if (activeTimer.routineId && (adjustRoutineTime || elapsedMinutes > 1440)) {
      const actualMinutes = Number(routineMinutesToSave);
      if (!routineMinutesToSave || !Number.isInteger(actualMinutes) || actualMinutes < 1 || actualMinutes > 1440
        || actualMinutes > Math.ceil((ended.getTime() - started.getTime()) / 60_000) + 1) {
        setAdjustRoutineTime(true);
        setRoutineTimeError('Enter the minutes you actually focused: 1–1440, no more than the elapsed session. Your timer has not been discarded.');
        return;
      }
      minutes = actualMinutes;
    }
    setRoutineTimeError('');
    stoppingTimerRef.current = true;
    setSavingTimer(true);
    try {
      let savedMinutes = minutes;
      if (activeTimer.routineId) {
        const saved = await apiPost<{ minutes: number }>(`/api/routines/${encodeURIComponent(activeTimer.routineId)}/sessions`, {
          id: activeTimer.sessionId,
          date: activeTimer.routineDate,
          started_at: started.toISOString(),
          ended_at: ended.toISOString(),
          minutes,
          notes: activeTimer.notes || undefined,
        });
        savedMinutes = saved.minutes;
        for (const key of ['routines', 'routine-entries', 'schedule-preview', 'work-sessions', 'work-session-stats']) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      } else {
        await createSession.mutateAsync({
          task_id: activeTimer.taskId,
          goal_id: timerTask?.goal_id ?? null,
          started_at: started.toISOString(),
          ended_at: ended.toISOString(),
          minutes,
          notes: activeTimer.notes || undefined,
          source: 'timer',
        });
      }
      writeActiveWorkTimer(null);
      setActiveTimer(null);
      triggerToast(`Logged ${formatTaskTime(savedMinutes)}${activeTimer.routineId ? ' to your routine' : ''}.`, 'success');
    } catch (error) {
      triggerToast(`Time not saved. Your timer is still available; try Stop again. ${error instanceof Error ? error.message : ''}`.trim(), 'error');
    } finally {
      stoppingTimerRef.current = false;
      setSavingTimer(false);
    }
  };

  const discardRoutineTimer = () => {
    if (!activeTimer?.routineId || stoppingTimerRef.current) return;
    showConfirm('Discard this unsaved routine timer? No time from this timer will be logged. Previously saved sessions and routine history will stay unchanged.', () => {
      if (stoppingTimerRef.current) return;
      writeActiveWorkTimer(null);
      setActiveTimer(null);
      triggerToast('Unsaved timer discarded. Previously saved time is unchanged.', 'info');
    });
  };

  const logManualTime = async () => {
    if (!currentTask) return;
    const minutes = Number(manualMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const started = manualWhen ? new Date(manualWhen) : new Date();
    const ended = new Date(started.getTime() + minutes * 60_000);
    await createSession.mutateAsync({
      task_id: currentTask.id,
      goal_id: currentTask.goal_id,
      started_at: started.toISOString(),
      ended_at: ended.toISOString(),
      minutes,
      notes: manualNote.trim() || undefined,
      source: 'manual',
    });
    setManualMinutes('');
    setManualNote('');
    setManualWhen(toDateTimeLocal(new Date()));
    triggerToast('Manual time logged.', 'success');
  };

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length) setPendingFiles(prev => [...prev, ...list]);
  };

  const submitJournal = async () => {
    if (!currentTask) return;
    const content = journalDraft.trim();
    if (!content && pendingFiles.length === 0) return;
    const noteId = await addTaskNote(currentTask.id, content || '-');
    for (const file of pendingFiles) await addNoteFile(noteId, file);
    setJournalDraft('');
    setPendingFiles([]);
    invalidate.taskNotes(currentTask.id);
    invalidate.noteFiles(noteId);
    triggerToast('Work note saved.', 'success');
  };

  const deleteNote = (note: DBTaskNote) => {
    showConfirm('Delete this work note?', async () => {
      await deleteTaskNote(note.id);
      invalidate.taskNotes(note.task_id);
      triggerToast('Work note deleted.', 'info');
    });
  };

  const deleteWorkSession = (id: string) => {
    showConfirm('Delete this time log?', async () => {
      await deleteSession.mutateAsync(id);
      triggerToast('Time log deleted.', 'info');
    });
  };

  const toggleDone = async () => {
    if (!currentTask) return;
    await toggleTask(currentTask.id);
    invalidate.tasks(currentTask.goal_id ?? undefined);
    triggerToast(currentTask.completed ? 'Task reopened.' : 'Task completed.', 'success');
  };

  const elapsed = activeTimer ? nowMs - new Date(activeTimer.startedAt).getTime() : 0;
  const routineTimerTooLong = Boolean(activeRoutine) && Math.round(elapsed / 60_000) > 1440;

  return (
    <div className="mobile-work mx-auto flex max-w-[1180px] flex-col gap-5 px-4 py-6 md:px-10">
      <header className="flex flex-col gap-3 border-b border-gray-100 pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Timer size={18} className="text-[#4648d4]" />
            <h1 className="font-headline text-2xl font-black text-gray-950">Work</h1>
          </div>
          <p className="text-xs text-gray-400">
            {activeTimer ? `Recording ${timerTitle}` : 'Pick a task, or start a routine from Schedule.'}
          </p>
        </div>
        {activeTimer && (
          <div className="flex items-center gap-3 rounded-xl border border-[#4648d4]/20 bg-[#EEF2FF] px-4 py-3">
            <div className="h-2.5 w-2.5 rounded-full bg-[#4648d4]" />
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-[#4648d4]">Live</p>
              <p className="font-mono text-lg font-black tabular-nums text-gray-950">{formatStopwatch(elapsed)}</p>
            </div>
            <button
              onClick={stopTimer}
              disabled={savingTimer}
              aria-label="Stop active timer and log time"
              className="ml-2 inline-flex items-center gap-1.5 rounded-lg bg-gray-950 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-gray-800 disabled:cursor-wait disabled:opacity-50"
            >
              <Square size={12} /> {savingTimer ? 'Saving…' : 'Stop'}
            </button>
          </div>
        )}
      </header>

      <button onClick={() => setTaskPickerOpen(open => !open)} aria-expanded={taskPickerOpen || (!currentTask && !activeRoutine)} aria-controls="work-task-picker" className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm font-semibold text-slate-700 lg:hidden"><span>{taskPickerOpen ? 'Close task picker' : currentTask ? 'Change task' : 'Choose a task'}</span><Search size={18} /></button>
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <aside id="work-task-picker" className={`min-w-0 ${taskPickerOpen || (!currentTask && !activeRoutine) ? "block" : "hidden lg:block"}`}>
          <div className="mobile-work-task-picker lg:sticky lg:top-20 lg:max-h-[calc(100vh-140px)] overflow-y-auto rounded-xl border border-gray-200 bg-white p-3">
            <TaskTree
              tasks={workTasks}
              goals={goals}
              mode="select"
              includeCriticalPath
              selectedTaskId={activeRoutine ? null : currentTask?.id ?? null}
              onSelect={task => { setWorkTaskId(task.id); setTaskPickerOpen(false); }}
              searchPlaceholder="Find a task or goal…"
            />
          </div>
        </aside>

        <div className="min-w-0 space-y-5">
          {activeRoutine ? (
            <section className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-5 shadow-sm sm:p-7" aria-label="Active routine focus session">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-indigo-600">
                Routine · {activeRoutine.goalId ? goalById.get(activeRoutine.goalId)?.title ?? 'Linked goal' : 'Standalone'}
              </p>
              <h2 className="font-headline text-2xl font-black text-gray-950">{activeRoutine.routineTitle}</h2>
              <p className="mt-2 text-sm text-gray-600">Session for {activeRoutine.routineDate}. Your timer keeps running if you leave this page.</p>
              <p className="my-6 font-mono text-4xl font-black tabular-nums text-indigo-950" aria-label="Routine elapsed time">{formatStopwatch(elapsed)}</p>
              <label className="block text-sm font-semibold text-gray-800" htmlFor="routine-focus-notes">What are you reviewing or practising?</label>
              <textarea
                id="routine-focus-notes"
                value={activeRoutine.notes}
                disabled={savingTimer}
                onChange={event => setActiveTimer(timer => timer ? { ...timer, notes: event.target.value } : timer)}
                placeholder="Optional notes for this session"
                className="mt-2 min-h-24 w-full resize-y rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
              />
              <p className="mt-3 text-xs leading-relaxed text-gray-600">Stopping saves time toward this day's routine. A minutes target is complete only when enough time is logged. For problems, pages or sessions, use “Done today” in Schedule when you finish your target.</p>
              <div className="mt-4 rounded-xl border border-indigo-100 bg-white p-3">
                {routineTimerTooLong && <p className="mb-3 text-sm text-amber-800">This timer has run for over 24 hours. If you forgot it running, enter the time you actually focused before saving. Nothing will be trimmed automatically.</p>}
                {!routineTimerTooLong && <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={adjustRoutineTime} disabled={savingTimer} onChange={event => { setAdjustRoutineTime(event.target.checked); setRoutineTimeError(''); }} />
                  Adjust focused minutes before saving
                </label>}
                {(adjustRoutineTime || routineTimerTooLong) && <div className="mt-2">
                  <label htmlFor="routine-focus-minutes" className="block text-sm font-semibold text-gray-800">Minutes to save</label>
                  <input id="routine-focus-minutes" type="number" min={1} max={1440} step={1} value={routineMinutesToSave} disabled={savingTimer}
                    onChange={event => { setRoutineMinutesToSave(event.target.value); setRoutineTimeError(''); }}
                    placeholder="Actual focused minutes" className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
                  <p className="mt-1 text-xs text-gray-500">Save 1–1440 minutes, up to the elapsed session time. The original start and stop timestamps are kept.</p>
                </div>}
                {routineTimeError && <p role="alert" className="mt-2 text-sm text-red-700">{routineTimeError}</p>}
              </div>
              <div className="mt-5 flex flex-wrap gap-3">
                <button onClick={stopTimer} disabled={savingTimer} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-50" aria-label="Stop routine timer and log time">
                  <Square size={14} /> {savingTimer ? 'Saving…' : 'Stop & save time'}
                </button>
                <button onClick={() => setCurrentTab('Schedule')} className="rounded-lg border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50">Back to today's routines</button>
                <button onClick={discardRoutineTimer} disabled={savingTimer} className="rounded-lg px-3 py-2.5 text-sm font-medium text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50">Discard timer</button>
              </div>
            </section>
          ) : !currentTask ? (
            <div className="rounded-xl border border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-300">
              Choose a task to open the work surface.
            </div>
          ) : (
            <>
              <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-gray-400">
                      {currentGoal?.title ?? 'Standalone task'}
                    </p>
                    <div className="flex items-start gap-2">
                      <button onClick={toggleDone} className="mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 hover:bg-emerald-50 hover:text-emerald-500" aria-label={currentTask.completed ? 'Reopen task' : 'Mark task complete'} aria-pressed={currentTask.completed}>
                        {currentTask.completed ? <CheckCircle2 size={20} className="text-emerald-500" /> : <Circle size={20} />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <h2 className={`font-headline text-2xl font-black leading-tight text-gray-950 ${currentTask.completed ? 'line-through opacity-50' : ''}`}>
                          {currentTask.title}
                        </h2>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-gray-400">
                          <span>{currentTask.status.replace('_', ' ')}</span>
                          {effectiveDueDate && (
                            <span className="rounded-md bg-gray-100 px-2 py-1 text-gray-500">
                              Due {effectiveDueDate.slice(0, 10)}{inheritedDueDate ? ' parent' : ''}
                            </span>
                          )}
                          {estimated && <span>{formatTaskTime(estimated)} est</span>}
                          <span title={actualRollup?.childrenMinutes ? `${formatTaskTime(actualRollup.childrenMinutes)} logged on child tasks` : undefined}>
                            {totalLogged === 0 ? '0m' : formatTaskTime(totalLogged)} logged{actualRollup?.childrenMinutes ? ' incl. children' : ''}
                          </span>
                          {progress !== null && <span className={progress > 100 ? 'text-amber-600' : undefined}>{progress}% time</span>}
                        </div>
                        <div className="mt-3">
                          <EntityTopicChips entityType="task" entityId={currentTask.id} />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 md:w-56">
                    {!activeTimer ? (
                      <>
                        <input
                          aria-label="Timer note"
                          value={timerNotes}
                          onChange={e => setTimerNotes(e.target.value)}
                          placeholder="Timer note"
                          className="rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2 text-xs outline-none focus:border-[#4648d4] focus:bg-white"
                        />
                        <button
                          onClick={startTimer}
                          disabled={currentTask.completed}
                          aria-label="Start timer for selected task"
                          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#4648d4] px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white hover:bg-[#3436b0] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Play size={14} /> Start
                        </button>
                      </>
                    ) : activeTimer.taskId === currentTask.id ? (
                      <button
                        onClick={stopTimer}
                        disabled={savingTimer}
                        aria-label="Stop timer and log time"
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white hover:bg-gray-800 disabled:cursor-wait disabled:opacity-50"
                      >
                        <Square size={14} /> {savingTimer ? 'Saving…' : 'Stop & Log'}
                      </button>
                    ) : (
                      <p className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        Timer is running on another task.
                      </p>
                    )}
                  </div>
                </div>
              </section>

              <section className="grid gap-5 xl:grid-cols-[1fr_300px]">
                <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <FileText size={15} className="text-gray-500" />
                      <h3 className="font-headline text-sm font-bold text-gray-900">Work Journal</h3>
                    </div>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="Attach files to work note"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 hover:bg-gray-50"
                    >
                      <Upload size={12} /> Files
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={e => {
                        if (e.currentTarget.files) addFiles(e.currentTarget.files);
                        e.currentTarget.value = '';
                      }}
                    />
                  </div>
                  <div
                    className={`rounded-xl border bg-[#f8f9fa] p-3 transition-colors ${dragging ? 'border-[#4648d4] bg-[#EEF2FF]' : 'border-gray-150'}`}
                    onDragOver={e => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
                  >
                    <textarea
                      aria-label="Work journal note"
                      value={journalDraft}
                      onChange={e => setJournalDraft(e.target.value)}
                      onKeyDown={e => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitJournal();
                      }}
                      placeholder="What are you working on?"
                      className="min-h-[130px] w-full resize-y bg-transparent text-sm leading-relaxed text-gray-800 outline-none placeholder:text-gray-300"
                    />
                    {pendingFiles.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gray-200 pt-3">
                        {pendingFiles.map((file, index) => (
                          <span key={`${file.name}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px]">
                            <Paperclip size={10} className="shrink-0 text-gray-400" />
                            <span className="truncate">{file.name}</span>
                            <button onClick={() => setPendingFiles(prev => prev.filter((_, i) => i !== index))} className="flex h-6 w-6 items-center justify-center rounded-md text-gray-300 hover:bg-red-50 hover:text-red-400" aria-label={`Remove pending file ${file.name}`}>
                              <X size={10} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={submitJournal}
                        disabled={!journalDraft.trim() && pendingFiles.length === 0}
                        aria-label="Save work note"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-950 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Plus size={12} /> Save Note
                      </button>
                    </div>
                  </div>

                  <div className="mt-5">
                    {notes.length > 0 ? (
                      notes.map(note => (
                        <WorkNoteItem
                          key={note.id}
                          note={note}
                          onDelete={() => deleteNote(note)}
                          onViewFile={setViewingFile}
                        />
                      ))
                    ) : (
                      <p className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-xs text-gray-300">
                        No work notes yet.
                      </p>
                    )}
                  </div>
                </div>

                <aside className="space-y-5"><MobileDisclosure title="Time logs" description={`${sessions.length} sessions · ${directLogged} minutes`} storageKey="work-time-logs">
                  <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center gap-2">
                      <Clock size={14} className="text-gray-500" />
                      <h3 className="font-headline text-sm font-bold text-gray-900">Add Time</h3>
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="work-manual-minutes" className="sr-only">Minutes to log</label>
                      <input
                        id="work-manual-minutes"
                        type="number"
                        min={1}
                        step={5}
                        value={manualMinutes}
                        onChange={e => setManualMinutes(e.target.value)}
                        placeholder="Minutes"
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#4648d4]"
                      />
                      <label htmlFor="work-manual-when" className="sr-only">Time log start</label>
                      <input
                        id="work-manual-when"
                        type="datetime-local"
                        value={manualWhen}
                        onChange={e => setManualWhen(e.target.value)}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-[#4648d4]"
                      />
                      <label htmlFor="work-manual-note" className="sr-only">Manual time note</label>
                      <textarea
                        id="work-manual-note"
                        value={manualNote}
                        onChange={e => setManualNote(e.target.value)}
                        placeholder="What got done?"
                        className="min-h-[76px] w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#4648d4]"
                      />
                      <button
                        onClick={logManualTime}
                        disabled={!manualMinutes || Number(manualMinutes) <= 0}
                        aria-label="Log manual time"
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#4648d4] px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-[#3436b0] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Plus size={12} /> Log Time
                      </button>
                    </div>
                  </section>

                  <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="font-headline text-sm font-bold text-gray-900">Session Log</h3>
                      <span className="font-mono text-[9px] uppercase tracking-widest text-gray-400">{directLogged === 0 ? '0m' : formatTaskTime(directLogged)}</span>
                    </div>
                    <div className="max-h-[360px] space-y-2 overflow-y-auto">
                      {sessions.length > 0 ? sessions.map(session => (
                        <div key={session.id} className="group/session rounded-lg border border-gray-100 bg-[#fafafa] px-3 py-2">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-xs font-black text-gray-800">{formatTaskTime(session.minutes ?? 0)}</p>
                              <p className="font-mono text-[9px] uppercase tracking-widest text-gray-400">
                                {formatSessionDate(session.started_at)} / {session.source}
                              </p>
                              {session.notes && <p className="mt-1 text-xs text-gray-500">{session.notes}</p>}
                            </div>
                            <button onClick={() => deleteWorkSession(session.id)} className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-200 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-400 group-hover/session:opacity-100 focus:opacity-100" aria-label={`Delete ${formatTaskTime(session.minutes ?? 0)} time log`}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      )) : (
                        <p className="rounded-lg border border-dashed border-gray-200 p-5 text-center text-xs text-gray-300">No sessions logged.</p>
                      )}
                    </div>
                  </section>
                </MobileDisclosure></aside>
              </section>
            </>
          )}
        </div>
      </div>

      {viewingFile && <FileViewerModal file={viewingFile} onClose={() => setViewingFile(null)} />}
    </div>
  );
}
