import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ArrowUp, ArrowDown, Keyboard, SquarePen, Copy, Zap, RefreshCw, CheckCircle, X, AlertTriangle, ChevronRight, ChevronDown, Diamond, Calendar, ChevronLeft, MessageSquare, Plus, Paperclip, SlidersHorizontal, Target } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useSchedulePreview, useGoals, useInvalidate, useChatSessions, useCreateChatSession, useDeleteChatSession, type ScheduleDay, type SchedulerResult, type ScheduleTaskInfo, type DayAssignment } from '../api/hooks';
import { apiFetch, apiPost } from '../utils/apiFetch';
import { useAppStore, type CopilotStoredMessage } from '../store/useAppStore';
import { PlanCalendarWidget, type ChatPlan } from './copilot/PlanCalendarWidget';
import { PlanOptionsWidget, type ChatPlanOptions } from './copilot/PlanOptionsWidget';
import { DayScheduleWidget, type ChatScheduleDayView } from './copilot/DayScheduleWidget';
import { OverdueTasksWidget, type OverdueTasksView } from './copilot/OverdueTasksWidget';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';
import { ModalFrame } from '../components/ModalFrame';
import { uploadResourceFile } from '../db/queries/resources';
import './copilot/copilot.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CopilotAction {
  id: string;
  type: 'create_task' | 'break_down_task' | 'create_goal' | 'create_goal_with_tasks' | 'update_task' | 'update_goal' | 'create_milestone' | 'attach_resource' | 'move_schedule_items' | 'create_routine' | 'update_routine' | 'check_in_routine';
  description: string;
  params: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'skipped' | 'applying' | 'done' | 'error';
  /** Durable proposal backing this card — apply/skip go through the proposal API. */
  proposal_id?: string;
  /** Set when the server rejected this model action during validation. */
  rejected_reason?: string;
}

/** Map a durable proposal status onto the card status used by the UI. */
function statusFromProposal(proposalStatus: string | undefined): CopilotAction['status'] {
  switch (proposalStatus) {
    case 'applied':  return 'done';
    case 'rejected': return 'skipped';
    case 'pending':  return 'pending';
    default:         return 'error'; // proposal missing/expired
  }
}

/** Query keys affected by applying a native workspace proposal. */
const PROPOSAL_AFFECTED_KEYS = [
  'routines', 'routine-entries',
  'goals', 'goals-health', 'goal-tasks', 'tasks', 'milestones',
  'proposals', 'ai-proposals', 'schedule-preview', 'data-readiness', 'org-inbox',
] as const;

interface FeasibilityIssue {
  goal_id: string;
  goal_title: string;
  issue: string;
  severity: 'warning' | 'critical';
}

interface FeasibilityResult {
  status: 'on_track' | 'at_risk' | 'critical';
  summary: string;
  issues?: FeasibilityIssue[];
}

interface ChatCitation {
  entity_type: string;
  entity_id: string;
  title: string;
  matched_via: string[];
  similarity?: number;
  topics?: string[];
}

interface ModelCallRuntime {
  phase: 'intent' | 'answer';
  model: string;
  provider: 'gemini-cloud' | 'nvidia-cloud' | 'ollama-local' | 'ollama-cloud';
  duration_ms: number;
  prompt_chars: number;
  fallback_used: boolean;
}

interface ChatRuntime {
  total_ms: number;
  primary_model: string;
  fallback_model: string | null;
  local_fallback_model?: string | null;
  model_calls: ModelCallRuntime[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions?: CopilotAction[];
  feasibility?: FeasibilityResult;
  citations?: ChatCitation[];
  /** interactive calendar payload when the turn was a plan request */
  plan?: ChatPlan;
  /** several visual alternatives for reschedule/move requests */
  planOptions?: ChatPlanOptions;
  /** visual current-day schedule payload for diagnostic schedule requests */
  scheduleDayView?: ChatScheduleDayView;
  overdueTasksView?: OverdueTasksView;
  runtime?: ChatRuntime;
  /** server-side message id — needed to persist plan widget state */
  serverMsgId?: string;
  timestamp: string;
  error?: string;
}

interface GoalHealth {
  id: string;
  title: string;
  deadline: string | null;
  days_until_deadline: number | null;
  feasibility: 'on_track' | 'at_risk' | 'overdue' | null;
  total_incomplete_tasks: number;
  total_mins_remaining: number;
  category: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMins(mins: number): string {
  const rounded = Math.round(mins);
  const abs = Math.abs(rounded);
  if (abs === 0) return '0h';
  if (abs < 60) return `${rounded}m`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${rounded < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
}

function modelLabel(model: string) {
  if (model.includes('nemotron')) return 'Nemotron';
  if (model.includes('deepseek')) return 'DeepSeek';
  return model === 'AI model' ? 'Connecting…' : model;
}

function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    const isH2     = line.startsWith('## ');
    const isH3     = line.startsWith('### ');
    const isBullet = /^[-*•]\s/.test(line);
    const content  = line.replace(/^#{2,3}\s/, '').replace(/^[-*•]\s/, '');

    const inline = (s: string) =>
      s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, j) => {
        if (p.startsWith('**') && p.endsWith('**'))
          return <strong key={j} className="font-semibold text-slate-900">{p.slice(2, -2)}</strong>;
        if (p.startsWith('`') && p.endsWith('`'))
          return <code key={j} className="bg-slate-50 px-1 py-0.5 rounded text-[11px] font-mono text-indigo-700">{p.slice(1, -1)}</code>;
        return p;
      });

    if (isH2)    return <p key={i} className="text-base font-bold text-slate-900 mt-5 mb-2 first:mt-0">{content}</p>;
    if (isH3)    return <p key={i} className="text-[14px] font-semibold text-slate-900 mt-4 mb-1">{content}</p>;
    if (isBullet) return (
      <div key={i} className="flex gap-2 my-0.5 pl-1">
        <span className="text-indigo-700 mt-0.5 shrink-0 text-[10px]">•</span>
        <span className="text-[15px] text-slate-800 leading-6">{inline(content)}</span>
      </div>
    );
    if (!line.trim()) return <div key={i} className="h-3" />;
    return <p key={i} className="text-[15px] text-slate-800 leading-6">{inline(line)}</p>;
  });
}

// ── Action Card ───────────────────────────────────────────────────────────────

function ActionCard({ action, onConfirm, onSkip }: {
  action: CopilotAction;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const isDone     = action.status === 'done';
  const isSkipped  = action.status === 'skipped';
  const isApplying = action.status === 'applying';
  const isError    = action.status === 'error';
  const isPending  = action.status === 'pending';

  const typeLabel = {
    create_routine: 'New Routine',
    update_routine: 'Update Routine',
    check_in_routine: 'Routine Check-in',
    create_task: 'New Task',
    break_down_task: 'Break Down Task',
    create_goal: 'New Goal',
    create_goal_with_tasks: 'New Goal + Tasks',
    update_task: 'Update Task',
    update_goal: 'Update Goal',
    create_milestone: 'New Milestone',
    attach_resource: 'Attach Resource',
    move_schedule_items: 'Move Schedule Items',
  }[action.type];
  const typeDot = {
    create_routine: 'bg-teal-400',
    update_routine: 'bg-teal-400',
    check_in_routine: 'bg-teal-400',
    create_task: 'bg-indigo-400',
    break_down_task: 'bg-cyan-400',
    create_goal: 'bg-purple-400',
    create_goal_with_tasks: 'bg-purple-400',
    update_task: 'bg-amber-400',
    update_goal: 'bg-amber-400',
    create_milestone: 'bg-teal-400',
    attach_resource: 'bg-blue-400',
    move_schedule_items: 'bg-violet-400',
  }[action.type];

  const p = action.params;

  if (isDone)    return (
    <div className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
      <CheckCircle size={12} className="text-emerald-700 shrink-0" />
      <span className="text-[12px] text-emerald-700 flex-1 min-w-0 truncate">{action.description}</span>
      <span className="text-[10px] text-emerald-500 shrink-0">Applied</span>
    </div>
  );

  if (isSkipped) return (
    <div className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-slate-50 border border-slate-200 opacity-40">
      <span className="text-[12px] text-slate-500 flex-1 min-w-0 truncate line-through">{action.description}</span>
      <span className="text-[10px] text-slate-500 shrink-0">Skipped</span>
    </div>
  );

  return (
    <div className={`rounded-xl border ${isError ? 'border-red-500/30 bg-red-500/5' : 'border-slate-200 bg-slate-50'} p-3`}>
      <div className="flex items-start gap-2.5">
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${typeDot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wide">{typeLabel}</span>
          </div>
          <p className="text-[13px] text-slate-800 leading-snug">{action.description}</p>
          {/* Param chips */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {p.title       && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">{String(p.title)}</span>}
            {p.due_date    && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">due {String(p.due_date)}</span>}
            {p.start_date  && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">starts {String(p.start_date)}</span>}
            {Array.isArray(p.tasks) && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">{p.tasks.length} task{p.tasks.length !== 1 ? 's' : ''}</span>}
            {p.priority    && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full capitalize">{String(p.priority)}</span>}
            {p.estimated_minutes && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">{fmtMins(Number(p.estimated_minutes))}</span>}
            {p.deadline    && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">deadline {String(p.deadline)}</span>}
            {p.source_date && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">from {String(p.source_date)}</span>}
            {p.target_date && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">to {String(p.target_date)}</span>}
            {Array.isArray(p.entity_types) && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">{p.entity_types.join(', ')}</span>}
            {p.category    && <span className="text-[10px] bg-slate-50 text-slate-500 px-2 py-0.5 rounded-full">{String(p.category)}</span>}
            {action.type === 'create_routine' && <>
              <span className="text-xs text-slate-600">{String(p.target_count)} {String(p.target_unit)} · {p.cadence === 'weekly' ? `${p.weekly_target} times/week` : 'Each selected day'}</span>
              {Array.isArray(p.weekdays) && <span className="text-xs text-slate-600">{p.weekdays.map(day => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][Number(day) - 1]).join(', ')}</span>}
              <span className="text-xs text-slate-600">{String(p.planned_minutes)} min reserved · {p.preferred_time ? String(p.preferred_time) : 'Anytime'}</span>
            </>}
          </div>
        </div>
      </div>
      {isError && (
        <p className="text-[11px] text-red-700 mt-2 pl-4">
          {action.rejected_reason
            ? `Could not create this proposal: ${action.rejected_reason}`
            : 'This action has no valid proposal to apply.'}
        </p>
      )}
      {isPending && (
        <div className="flex items-center gap-2 mt-3 pl-4">
          <button
            onClick={onConfirm}
            disabled={isApplying}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[12px] font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {isApplying ? <RefreshCw size={11} className="animate-spin" /> : <CheckCircle size={11} />}
            {isApplying ? 'Applying…' : 'Apply'}
          </button>
          <button onClick={onSkip} className="px-3 py-1.5 text-[12px] text-slate-500 hover:text-slate-700 transition-colors">
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

// ── Feasibility Banner ────────────────────────────────────────────────────────

function FeasibilityBanner({ f }: { f: FeasibilityResult }) {
  const [expanded, setExpanded] = useState(false);
  const cls = f.status === 'on_track'
    ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700'
    : f.status === 'at_risk'
      ? 'border-amber-500/25 bg-amber-500/8 text-amber-700'
      : 'border-red-500/25 bg-red-500/8 text-red-700';

  return (
    <div className={`mt-3 rounded-xl border p-3 ${cls}`}>
      <button className="flex items-center gap-2 w-full text-left" onClick={() => setExpanded(x => !x)}>
        {f.status === 'on_track' ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
        <span className="text-[12px] font-medium flex-1">{f.summary}</span>
        {f.issues?.length ? (expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
      </button>
      {expanded && f.issues?.map((issue, i) => (
        <div key={i} className="mt-2 pl-5">
          <p className="text-[11px] opacity-80 leading-relaxed">
            <span className="font-semibold">{issue.goal_title}:</span> {issue.issue}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Message Bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, sessionId, onConfirmAction, onSkipAction }: {
  msg: ChatMessage;
  sessionId: string | null;
  onConfirmAction: (msgId: string, actionId: string) => void;
  onSkipAction:    (msgId: string, actionId: string) => void;
}) {
  const triggerToast = useAppStore(s => s.triggerToast);
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="copilot-user-message max-w-[85%] bg-indigo-50 rounded-2xl rounded-tr-sm px-4 py-3">
          <p className="text-[15px] text-slate-800 leading-6 whitespace-pre-wrap break-words">{msg.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="copilot-assistant flex items-start gap-3 w-full">
      <div aria-hidden="true" className="copilot-avatar w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
        <Zap size={14} />
      </div>
      <div className="flex-1 min-w-0">
        {msg.error ? (
          <div className="bg-red-500/10 border border-red-400/25 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1.5 text-red-700">
              <AlertTriangle size={15} />
              <p className="text-sm font-semibold">Copilot couldn’t answer</p>
            </div>
            <p className="text-[14px] leading-6 text-red-700">{msg.error.replace(/^Error:\s*/i, '')}</p>
            <p className="text-xs text-red-700 mt-2">Your data was not changed.</p>
          </div>
        ) : (
          <div className="copilot-answer py-0.5 break-words">
            {renderMarkdown(msg.content)}
          </div>
        )}
        {msg.plan && (
          <PlanCalendarWidget plan={msg.plan} sessionId={sessionId} messageId={msg.serverMsgId} />
        )}
        {msg.planOptions && <PlanOptionsWidget planOptions={msg.planOptions} />}
        {msg.scheduleDayView && <DayScheduleWidget view={msg.scheduleDayView} />}
        {msg.overdueTasksView && <OverdueTasksWidget view={msg.overdueTasksView} />}
        {msg.feasibility && <FeasibilityBanner f={msg.feasibility} />}
        {msg.actions?.length ? (
          <div className="mt-2 space-y-2">
            {msg.actions.map(a => (
              <ActionCard
                key={a.id}
                action={a}
                onConfirm={() => onConfirmAction(msg.id, a.id)}
                onSkip={()    => onSkipAction(msg.id, a.id)}
              />
            ))}
          </div>
        ) : null}
        {msg.citations?.length ? <CitationRow citations={msg.citations} /> : null}
        {msg.content && <button aria-label="Copy response" className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-50" onClick={() => { navigator.clipboard.writeText(msg.content).then(() => triggerToast('Response copied', 'success')).catch(() => triggerToast('Could not copy. Select the text to copy it.', 'error')); }}><Copy size={14} />Copy</button>}
        {msg.runtime ? <RuntimeDisclosure runtime={msg.runtime} /> : null}
      </div>
    </div>
  );
}

// ── Citations ─────────────────────────────────────────────────────────────────
// Every assistant answer discloses exactly what was in the model's context and
// why each source was retrieved (lane provenance + similarity + topics).

function formatRuntime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

const PHASE_LABEL: Record<ModelCallRuntime['phase'], string> = {
  intent: 'Semantic intent',
  answer: 'Answer',
};

const PROVIDER_LABEL: Record<ModelCallRuntime['provider'], string> = {
  'gemini-cloud': 'Gemini cloud',
  'nvidia-cloud': 'NVIDIA cloud',
  'ollama-local': 'Ollama local',
  'ollama-cloud': 'Ollama cloud',
};

function RuntimeDisclosure({ runtime }: { runtime: ChatRuntime }) {
  const [open, setOpen] = useState(false);
  const usedModels = [...new Set(runtime.model_calls.map(call => call.model))];
  const summary = runtime.model_calls.length
    ? `${usedModels.join(' + ')} · ${runtime.model_calls.length} model call${runtime.model_calls.length === 1 ? '' : 's'} · ${formatRuntime(runtime.total_ms)}`
    : `Deterministic · no model call · ${formatRuntime(runtime.total_ms)}`;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(value => !value)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-mono text-slate-500 transition-colors hover:border-slate-200 hover:text-slate-700"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
        Response details · {formatRuntime(runtime.total_ms)}
      </button>
      {open && (
        <div className="mt-1.5 max-w-xl rounded-xl border border-slate-200 bg-slate-50 p-2.5">
          <p className="mb-2 break-words text-xs text-slate-500">{summary}</p>
          {runtime.model_calls.length ? (
            <div className="space-y-1.5">
              {runtime.model_calls.map((call, index) => (
                <div key={`${call.phase}-${index}`} className="grid grid-cols-[95px_1fr_auto] items-center gap-2 text-[10px]">
                  <span className="font-medium text-slate-500">{PHASE_LABEL[call.phase]}</span>
                  <span className="truncate font-mono text-slate-700">
                    {call.model} · {PROVIDER_LABEL[call.provider]}
                    {call.fallback_used ? ' · fallback' : ''}
                  </span>
                  <span className="font-mono text-slate-500">{formatRuntime(call.duration_ms)}</span>
                  <span />
                  <span className="font-mono text-slate-500">{call.prompt_chars.toLocaleString()} prompt characters</span>
                  <span />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-slate-500">The server handled this directly without asking a language model.</p>
          )}
          <div className="mt-2 border-t border-slate-200 pt-2 text-[10px] text-slate-500">
            Total includes database retrieval, schedule checks, model calls, and response validation.
            {runtime.fallback_model ? ` Fallback: ${runtime.fallback_model}.` : ''}
            {runtime.local_fallback_model ? ` Final local fallback: ${runtime.local_fallback_model}.` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkingIndicator() {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 100);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div role="status" className="flex items-center gap-3 py-3 text-sm text-slate-500">
      <RefreshCw size={16} className="animate-spin text-indigo-600 shrink-0" />
      <span>Thinking…</span>
      <span aria-hidden="true" className="ml-auto text-xs tabular-nums">{formatRuntime(elapsedMs)}</span>
    </div>
  );
}

const LANE_LABEL: Record<string, string> = {
  sql: 'planning window',
  vector: 'semantic match',
  graph: 'graph link',
  topic: 'topic member',
  recency: 'recent journal',
};

function CitationRow({ citations }: { citations: ChatCitation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[10px] font-mono text-slate-500 hover:text-slate-700 flex items-center gap-1"
      >
        {open ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
        Sources: {citations.length} item{citations.length !== 1 ? 's' : ''} in context
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 max-h-48 overflow-y-auto pr-1">
          {citations.map((c, i) => (
            <div key={`${c.entity_type}-${c.entity_id}-${i}`} className="flex items-center gap-2 text-[10px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-1">
              <span className="font-mono uppercase text-slate-500 shrink-0">{c.entity_type.replace('_', ' ')}</span>
              <span className="text-slate-700 truncate flex-1">{c.title}</span>
              <span className="font-mono text-slate-500 shrink-0">
                {c.matched_via.map(v => LANE_LABEL[v] ?? v).join(' · ')}
                {c.similarity !== undefined && ` (${(c.similarity * 100).toFixed(0)}%)`}
              </span>
              {c.topics?.length ? (
                <span className="font-mono text-indigo-700 shrink-0" title={`Topics: ${c.topics.join(', ')}`}>#{c.topics[0]}</span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Goal Health Panel ─────────────────────────────────────────────────────────

function GoalHealthPanel({ onGoalClick }: { onGoalClick: (title: string) => void }) {
  const [goals, setGoals] = useState<GoalHealth[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    apiFetch<Record<string, unknown>[]>('/api/goals')
      .then(async (gs) => {
        const active = gs.filter(g => !g.archived_at);
        const health = await Promise.all(active.map(async g => {
          const tasks = await apiFetch<Record<string, unknown>[]>(`/api/tasks?goal_id=${g.id}`);
          const incomplete = tasks.filter(t => !t.completed && t.status !== 'done');
          const totalMins  = incomplete.reduce((s, t) => s + (Number(t.estimated_minutes) || 0), 0);
          const deadline   = g.deadline as string | null;
          let feasibility: GoalHealth['feasibility'] = null;
          let daysUntil: number | null = null;
          if (deadline) {
            const dl = new Date(deadline);
            daysUntil = Math.ceil((dl.getTime() - today.getTime()) / 86400000);
            const avail = Math.max(0, daysUntil) * 8 * 60;
            feasibility = daysUntil < 0 ? 'overdue' : totalMins > avail * 0.9 ? 'at_risk' : 'on_track';
          }
          return { id: String(g.id), title: String(g.title), deadline, days_until_deadline: daysUntil, feasibility, total_incomplete_tasks: incomplete.length, total_mins_remaining: totalMins, category: String(g.category ?? '') };
        }));
        // Sort: overdue first, then at_risk, then on_track, then no deadline
        const order = { overdue: 0, at_risk: 1, on_track: 2, null: 3 };
        health.sort((a, b) => (order[String(a.feasibility) as keyof typeof order] ?? 3) - (order[String(b.feasibility) as keyof typeof order] ?? 3));
        setGoals(health);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const dot = (f: GoalHealth['feasibility']) => ({
    overdue:  'bg-red-400',
    at_risk:  'bg-amber-400',
    on_track: 'bg-emerald-400',
  }[f ?? ''] ?? 'bg-gray-600');

  const badge = (g: GoalHealth) => {
    if (!g.deadline || g.days_until_deadline === null) return null;
    const d = g.days_until_deadline;
    const label = d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? 'Today' : `${d}d`;
    const cls   = d < 0 ? 'text-red-700' : d <= 3 ? 'text-amber-700' : 'text-slate-500';
    return <span className={`text-[10px] font-mono ml-auto shrink-0 ${cls}`}>{label}</span>;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 pt-5 pb-3 shrink-0">
        <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1">Goals</p>
        <p className="text-xs font-semibold text-slate-700">{goals.length} active</p>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-0.5">
        {loading && (
          <div className="space-y-1.5 px-1 mt-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-10 rounded-lg bg-slate-50 animate-pulse" style={{ opacity: 1 - i * 0.2 }} />
            ))}
          </div>
        )}
        {!loading && goals.length === 0 && <p className="px-3 py-6 text-sm text-slate-500">No active goals to review.</p>}
        {goals.map(g => (
          <button
            key={g.id}
            onClick={() => onGoalClick(g.title)}
            className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors group"
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-2 h-2 rounded-full shrink-0 ${dot(g.feasibility)}`} />
              <span className="text-[12px] text-slate-700 group-hover:text-slate-900 transition-colors flex-1 min-w-0 leading-snug line-clamp-2 text-left">{g.title}</span>
              {badge(g)}
            </div>
            {(g.total_incomplete_tasks > 0 || g.total_mins_remaining > 0) && (
              <div className="flex items-center gap-2 mt-1 pl-[18px]">
                {g.total_incomplete_tasks > 0 && (
                  <span className="text-[10px] text-slate-500">{g.total_incomplete_tasks} tasks</span>
                )}
                {g.total_mins_remaining > 0 && (
                  <span className="text-[10px] text-slate-500">{fmtMins(g.total_mins_remaining)}</span>
                )}
              </div>
            )}
          </button>
        ))}
      </div>
      {/* Legend */}
      <div className="px-4 py-3 border-t border-slate-200 shrink-0 flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />OK</span>
        <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />Risk</span>
        <span className="flex items-center gap-1.5 text-[10px] text-slate-500"><span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />Late</span>
      </div>
    </div>
  );
}

// ── Schedule Preview Panel ────────────────────────────────────────────────────

const FEASIBILITY_BADGE: Record<SchedulerResult['status'], { label: string; className: string }> = {
  feasible:  { label: 'Feasible',  className: 'bg-green-50 text-green-700 border-green-700/40' },
  tight:     { label: 'Tight',     className: 'bg-yellow-50 text-yellow-700 border-yellow-700/40' },
  risky:     { label: 'Risky',     className: 'bg-amber-50 text-amber-700 border-amber-700/40' },
  impossible:{ label: 'Impossible',className: 'bg-red-50 text-red-700 border-red-700/40' },
};

function toLocalDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekBounds(offset: number): { start: string; end: string; label: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysFromMon = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysFromMon + offset * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { start: toLocalDateStr(monday), end: toLocalDateStr(sunday), label: `${fmt(monday)} – ${fmt(sunday)}` };
}

function SchedulePreviewPanel() {
  const { data } = useSchedulePreview();
  const { data: goals } = useGoals();
  const goalTitleMap = Object.fromEntries((goals ?? []).map(g => [g.id, g.title]));
  const invalidate = useInvalidate();
  const todayRef = useRef<HTMLDivElement>(null);
  const today = toLocalDateStr(new Date());
  const [goalFilter, setGoalFilter] = useState<string>('');
  const [weekOffset, setWeekOffset] = useState(0);

  const { start: weekStart, end: weekEnd, label: weekLabel } = useMemo(() => getWeekBounds(weekOffset), [weekOffset]);

  const allDays: ScheduleDay[] = data?.days ?? [];
  const taskLookup = data?.task_lookup ?? {} as Record<string, ScheduleTaskInfo>;
  const dayAssignmentMap = useMemo(
    () => Object.fromEntries((data?.scheduler_result?.day_assignments ?? []).map((da: DayAssignment) => [da.date, da])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.scheduler_result?.day_assignments],
  );
  const days = useMemo(
    () => allDays.filter(d => d.date >= weekStart && d.date <= weekEnd),
    [allDays, weekStart, weekEnd],
  );

  useEffect(() => {
    if (weekOffset === 0 && todayRef.current) {
      todayRef.current.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [weekOffset]);

  const schedulerResult = data?.scheduler_result;
  const allGoalIds = [...new Set(allDays.flatMap(d => d.tasks.map(t => t.goal_id).filter(Boolean)))];

  const applyProposal = async (id: string) => {
    await apiFetch(`/api/ai/proposals/${id}/apply`, { method: 'POST' });
    invalidate.schedulePreview();
    invalidate.allTasks();
    invalidate.goals();
  };

  const { triggerToast } = useAppStore();
  const [planning, setPlanning] = useState(false);
  // On-demand scheduler run: proposals land on their target days below and the
  // 5s schedule-preview poll keeps the panel live as they're accepted/rejected.
  const planWeek = async () => {
    setPlanning(true);
    try {
      const r = await apiPost<{ proposals_created: number; scheduler_result: { unestimated_task_ids: string[] } }>(
        '/api/ai/schedule/propose', { horizon_days: 7 },
      );
      invalidate.schedulePreview();
      if (r.proposals_created > 0) {
        triggerToast(`Scheduler proposed ${r.proposals_created} start date${r.proposals_created > 1 ? 's' : ''} — confirm them on their days below.`, 'success');
      } else if (r.scheduler_result.unestimated_task_ids.length) {
        triggerToast(`Nothing to schedule: ${r.scheduler_result.unestimated_task_ids.length} tasks need estimates first (see Schedule tab).`, 'info');
      } else {
        triggerToast('Schedule already matches the plan — no changes proposed.', 'info');
      }
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    } finally {
      setPlanning(false);
    }
  };

  const rejectProposal = async (id: string) => {
    await apiFetch(`/api/ai/proposals/${id}/reject`, { method: 'POST' });
    invalidate.schedulePreview();
  };

  const badge = schedulerResult ? FEASIBILITY_BADGE[schedulerResult.status] : null;

  return (
    <div className="flex flex-col h-full overflow-hidden border-l border-slate-200">
      <div className="copilot-schedule-toolbar shrink-0 px-3 h-14 flex min-w-0 items-center gap-2 border-b border-slate-200">
        <Calendar size={14} className="text-indigo-700 shrink-0" />
        <div className="flex min-w-0 items-center gap-1">
          <button
            onClick={() => setWeekOffset(w => w - 1)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
            title="Previous week"
            aria-label="Previous week"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            onClick={() => setWeekOffset(0)}
            className="max-w-[86px] truncate px-1 text-[10px] font-mono text-slate-500 transition-colors hover:text-slate-900"
            title="Jump to current week"
            aria-label="Jump to current week"
          >
            {weekOffset === 0 ? <span className="text-indigo-700">This week</span> : weekLabel}
          </button>
          <button
            onClick={() => setWeekOffset(w => w + 1)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
            title="Next week"
            aria-label="Next week"
          >
            <ChevronRight size={13} />
          </button>
        </div>
        {badge && (
          <span
            className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge.className}`}
            title={schedulerResult?.impossible_reason ?? `${schedulerResult?.tasks_overflow.length ?? 0} overflow, gap ${fmtMins(schedulerResult?.gap_minutes ?? 0)}`}
          >
            {badge.label}
          </span>
        )}
        {(schedulerResult?.unestimated_task_ids.length ?? 0) > 0 && (
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-700 border-amber-500/30"
            title={`${schedulerResult!.unestimated_task_ids.length} tasks have no time estimate and can't be scheduled — see the Schedule tab to fix`}
          >
            {schedulerResult!.unestimated_task_ids.length} unest.
          </span>
        )}
        <button
          onClick={planWeek}
          disabled={planning}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-indigo-700 transition-colors hover:bg-slate-50 hover:text-indigo-700 disabled:opacity-40"
          aria-label="Run schedule planner"
          title="Run the deterministic scheduler now — proposed start dates appear on their days below; nothing applies until you confirm each one"
        >
          {planning ? <RefreshCw size={13} className="animate-spin" /> : <Zap size={13} />}
        </button>
        <select
          aria-label="Filter schedule preview by goal"
          value={goalFilter}
          onChange={e => setGoalFilter(e.target.value)}
          className="ml-auto min-w-0 w-28 max-w-[9rem] truncate rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-mono text-slate-500 outline-none xl:w-36"
        >
          <option value="">All goals</option>
          {allGoalIds.map(id => <option key={id!} value={id!}>{goalTitleMap[id!] ?? id!.slice(0, 12)}</option>)}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className="px-2 pb-3">
          <div className="text-sm font-semibold text-slate-700">Upcoming work</div>
          <div className="mt-1 text-xs leading-5 text-slate-500">Tasks, deadlines and proposed changes for your week.</div>
        </div>
        {days.map(day => {
          const isToday = day.date === today;
          const filteredTasks = goalFilter ? day.tasks.filter(t => t.goal_id === goalFilter) : day.tasks;
          const parentIds = new Set(filteredTasks.map(task => task.parent_task_id).filter(Boolean));
          const tasks = filteredTasks.filter(task => !parentIds.has(task.id));
          const dayAssignment = dayAssignmentMap[day.date] as DayAssignment | undefined;
          const assignedTaskIds = goalFilter
            ? (dayAssignment?.task_ids ?? []).filter(id => taskLookup[id]?.goal_id === goalFilter)
            : (dayAssignment?.task_ids ?? []);
          const hasContent = tasks.length || day.meetings.length || day.proposals.length || day.deadline_titles.length || assignedTaskIds.length;
          if (!hasContent) return null;

          return (
            <div
              key={day.date}
              ref={isToday ? todayRef : undefined}
              className="relative pl-8 pb-4 last:pb-1"
            >
              <div className="absolute bottom-0 left-[11px] top-3 w-px bg-slate-200" />
              <div className={`absolute left-[6px] top-2 h-[11px] w-[11px] rounded-full border-2 ${isToday ? 'border-indigo-300 bg-indigo-600 shadow-[0_0_12px_rgba(99,102,241,.8)]' : 'border-gray-700 bg-white'}`} />
              <div className={`rounded-xl border p-2.5 ${isToday ? 'border-indigo-500/30 bg-indigo-500/[0.08]' : 'border-slate-200 bg-slate-50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-[10px] font-mono font-bold ${isToday ? 'text-indigo-700' : 'text-slate-500'}`}>
                  {new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
                {day.deadline_titles.map((t, i) => (
                  <span key={i} className="flex items-center gap-0.5 text-[9px] font-mono text-amber-700">
                    <Diamond size={8} /> {t.slice(0, 14)}
                  </span>
                ))}
                {day.override && (
                  <span className="text-[9px] font-mono text-slate-500 ml-auto">{fmtMins(day.override.available_minutes)}</span>
                )}
                {isToday && <span className="ml-auto rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-indigo-700">Today</span>}
              </div>

              <div className="space-y-1.5">
                {day.meetings.map(m => (
                  <div key={m.id} className="flex items-center gap-1.5 rounded-lg border border-cyan-400/15 bg-cyan-400/[0.04] px-2 py-1.5 text-[10px] font-mono" title={m.title}>
                    <span className="text-amber-700">⚑</span>
                    <span className="text-slate-500 truncate">{m.title}</span>
                    {m.duration_minutes && <span className="text-slate-500 shrink-0">{fmtMins(m.duration_minutes)}</span>}
                  </div>
                ))}

                {tasks.map(t => (
                  <div key={t.id} className="flex items-center gap-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.055] px-2 py-1.5" title={`${t.title} · due ${t.due_date}`}>
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.priority === 'high' ? 'bg-red-400' : t.priority === 'medium' ? 'bg-amber-400' : 'bg-gray-500'}`} />
                    <div className="min-w-0 flex-1"><div className="truncate text-[10px] font-medium text-slate-800">{t.title}</div><div className="text-[8px] text-slate-500">{t.parent_task_id ? 'Subtask' : 'Task'} · deadline</div></div>
                    {t.estimated_minutes ? <span className="shrink-0 rounded bg-slate-50 px-1 py-0.5 text-[8px] font-mono text-amber-700">{fmtMins(t.estimated_minutes)}</span> : <span className="text-[8px] text-red-700">No estimate</span>}
                  </div>
                ))}

                {assignedTaskIds.length > 0 && (
                  <>
                    <div
                      className="text-[8px] font-mono text-slate-500 uppercase tracking-widest mt-1 mb-0.5"
                      title="Optimizer suggestions only. These are not calendar blocks until you apply a proposal."
                    >
                      Suggested next · not booked
                    </div>
                    {assignedTaskIds.map(id => {
                      const info = taskLookup[id];
                      if (!info) return null;
                      return (
                        <div key={`assigned-${id}`} className="flex items-center gap-1.5 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-mono opacity-70" title={`${info.title} · suggestion, not booked`}>
                          <span className="text-slate-500 shrink-0">→</span>
                          <span className="truncate flex-1">{info.title.slice(0, 26)}</span>
                          {info.estimated_minutes > 0 && <span className="shrink-0 opacity-60">{fmtMins(info.estimated_minutes)}</span>}
                        </div>
                      );
                    })}
                    {dayAssignment && (
                      <div className="text-[8px] font-mono text-slate-500 text-right mt-0.5">
                        {fmtMins(dayAssignment.used_minutes)} / {fmtMins(dayAssignment.available_minutes)}
                      </div>
                    )}
                  </>
                )}

                {day.proposals.map((p: ScheduleDay['proposals'][0]) => {
                  // Scheduler proposals carry task_id + start_date, not a title —
                  // resolve the real task name so the card isn't a bare "update_task".
                  const taskId = p.params.task_id as string | undefined;
                  const label = (p.params.title as string | undefined)
                    ?? (taskId ? taskLookup[taskId]?.title : undefined)
                    ?? p.action_type;
                  const move = p.params.start_date ? `start ${String(p.params.start_date).slice(5)}` : null;
                  return (
                    <div key={p.id} className="flex items-center gap-1.5 border border-dashed border-amber-400/40 rounded-md px-1.5 py-0.5">
                      <span className="text-[10px] font-mono text-amber-700 truncate flex-1" title={p.explanation ?? label}>
                        ✦ {label.slice(0, 22)}{move ? ` → ${move}` : ''}
                      </span>
                      <button onClick={() => applyProposal(p.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-green-700 hover:bg-green-500/10 hover:text-green-700" title="Confirm proposal" aria-label={`Confirm proposal for ${label}`}>✓</button>
                      <button onClick={() => rejectProposal(p.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-red-500/10 hover:text-red-700" title="Reject proposal" aria-label={`Reject proposal for ${label}`}>×</button>
                    </div>
                  );
                })}
              </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Starter prompts ───────────────────────────────────────────────────────────

const ANALYZE_PROMPT = `Perform a proactive smart review of my entire planning system, not just today.
Check every active goal, incomplete task, deadline, calendar block, meeting, dependency, estimate, logged-work signal, and recent journal summary available to you.

Prioritize the few things that genuinely need intervention:
1. Overdue, blocked, stale, or likely-to-slip work.
2. Vague, oversized, repeatedly stalled, or unestimated tasks that should be broken into concrete child tasks.
3. Real routines that should repeat on specific days, but only when a cadence is already clear; ask me when it is not.
4. Missing dates, unrealistic estimates, and capacity conflicts across the next two weeks.

Give me a concise executive brief, then propose safe reviewable actions for the strongest fixes. Do not apply anything automatically.`;

const STARTERS = [
  { icon: Calendar, label: 'Plan this week', detail: 'Make room for what matters', prompt: 'Plan my week. Suggest a realistic schedule based on my deadlines and remaining work.' },
  { icon: Zap, label: 'Smart review', detail: 'Find a useful next step', prompt: ANALYZE_PROMPT },
  { icon: Target, label: "What’s at risk?", detail: 'Check goals and deadlines', prompt: 'Which goals or tasks are at risk of missing deadlines? Be specific.' },
  { icon: RefreshCw, label: 'Fix my schedule', detail: 'Bring the week back into balance', prompt: 'Suggest specific date adjustments and task reorganizations to make everything feasible.' },
];

// ── CopilotView ───────────────────────────────────────────────────────────────

// ── Session History Sidebar ───────────────────────────────────────────────────

function SessionSidebar({ activeSessionId, onSelect, onNew }: { activeSessionId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const { data: sessions = [] } = useChatSessions();
  const deleteSession = useDeleteChatSession();
  const [search, setSearch] = useState('');
  const showConfirm = useAppStore(s => s.showConfirm);
  const clearConversation = useAppStore(s => s.clearCopilotConversation);
  const filtered = sessions.filter(session => (session.title ?? '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col h-full">
      <input aria-label="Search conversations" placeholder="Search conversations…" value={search} onChange={event => setSearch(event.target.value)} className="mb-3 w-full rounded-xl border border-slate-200 bg-slate-50 p-3 text-base outline-none focus:border-indigo-400" />
      <button onClick={onNew} className="mb-2 flex items-center gap-2 rounded-xl px-3 py-3 text-sm font-medium text-indigo-600 hover:bg-indigo-50"><Plus size={18} />New conversation</button>
      <div className="flex-1 overflow-y-auto py-2">
        {filtered.length === 0 && (
          <p className="text-sm text-slate-500 text-center my-6 px-4">{search ? 'No conversations match your search.' : 'Your conversations will appear here.'}</p>
        )}
        {filtered.map(s => (
          <div
            key={s.id}
            className={`flex items-center gap-2 rounded-xl px-2 ${s.id === activeSessionId ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
          >
            <button onClick={() => onSelect(s.id)} aria-current={s.id === activeSessionId ? 'true' : undefined} className="min-w-0 flex-1 py-3 text-left text-sm text-slate-800"><span className="block truncate">{s.title || 'Untitled conversation'}</span><span className="mt-1 block text-xs text-slate-500">{new Date(s.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></button>
            <button
              onClick={() => showConfirm(`Delete “${s.title || 'Untitled conversation'}” from your history?`, async () => { await deleteSession.mutateAsync(s.id); if (s.id === activeSessionId) clearConversation(); })}
              aria-label={`Delete conversation ${s.title ?? s.id}`}
              className="copilot-icon-button hover:text-red-600"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CopilotView() {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [isLoading,       setIsLoading]       = useState(false);
  const [apiKeyMissing,   setApiKeyMissing]   = useState(false);
  const [panel, setPanel] = useState<'history' | 'goals' | 'schedule' | 'settings' | null>(null);
  const [uploading,  setUploading]  = useState(false);
  const [modelConfig, setModelConfig] = useState({
    primary: 'AI model',
    primaryStatus: 'checking',
    fallback: null as string | null,
    options: [] as Array<{ model: string; provider: string; status: string }>,
  });
  const [selectedModel, setSelectedModel] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const fileRef   = useRef<HTMLInputElement>(null);
  const qc        = useQueryClient();
  const triggerToast = useAppStore(s => s.triggerToast);
  const activeSessionId = useAppStore(s => s.copilotActiveSessionId);
  const setActiveSessionId = useAppStore(s => s.setCopilotActiveSessionId);
  const input = useAppStore(s => s.copilotDraft);
  const setInput = useAppStore(s => s.setCopilotDraft);
  const rawMessages = useAppStore(s => s.copilotMessages);
  const setRawMessages = useAppStore(s => s.setCopilotMessages);
  const attachment = useAppStore(s => s.copilotAttachment);
  const setAttachment = useAppStore(s => s.setCopilotAttachment);
  const clearCopilotConversation = useAppStore(s => s.clearCopilotConversation);
  const messages = rawMessages as ChatMessage[];
  const setMessages = useCallback((update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setRawMessages(prev => {
      const previous = prev as ChatMessage[];
      const next = typeof update === 'function' ? update(previous) : update;
      return next as CopilotStoredMessage[];
    });
  }, [setRawMessages]);

  useEffect(() => {
    const refreshModelConfig = () => {
      apiFetch<{
        models?: {
          primary?: { model?: string; status?: string };
          nvidia_fallback?: { model?: string; status?: string };
          fallback?: { model?: string; status?: string };
          available?: Array<{ model: string; provider: string; status: string }>;
        };
        chat_cooldown?: { active?: boolean };
      }>('/api/health/ready')
        .then(health => {
          const nvidiaFallback = health.models?.nvidia_fallback?.status === 'cloud'
            && health.models.nvidia_fallback.model !== health.models?.primary?.model
            ? health.models.nvidia_fallback.model
            : null;
          const localFallback = health.models?.fallback?.model ?? null;
          setModelConfig({
            primary: health.models?.primary?.model ?? 'AI model',
            primaryStatus: health.chat_cooldown?.active
              ? 'rate limited'
              : health.models?.primary?.status ?? 'unknown',
            fallback: [nvidiaFallback, localFallback].filter(Boolean).join(' → ') || null,
            options: health.models?.available ?? [],
          });
          setSelectedModel(current => current || health.models?.primary?.model || '');
        })
        .catch(() => {});
    };
    refreshModelConfig();
    const timer = window.setInterval(refreshModelConfig, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // Attach = real library upload (chunked + embedded like any resource); the
  // resource_id is then stated in the next message so the model can propose
  // attach_resource actions against it.
  const uploadAttachment = async (file: File) => {
    setUploading(true);
    try {
      const id = await uploadResourceFile(file);
      setAttachment({ id, title: file.name, indexing: true });
      qc.invalidateQueries({ queryKey: ['resources'] });
      triggerToast(`"${file.name}" added to your Resource Library. Tell the copilot where to file it.`, 'success');
      setTimeout(() => setAttachment(a => a && a.id === id ? { ...a, indexing: false } : a), 20_000);
    } catch (e) {
      triggerToast(`Upload failed: ${(e as Error).message}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const createSession = useCreateChatSession();

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'instant') => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followLatestRef.current = true;
    setAtBottom(true);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
  }, []);

  const handleChatScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    followLatestRef.current = nearBottom;
    setAtBottom(nearBottom);
  };

  useEffect(() => {
    if (followLatestRef.current) scrollToLatest();
  }, [messages, isLoading, scrollToLatest]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => {
      if (followLatestRef.current) scrollToLatest();
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [input]);

  const loadSession = useCallback(async (sessionId: string) => {
    try {
      interface StoredAction extends Omit<CopilotAction, 'status'> { proposal_status?: string }
      const msgs = await apiFetch<{
        id: string; role: 'user' | 'assistant'; content: string; created_at: string;
        metadata?: { actions?: StoredAction[]; feasibility?: FeasibilityResult | null; citations?: ChatCitation[]; plan?: ChatPlan; plan_options?: ChatPlanOptions; schedule_day_view?: ChatScheduleDayView; overdue_tasks_view?: OverdueTasksView; runtime?: ChatRuntime } | null;
      }[]>(`/api/ai/sessions/${sessionId}/messages`);
      setActiveSessionId(sessionId);
      followLatestRef.current = true;
      // Restore action cards from persisted metadata; card status reflects the
      // CURRENT durable proposal state, so applied/skipped survive reloads.
      // Plan widgets restore with their saved status and drag adjustments.
      setMessages(msgs.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        actions: m.metadata?.actions?.map(a => ({
          ...a,
          status: a.rejected_reason ? 'error' as const : statusFromProposal(a.proposal_status),
        })),
        feasibility: m.metadata?.feasibility ?? undefined,
        citations: m.metadata?.citations ?? undefined,
        plan: m.metadata?.plan ?? undefined,
        planOptions: m.metadata?.plan_options ?? undefined,
        scheduleDayView: m.metadata?.schedule_day_view ?? undefined,
        overdueTasksView: m.metadata?.overdue_tasks_view ?? undefined,
        runtime: m.metadata?.runtime ?? undefined,
        serverMsgId: m.id,
        timestamp: new Date(m.created_at).toISOString(),
      })));
      setPanel(null);
    } catch { /* ignore */ }
  }, [setActiveSessionId, setMessages]);

  useEffect(() => {
    if (activeSessionId && messages.length === 0 && !isLoading) void loadSession(activeSessionId);
  }, [activeSessionId, messages.length, isLoading, loadSession]);

  const startNewConversation = useCallback(() => {
    followLatestRef.current = true;
    clearCopilotConversation();
    setPanel(null);
  }, [clearCopilotConversation]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    followLatestRef.current = true;
    setInput('');
    // A pending attachment rides along as an explicit reference the model can
    // act on (attach_resource) — stated in-message, never smuggled invisibly.
    const outgoing = attachment
      ? `${text.trim()}\n\n[Attached file "${attachment.title}" is already in my Resource Library with resource_id: ${attachment.id}]`
      : text.trim();
    if (attachment) setAttachment(null);
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: outgoing, timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    const assistantId = crypto.randomUUID();

    try {
      let sessionId = activeSessionId;

      if (!sessionId) {
        // Create a new session titled from the first user message
        const session = await createSession.mutateAsync({
          title: text.trim().slice(0, 60),
          model: selectedModel || undefined,
        });
        sessionId = session.id;
        setActiveSessionId(sessionId);
      }

      const data = await apiPost<{ reply?: string; actions?: Omit<CopilotAction, 'status'>[]; feasibility?: FeasibilityResult; citations?: ChatCitation[]; plan?: ChatPlan | null; plan_options?: ChatPlanOptions | null; schedule_day_view?: ChatScheduleDayView | null; overdue_tasks_view?: OverdueTasksView | null; runtime?: ChatRuntime; message_id?: string; error?: string }>(
        `/api/ai/sessions/${sessionId}/chat`, {
          message: outgoing,
          model: selectedModel || undefined,
        },
      );
      const actions: CopilotAction[] = (data.actions ?? []).map(a => ({
        ...a,
        status: a.rejected_reason || !a.proposal_id ? 'error' as const : 'pending' as const,
      }));
      setMessages(prev => [...prev, {
        id: assistantId,
        role: 'assistant',
        content: data.reply ?? '',
        actions,
        feasibility: data.feasibility,
        citations: data.citations,
        plan: data.plan ?? undefined,
        planOptions: data.plan_options ?? undefined,
        scheduleDayView: data.schedule_day_view ?? undefined,
        overdueTasksView: data.overdue_tasks_view ?? undefined,
        runtime: data.runtime,
        serverMsgId: data.message_id,
        timestamp: new Date().toISOString(),
      }]);
      qc.invalidateQueries({ queryKey: ['proposals'] });
    } catch (err) {
      const isOffline = err instanceof Error && err.message.includes('Failed to fetch');
      const errMsg = isOffline
        ? 'Network error — is the Marina server running?'
        : (err instanceof Error ? err.message : 'Request failed');
      const isApiKeyErr = errMsg.toLowerCase().includes('api key') || errMsg.toLowerCase().includes('gemini');
      if (isApiKeyErr) setApiKeyMissing(true);
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', error: errMsg, timestamp: new Date().toISOString() }]);
    } finally {
      setIsLoading(false);
      if (!isMobile) setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isLoading, isMobile, activeSessionId, createSession, qc, attachment, selectedModel, setActiveSessionId, setAttachment, setInput, setMessages]);

  const handleConfirmAction = useCallback(async (msgId: string, actionId: string) => {
    const action = messages.find(m => m.id === msgId)?.actions?.find(a => a.id === actionId);
    if (!action?.proposal_id) {
      // No durable proposal behind this card (validation-rejected or legacy) — surface honestly.
      setMessages(prev => prev.map(m => m.id !== msgId ? m : { ...m, actions: m.actions?.map(a => a.id === actionId ? { ...a, status: 'error' as const } : a) }));
      return;
    }
    setMessages(prev => prev.map(m => m.id !== msgId ? m : { ...m, actions: m.actions?.map(a => a.id === actionId ? { ...a, status: 'applying' as const } : a) }));
    try {
      // Durable path: transactional, row-locked, double-apply safe.
      await apiPost(`/api/ai/proposals/${action.proposal_id}/apply`, {});
      setMessages(prev => prev.map(m => m.id !== msgId ? m : { ...m, actions: m.actions?.map(a => a.id === actionId ? { ...a, status: 'done' as const } : a) }));
      for (const key of PROPOSAL_AFFECTED_KEYS) qc.invalidateQueries({ queryKey: [key] });
    } catch {
      setMessages(prev => prev.map(m => m.id !== msgId ? m : { ...m, actions: m.actions?.map(a => a.id === actionId ? { ...a, status: 'error' as const } : a) }));
    }
  }, [messages, qc]);

  const handleSkipAction = useCallback(async (msgId: string, actionId: string) => {
    const action = messages.find(m => m.id === msgId)?.actions?.find(a => a.id === actionId);
    // Skip must persist: reject the durable proposal so it disappears from the
    // proposals panel and stays skipped after a reload.
    if (action?.proposal_id) {
      try {
        await apiPost(`/api/ai/proposals/${action.proposal_id}/reject`, {});
        qc.invalidateQueries({ queryKey: ['proposals'] });
        qc.invalidateQueries({ queryKey: ['ai-proposals'] });
        qc.invalidateQueries({ queryKey: ['schedule-preview'] });
      } catch { /* already decided elsewhere — still mark locally */ }
    }
    setMessages(prev => prev.map(m => m.id !== msgId ? m : { ...m, actions: m.actions?.map(a => a.id === actionId ? { ...a, status: 'skipped' as const } : a) }));
  }, [messages, qc]);

  const isEmpty = messages.length === 0;
  const selectedModelStatus = modelConfig.options.find(option => option.model === selectedModel)?.status
    ?? modelConfig.primaryStatus;

  return (
    <section className="copilot-workspace" aria-label="Copilot conversation">
      <header className="copilot-header">
        <button className="copilot-icon-button" onClick={() => setPanel('history')} disabled={isLoading} aria-label="Open conversation history" title="Conversations"><MessageSquare size={21} /></button>
        <button className="copilot-heading" onClick={() => setPanel('settings')} aria-label="Chat model and tools" aria-haspopup="dialog">
          <span className="font-headline text-lg font-bold text-slate-900">Copilot</span>
          <span className="flex items-center gap-1 text-xs text-slate-500">{modelLabel(selectedModel || modelConfig.primary)}<ChevronDown size={12} /></span>
        </button>
        <button className="copilot-icon-button" onClick={startNewConversation} disabled={isLoading} aria-label="Start a new conversation" title="New chat"><SquarePen size={21} /></button>
      </header>

      {panel && <ModalFrame titleId="copilot-panel-title" onClose={() => setPanel(null)} className="copilot-panel mobile-sheet w-full max-w-xl rounded-3xl bg-white p-5 text-slate-900 shadow-xl" overlayClassName="bg-slate-900/30 backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="copilot-panel-title" className="text-xl font-headline font-bold">{({ history: 'Your conversations', goals: 'Goal health', schedule: 'Your week', settings: 'Chat model & tools' })[panel]}</h2>
          <button onClick={() => setPanel(null)} aria-label="Close chat panel" className="copilot-icon-button"><X size={20} /></button>
        </div>
        <div className="copilot-panel-content">
          {panel === 'history' && <SessionSidebar activeSessionId={activeSessionId} onSelect={id => { void loadSession(id); }} onNew={startNewConversation} />}
          {panel === 'goals' && <GoalHealthPanel onGoalClick={title => { setPanel(null); void send(`Tell me about the schedule for "${title}" — is it feasible and what should I prioritize?`); }} />}
          {panel === 'schedule' && <SchedulePreviewPanel />}
          {panel === 'settings' && <div className="space-y-5">
            <div>
              <label htmlFor="copilot-model" className="mb-2 block text-sm font-medium">Model</label>
              <select id="copilot-model" value={selectedModel || modelConfig.primary} onChange={event => setSelectedModel(event.target.value)} disabled={isLoading || !modelConfig.options.length} className="w-full rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:border-indigo-500">
                {modelConfig.options.length ? modelConfig.options.map(option => <option key={option.model} value={option.model}>{modelLabel(option.model)}</option>) : <option>{modelLabel(modelConfig.primary)}</option>}
              </select>
              <p className="mt-2 text-xs text-slate-500">{selectedModelStatus === 'rate limited' ? 'This model is busy. Please try again shortly.' : 'Choose the model for your next message.'}</p>
            </div>
            <div className="space-y-1 border-t border-slate-100 pt-3">
              <button className="copilot-tool" onClick={() => setPanel('schedule')}><Calendar size={19} /><span>Your week<span>See upcoming work and schedule suggestions</span></span><ChevronRight size={16} /></button>
              <button className="copilot-tool" onClick={() => setPanel('goals')} disabled={isLoading}><Target size={19} /><span>Goal health<span>Check progress and approaching deadlines</span></span><ChevronRight size={16} /></button>
              <button className="copilot-tool" disabled={isLoading} onClick={() => { setPanel(null); void send(ANALYZE_PROMPT); }}><Zap size={19} /><span>Smart review<span>Find what needs your attention</span></span><ChevronRight size={16} /></button>
            </div>
          </div>}
        </div>
      </ModalFrame>}

      {apiKeyMissing && <div role="alert" className="mx-4 mt-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Copilot couldn’t connect to its model. Check your AI connection in Settings.</div>}

      <div ref={scrollRef} onScroll={handleChatScroll} className="copilot-messages" aria-label="Messages">
        {isEmpty && !isLoading ? <div className="copilot-welcome">
          <span className="copilot-welcome-icon"><Zap size={24} /></span>
          <h1 className="font-headline">A little clarity for your day.</h1>
          <p>Talk through a task, make a plan,<br className="sm:hidden" /> or find your next step.</p>
          <div className="copilot-starters">
            {STARTERS.map(starter => <button key={starter.label} onClick={() => void send(starter.prompt)}><starter.icon size={20} /><span>{starter.label}<small>{starter.detail}</small></span><ChevronRight size={15} /></button>)}
          </div>
        </div> : <div className="copilot-message-list">
          {messages.map(msg => <MessageBubble key={msg.id} msg={msg} sessionId={activeSessionId} onConfirmAction={handleConfirmAction} onSkipAction={handleSkipAction} />)}
          {isLoading && <WorkingIndicator />}
        </div>}
      </div>

      <div className="copilot-composer-wrap">
        {!atBottom && !isEmpty && <button className="copilot-latest" onClick={() => scrollToLatest('smooth')} aria-label="Jump to latest message"><ArrowDown size={17} /> Latest</button>}
        <div className="copilot-composer">
          {attachment && <div className="copilot-attachment"><Paperclip size={16} /><span className="truncate">{attachment.title}</span><button aria-label="Remove attached file" className="copilot-icon-button" onClick={() => setAttachment(null)}><X size={17} /></button></div>}
          <textarea ref={inputRef} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !isMobile && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} aria-label="Message Copilot" placeholder="Message Marina…" rows={1} />
          <div className="copilot-composer-tools">
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,.png,.jpg,.jpeg,.gif,.webp" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadAttachment(file); event.target.value = ''; }} />
            <button className="copilot-icon-button" onClick={() => fileRef.current?.click()} disabled={uploading || isLoading} aria-label="Attach a file" title="Attach a file">{uploading ? <RefreshCw size={20} className="animate-spin" /> : <Plus size={22} />}</button>
            <button className="copilot-icon-button" onClick={() => setPanel('settings')} aria-label="Chat tools" title="Chat tools"><SlidersHorizontal size={19} /></button>
            <button className="copilot-dismiss-keyboard copilot-icon-button" aria-label="Hide keyboard" onClick={() => inputRef.current?.blur()}><Keyboard size={20} /><ChevronDown size={12} /></button>
            <button className="copilot-send" onPointerDown={event => { if (document.activeElement === inputRef.current) event.preventDefault(); }} onClick={() => void send(input)} disabled={!input.trim() || isLoading || uploading} aria-label="Send message">{isLoading ? <RefreshCw size={19} className="animate-spin" /> : <ArrowUp size={21} />}</button>
          </div>
        </div>
        <p className="copilot-keyboard-hint">Enter to send · Shift + Enter for a new line</p>
      </div>
    </section>
  );
}
