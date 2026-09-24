import { useState } from 'react';
import { CalendarDays, Zap, ZapOff } from 'lucide-react';
import { updateGoal } from '../db/queries/goals';
import { useAppStore } from '../store/useAppStore';
import type { DBGoal, PlanStatus } from '../db/schema';

/**
 * Real date-based planning for a goal (replaces the vague Q1/Q2-style single
 * deadline): start date, target date, hard deadline, plan status, and the
 * scheduling toggle that decides whether Marina may manage its time at all.
 */

const STATUS_OPTIONS: Array<{ value: PlanStatus; label: string; cls: string }> = [
  { value: 'not_started', label: 'Not started', cls: 'text-gray-500' },
  { value: 'planned',     label: 'Planned',     cls: 'text-blue-600' },
  { value: 'in_progress', label: 'In progress', cls: 'text-indigo-600' },
  { value: 'paused',      label: 'Paused',      cls: 'text-amber-600' },
  { value: 'blocked',     label: 'Blocked',     cls: 'text-red-600' },
  { value: 'completed',   label: 'Completed',   cls: 'text-emerald-600' },
];

function DateField({ label, value, onSave, hint }: {
  label: string; value: string | null | undefined; onSave: (v: string | null) => void; hint: string;
}) {
  return (
    <label className="flex flex-col gap-0.5" title={hint}>
      <span className="text-[8px] font-mono uppercase tracking-widest text-gray-400">{label}</span>
      <input
        type="date"
        value={value ?? ''}
        onChange={e => onSave(e.target.value || null)}
        className="text-[11px] font-mono bg-white border border-gray-200 rounded-lg px-1.5 py-1 text-gray-700 focus:outline-none focus:border-[#4648d4] w-[118px]"
      />
    </label>
  );
}

export function GoalPlanningPanel({ goal, onChanged }: { goal: DBGoal; onChanged: () => void }) {
  const { triggerToast } = useAppStore();
  const [saving, setSaving] = useState(false);

  const save = async (patch: Parameters<typeof updateGoal>[1], msg?: string) => {
    setSaving(true);
    try {
      await updateGoal(goal.id, patch);
      onChanged();
      if (msg) triggerToast(msg, 'success');
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const schedulingOn = goal.scheduling_enabled !== false;
  const status = (goal.plan_status ?? 'in_progress') as PlanStatus;
  const statusOpt = STATUS_OPTIONS.find(s => s.value === status) ?? STATUS_OPTIONS[2];

  return (
    <div className={`mobile-goal-planning rounded-xl border border-gray-100 bg-white p-3 space-y-2.5 ${saving ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2">
        <CalendarDays size={12} className="text-[#4648d4]" />
        <span className="text-[9px] font-mono uppercase tracking-widest text-gray-400 font-bold">Planning</span>
        <select
          aria-label="Goal planning status"
          value={status}
          onChange={e => save({ plan_status: e.target.value as PlanStatus }, `Status: ${e.target.value.replace('_', ' ')}`)}
          className={`ml-auto text-[10px] font-mono font-bold bg-white border border-gray-200 rounded-lg px-1.5 py-0.5 cursor-pointer focus:outline-none ${statusOpt.cls}`}
          title="Goal status — you decide; it never changes by itself"
        >
          {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div className="flex gap-2 flex-wrap">
        <DateField label="Start" value={goal.start_date} hint="When you're allowed/supposed to begin"
          onSave={v => save({ start_date: v })} />
        <DateField label="Target" value={goal.target_date} hint="When you'd like to finish"
          onSave={v => save({ target_date: v })} />
        <DateField label="Hard deadline" value={goal.hard_deadline} hint="When it MUST be done — non-negotiable"
          onSave={v => save({ hard_deadline: v })} />
      </div>

      <button
        onClick={() => save(
          { scheduling_enabled: !schedulingOn },
          schedulingOn ? 'Marina will NOT auto-plan this goal’s time.' : 'Marina may plan this goal’s time (needs dates + estimates).',
        )}
        className={`w-full flex items-center gap-1.5 justify-center text-[10px] font-mono uppercase tracking-wider py-1.5 rounded-lg border transition-colors ${
          schedulingOn
            ? 'bg-[#EEF2FF] text-[#4648d4] border-[#c0c1ff]/60 hover:bg-[#c0c1ff]/20'
            : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
        }`}
        title="When off, Marina still logs and classifies work here but never places it on your calendar"
      >
        {schedulingOn ? <Zap size={11} /> : <ZapOff size={11} />}
        {schedulingOn ? 'Scheduling: on' : 'Scheduling: off'}
      </button>
    </div>
  );
}
