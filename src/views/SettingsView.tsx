import { MobileSettingsSection } from '../components/MobileSettingsSection';
import { MobileDisplaySettings } from '../components/MobileDisplaySettings';
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Calendar, AlertTriangle, CheckCircle, Info, Database, RefreshCw, Download, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useSchedulePrefs, useScheduleOverrides, useUpsertScheduleOverride, useDeleteScheduleOverride, useEntityAliases, useDeleteEntityAlias, useDataReadiness } from '../api/hooks';
import { apiFetch, apiPut } from '../utils/apiFetch';

interface ProviderSummary {
  mode: 'local' | 'hybrid' | 'cloud';
  chat: { provider: string; model: string; fallback: string };
  embeddings: { provider: string; model: string; dimension: number; sends_raw_text_to_cloud: boolean };
}

interface HealthData {
  status: 'ok' | 'degraded';
  db: 'connected' | 'error';
  ollama: 'ok' | 'unavailable';
  embed_model: string;
  embed_dimension: number;
  queue: Record<string, number>;
  schema_version: string | null;
  migration_count: number;
  provider?: ProviderSummary;
  timestamp: string;
}

interface GoogleSyncStatus {
  configured: boolean;
  missing_configuration: string[];
  schema_ready: boolean;
  connected: boolean;
  account_email?: string | null;
  calendar_name?: string;
  initial_sync_complete?: boolean;
  auto_sync_enabled?: boolean;
  last_synced_at?: string | null;
  last_error?: string | null;
  sync_running?: boolean;
  conflicts?: number;
  errors?: number;
}

interface GoogleSyncPreview {
  goals_as_task_lists: number;
  one_off_task_list: boolean;
  tasks: number;
  timed_schedule_blocks: number;
  meetings: number;
  all_day_tasks: number;
  repeating_blocks_skipped: number;
}

function useHealth() {
  const [health, setHealth] = useState<HealthData | null>(null);
  useEffect(() => {
    apiFetch<HealthData>('/api/health').then(setHealth).catch(() => {});
  }, []);
  return health;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  goal: 'Goal', task: 'Task', meeting: 'Meeting', resource: 'Resource', milestone: 'Milestone', note: 'Note',
};

// ── AI preferences adjuster ───────────────────────────────────────────────────
// Describe your week in plain language → the model proposes prefs changes and
// day overrides → shown as a DIFF → nothing saves until you hit Apply.

interface PrefsSuggestion {
  reply: string;
  current: Record<string, unknown>;
  updates: Partial<{
    work_days: number[];
    daily_capacity_minutes: number;
    buffer_ratio: number;
    work_start: number;
    work_end: number;
  }>;
  day_overrides: Array<{ date: string; available_minutes: number; note?: string }>;
}

const PREF_LABELS: Record<string, string> = {
  work_days: 'Work days',
  daily_capacity_minutes: 'Daily capacity (min)',
  buffer_ratio: 'Buffer',
  work_start: 'Start time',
  work_end: 'End time',
};

const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fmtPrefVal = (k: string, v: unknown): string => {
  if (v === undefined || v === null) return '—';
  if (k === 'work_days') {
    const arr = Array.isArray(v) ? v : (() => { try { return JSON.parse(String(v)); } catch { return []; } })();
    return (arr as number[]).map(d => DAY_SHORT[d] ?? d).join(' ');
  }
  if (k === 'buffer_ratio') return `${Math.round(Number(v) * 100)}%`;
  return String(v);
};

function PrefsAIAdjuster({ onApplied }: { onApplied: () => void }) {
  const { triggerToast } = useAppStore();
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [sugg, setSugg] = useState<PrefsSuggestion | null>(null);
  const upsertOverride = useUpsertScheduleOverride();

  const ask = async () => {
    setBusy(true);
    setSugg(null);
    try {
      const r = await apiFetch<PrefsSuggestion>('/api/ai/prefs/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      setSugg(r);
      if (!Object.keys(r.updates).length && !r.day_overrides.length) {
        triggerToast('No changes proposed — your preferences already match that.', 'info');
      }
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!sugg) return;
    setBusy(true);
    try {
      if (Object.keys(sugg.updates).length) {
        // Merge: only send changed fields on top of current values
        const merged: Record<string, unknown> = {
          work_days: sugg.updates.work_days ? JSON.stringify(sugg.updates.work_days) : sugg.current.work_days,
          daily_capacity_minutes: sugg.updates.daily_capacity_minutes ?? sugg.current.daily_capacity_minutes,
          buffer_ratio: sugg.updates.buffer_ratio ?? sugg.current.buffer_ratio,
          work_start: sugg.updates.work_start ?? sugg.current.work_start,
          work_end: sugg.updates.work_end ?? sugg.current.work_end,
        };
        await apiPut('/api/schedule-prefs', merged);
      }
      for (const o of sugg.day_overrides) {
        await upsertOverride.mutateAsync({ date: o.date, available_minutes: o.available_minutes, note: o.note });
      }
      triggerToast('Preferences updated.', 'success');
      setSugg(null);
      setMsg('');
      qc.invalidateQueries({ queryKey: ['schedule-prefs'] });
      qc.invalidateQueries({ queryKey: ['schedule-preview'] });
      qc.invalidateQueries({ queryKey: ['schedule-overrides'] });
      onApplied();
    } catch (e) {
      triggerToast(`Apply failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const changedKeys = sugg ? Object.keys(sugg.updates) : [];

  return (
    <div className="mb-5 rounded-xl border border-[#c0c1ff]/60 bg-[#EEF2FF]/60 p-3.5">
      <p className="text-[11px] font-bold text-[#4648d4] mb-1">Adjust with AI</p>
      <p className="text-[10px] text-gray-500 mb-2">
        Describe your week — “I’m traveling Mon–Wed, only mornings” or “give me lighter Fridays” —
        and review the proposed changes before anything saves.
      </p>
      <div className="flex gap-2">
        <label htmlFor="settings-ai-adjuster" className="sr-only">Describe schedule preference changes</label>
        <input
          id="settings-ai-adjuster"
          value={msg}
          onChange={e => setMsg(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && msg.trim() && !busy && ask()}
          placeholder="How is your week actually looking?"
          className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#4648d4]"
        />
        <button
          onClick={ask}
          disabled={!msg.trim() || busy}
          aria-label="Suggest schedule preference changes"
          className="px-3 py-2 rounded-lg text-[11px] font-bold bg-[#4648d4] text-white hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
        >
          {busy ? <RefreshCw size={11} className="animate-spin" /> : null}
          Suggest
        </button>
      </div>

      {sugg && (changedKeys.length > 0 || sugg.day_overrides.length > 0) && (
        <div className="mt-3 bg-white border border-gray-200 rounded-lg p-3">
          {sugg.reply && <p className="text-[11px] text-gray-600 mb-2 leading-relaxed">{sugg.reply}</p>}
          {changedKeys.length > 0 && (
            <table className="w-full text-[11px] mb-2">
              <tbody>
                {changedKeys.map(k => (
                  <tr key={k} className="border-t border-gray-50">
                    <td className="py-1 text-gray-500">{PREF_LABELS[k] ?? k}</td>
                    <td className="py-1 text-gray-400 line-through">{fmtPrefVal(k, sugg.current[k])}</td>
                    <td className="py-1 font-bold text-gray-800">{fmtPrefVal(k, (sugg.updates as Record<string, unknown>)[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sugg.day_overrides.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] font-mono text-gray-400 uppercase mb-1">One-off day changes</p>
              {sugg.day_overrides.map(o => (
                <p key={o.date} className="text-[11px] text-gray-600">
                  <span className="font-mono">{o.date}</span> → <b>{o.available_minutes} min</b>
                  {o.note ? <span className="text-gray-400"> — {o.note}</span> : null}
                </p>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={apply} disabled={busy} className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:opacity-90 disabled:opacity-40">
              Apply changes
            </button>
            <button onClick={() => setSugg(null)} className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-white text-gray-500 border border-gray-200 hover:bg-gray-50">
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EntityAliasesSection() {
  const { data: aliases = [] } = useEntityAliases({ created_by: 'ai' });
  const deleteAlias = useDeleteEntityAlias();
  const [filter, setFilter] = useState('');

  const filtered = filter
    ? aliases.filter(a =>
        a.alias.toLowerCase().includes(filter.toLowerCase()) ||
        (a.entity_title ?? '').toLowerCase().includes(filter.toLowerCase()) ||
        a.entity_type.toLowerCase().includes(filter.toLowerCase()),
      )
    : aliases;

  return (
    <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black">AI-Learned Aliases</h3>
        <span className="text-[10px] text-gray-400 font-mono">{aliases.length} total</span>
      </div>
      <p className="text-xs text-gray-400 mb-3">
        These are names Marina learned for your goals, tasks, meetings, and resources. Delete any that are wrong.
      </p>
      {aliases.length > 6 && (
        <input
          id="settings-alias-filter"
          aria-label="Filter AI-learned aliases"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter aliases..."
          className="w-full text-xs rounded-lg border border-gray-200 p-2 mb-3 focus:ring-1 focus:ring-black outline-none"
        />
      )}
      {filtered.length === 0 ? (
        <p className="text-xs text-gray-300 italic">No AI-learned aliases yet.</p>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
          {filtered.map(a => (
            <div key={a.id} className="flex items-center gap-2 group">
              <span className="inline-block text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0 w-20 text-center">
                {ENTITY_TYPE_LABELS[a.entity_type] ?? a.entity_type}
              </span>
              <span className="text-xs text-gray-600 truncate flex-1">
                <span className="font-semibold text-black">{a.alias}</span>
                {a.entity_title && <span className="text-gray-400"> → {a.entity_title}</span>}
              </span>
              <button
                onClick={() => deleteAlias.mutate(a.id)}
                disabled={deleteAlias.isPending}
                aria-label={`Delete alias ${a.alias}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-200 opacity-0 transition-colors hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 focus:opacity-100"
                title="Delete alias"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function decimalToTime(decimal: number): string {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToDecimal(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + (m ?? 0) / 60;
}

function SchedulePrefsSection({ onSave }: { onSave: (msg: string) => void }) {
  const { data: prefs } = useSchedulePrefs();

  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [workStart, setWorkStart] = useState('09:00');
  const [workEnd, setWorkEnd] = useState('18:00');
  const [capacity, setCapacity] = useState(480);
  const [deepStart, setDeepStart] = useState('09:00');
  const [deepEnd, setDeepEnd] = useState('12:00');
  const [buffer, setBuffer] = useState(15);
  const [timezone, setTimezone] = useState('Asia/Beirut');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!prefs) return;
    try {
      setWorkDays(JSON.parse(prefs.work_days as unknown as string));
    } catch { /* */ }
    setWorkStart(decimalToTime(Number(prefs.work_start)));
    setWorkEnd(decimalToTime(Number(prefs.work_end)));
    setCapacity(Number(prefs.daily_capacity_minutes ?? 480));
    setDeepStart(decimalToTime(Number(prefs.deep_work_start ?? 9)));
    setDeepEnd(decimalToTime(Number(prefs.deep_work_end ?? 12)));
    setBuffer(Math.round(Number((prefs as unknown as Record<string, unknown>).buffer_ratio ?? 0.15) * 100));
    setTimezone(String((prefs as unknown as Record<string, unknown>).timezone ?? 'Asia/Beirut'));
  }, [prefs]);

  const effective = Math.round(capacity * (1 - buffer / 100));

  const toggleDay = (d: number) => setWorkDays(ds => ds.includes(d) ? ds.filter(x => x !== d) : [...ds, d].sort((a, b) => a - b));

  const handleSave = async () => {
    setSaving(true);
    try {
      // apiPut throws on non-2xx — a rejected save must NOT report success
      await apiPut('/api/schedule-prefs', {
        work_days: JSON.stringify(workDays),
        work_start: timeToDecimal(workStart),
        work_end: timeToDecimal(workEnd),
        daily_capacity_minutes: capacity,
        deep_work_start: timeToDecimal(deepStart),
        deep_work_end: timeToDecimal(deepEnd),
        buffer_ratio: buffer / 100,
        timezone: timezone.trim() || 'Asia/Beirut',
      });
      onSave('Work schedule saved.');
    } catch (e) {
      onSave(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
      <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black mb-4">Work Schedule</h3>

      <PrefsAIAdjuster onApplied={() => { /* prefs query invalidated inside */ }} />

      <div className="space-y-4 text-sm">
        {/* Work days */}
        <div>
          <label className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-2">Work Days</label>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((label, i) => {
              const val = i + 1;
              return (
                <button
                key={val}
                onClick={() => toggleDay(val)}
                aria-pressed={workDays.includes(val)}
                className={`px-2.5 py-1 text-[10px] font-mono uppercase rounded-lg border transition-colors ${
                    workDays.includes(val)
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Work hours */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="settings-work-start" className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-1">Start Time</label>
            <input id="settings-work-start" type="time" value={workStart} onChange={e => setWorkStart(e.target.value)}
              className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-400" />
          </div>
          <div>
            <label htmlFor="settings-work-end" className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-1">End Time</label>
            <input id="settings-work-end" type="time" value={workEnd} onChange={e => setWorkEnd(e.target.value)}
              className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-400" />
          </div>
        </div>

        {/* Deep work window */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="settings-deep-start" className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-1">Deep Work Start</label>
            <input id="settings-deep-start" type="time" value={deepStart} onChange={e => setDeepStart(e.target.value)}
              className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-400" />
          </div>
          <div>
            <label htmlFor="settings-deep-end" className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-1">Deep Work End</label>
            <input id="settings-deep-end" type="time" value={deepEnd} onChange={e => setDeepEnd(e.target.value)}
              className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-400" />
          </div>
        </div>

        {/* Daily capacity */}
        <div>
          <label htmlFor="settings-daily-capacity" className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-1">
            Daily Capacity — {capacity} min ({(capacity / 60).toFixed(1)} hrs)
          </label>
          <input id="settings-daily-capacity" type="number" min={60} max={720} step={30} value={capacity}
            onChange={e => setCapacity(Number(e.target.value))}
            className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-400" />
        </div>

        {/* Buffer ratio */}
        <div>
          <label htmlFor="settings-buffer" className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-1">
            Buffer — {buffer}% · Effective capacity: <strong>{effective} min</strong> ({(effective / 60).toFixed(1)} hrs)
          </label>
          <input id="settings-buffer" type="range" min={0} max={50} step={5} value={buffer}
            onChange={e => setBuffer(Number(e.target.value))}
            className="w-full accent-indigo-600" />
        </div>

        {/* Timezone */}
        <div>
          <label htmlFor="settings-timezone" className="text-xs text-gray-500 font-mono uppercase tracking-wider block mb-1">Timezone (IANA)</label>
          <input
            id="settings-timezone"
            type="text"
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            placeholder="e.g. Asia/Beirut, America/New_York"
            className="w-full text-xs font-mono border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-400"
          />
          <p className="text-[10px] text-gray-400 mt-1">Used by the scheduler and journal ingestion to determine today's date in your local time.</p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : 'Save Schedule'}
        </button>
      </div>
    </div>
  );
}

function ScheduleOverridesSection({ onSave }: { onSave: (msg: string, type?: 'success' | 'error') => void }) {
  const { data: overrides } = useScheduleOverrides();
  const upsert = useUpsertScheduleOverride();
  const remove = useDeleteScheduleOverride();

  // Use local date (not UTC) so midnight in Beirut gives the correct calendar day
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const [date, setDate] = useState(todayStr);
  const [minutes, setMinutes] = useState<string>('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!date) { onSave('Date is required.', 'error'); return; }
    const m = minutes !== '' ? Number(minutes) : null;
    if (m !== null && (isNaN(m) || m < 0 || m > 1440)) {
      onSave('Available minutes must be 0–1440.', 'error'); return;
    }
    setAdding(true);
    try {
      await upsert.mutateAsync({ date, available_minutes: m, note: note.trim() || undefined });
      onSave(`Override saved for ${date}.`);
      setDate(todayStr);
      setMinutes('');
      setNote('');
    } catch {
      onSave('Failed to save override.', 'error');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (d: string) => {
    await remove.mutateAsync(d);
    onSave(`Removed override for ${d}.`);
  };

  return (
    <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
      <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black mb-3 flex items-center gap-2">
        <Calendar size={12} className="text-indigo-500" />
        Schedule Day Overrides
      </h3>
      <p className="text-[11px] text-gray-400 mb-4">
        Override availability for specific dates — e.g. vacations, sick days, or extra-capacity days.
      </p>

      {/* Add form */}
      <div className="grid grid-cols-1 gap-2 mb-4 items-end sm:grid-cols-[1fr_auto_1fr_auto]">
        <div>
          <label htmlFor="settings-override-date" className="text-[10px] font-mono text-gray-400 uppercase tracking-wider block mb-1">Date</label>
          <input id="settings-override-date" type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full text-xs font-mono border border-gray-200 rounded-lg px-2.5 py-2 outline-none focus:border-indigo-400" />
        </div>
        <div>
          <label htmlFor="settings-override-minutes" className="text-[10px] font-mono text-gray-400 uppercase tracking-wider block mb-1">Avail. Min</label>
          <input id="settings-override-minutes" type="number" min={0} max={1440} step={30} placeholder="480"
            value={minutes} onChange={e => setMinutes(e.target.value)}
            className="w-full text-xs font-mono border border-gray-200 rounded-lg px-2.5 py-2 outline-none focus:border-indigo-400 sm:w-24" />
        </div>
        <div>
          <label htmlFor="settings-override-note" className="text-[10px] font-mono text-gray-400 uppercase tracking-wider block mb-1">Note</label>
          <input id="settings-override-note" type="text" placeholder="e.g. vacation" value={note} onChange={e => setNote(e.target.value)}
            className="w-full text-xs font-mono border border-gray-200 rounded-lg px-2.5 py-2 outline-none focus:border-indigo-400" />
        </div>
        <button
          onClick={handleAdd}
          disabled={adding}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors self-end"
          aria-label="Add schedule day override"
        >
          {adding ? '…' : 'Add'}
        </button>
      </div>

      {/* Existing overrides list */}
      {(overrides ?? []).length === 0 ? (
        <p className="text-[11px] font-mono text-gray-400">No overrides in the next 60 days.</p>
      ) : (
        <div className="space-y-1.5">
          {(overrides ?? []).map(o => (
            <div key={o.date} className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 rounded-lg text-xs">
              <span className="font-mono text-gray-700 font-semibold">{o.date}</span>
              <span className="text-gray-500">
                {o.available_minutes != null ? `${o.available_minutes} min` : 'no override'}
                {o.note ? ` · ${o.note}` : ''}
              </span>
              <button
                onClick={() => handleDelete(o.date)}
                className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                title="Remove override"
                aria-label={`Remove schedule override for ${o.date}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DataReadinessSection() {
  const { data, isLoading, refetch } = useDataReadiness();

  const severityIcon = (severity: string) => {
    if (severity === 'warning') return <AlertTriangle size={11} className="text-amber-400 shrink-0" />;
    return <Info size={11} className="text-gray-400 shrink-0" />;
  };

  return (
    <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black">Data Readiness</h3>
        <div className="flex items-center gap-2">
          {data && (
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${data.ok ? 'border-green-200 bg-green-50 text-green-600' : 'border-amber-200 bg-amber-50 text-amber-600'}`}>
              {data.ok ? '✓ All clear' : `${data.total_gaps} gaps`}
            </span>
          )}
          <button onClick={() => refetch()} className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors" aria-label="Refresh data readiness">Refresh</button>
        </div>
      </div>
      <p className="text-xs text-gray-400 mb-3">Planning gaps that may reduce AI accuracy — these are informational, not errors.</p>
      {isLoading && <p className="text-xs text-gray-400">Checking…</p>}
      {data && (
        <div className="space-y-1.5">
          {data.items.map(item => (
            <div key={item.bucket} className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${item.count > 0 ? (item.severity === 'warning' ? 'bg-amber-50 border border-amber-100' : 'bg-gray-50 border border-gray-100') : 'bg-gray-50 border border-gray-100 opacity-40'}`}>
              {item.count > 0 ? severityIcon(item.severity) : <CheckCircle size={11} className="text-green-400 shrink-0" />}
              <span className="flex-1 text-gray-600">{item.description}</span>
              <span className={`font-mono font-bold shrink-0 ${item.count > 0 ? (item.severity === 'warning' ? 'text-amber-600' : 'text-gray-500') : 'text-green-500'}`}>{item.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const INVENTORY_LABELS: Record<string, string> = {
  goals: 'Goals', tasks: 'Tasks', goal_milestones: 'Milestones', goal_deadlines: 'Deadlines',
  meetings: 'Meetings', events: 'Events', work_sessions: 'Work Sessions', resources: 'Resources',
  resource_chunks: 'Doc Chunks', journal_entries: 'Journal Entries', embeddings: 'Embeddings',
  embedding_jobs: 'Embed. Jobs', entity_summaries: 'Summaries', ai_action_proposals: 'Proposals',
  edges: 'Graph Edges', chat_sessions: 'Chat Sessions', chat_messages: 'Chat Messages',
  topics: 'Topics', topic_memberships: 'Topic Members', suggestion_runs: 'Suggestion Runs',
};

// ── Backups ───────────────────────────────────────────────────────────────────

interface BackupList {
  available?: boolean;
  reason?: string;
  dir?: string;
  keep_last?: number;
  pg_dump_available?: boolean;
  backups: Array<{ name: string; bytes: number; created_at: string }>;
  portable_export: {
    available: boolean;
    reason: string | null;
    storage: 'local' | 'private_blob';
    includes_database: true;
    includes_files: true;
  };
  portable_backups: Array<{
    name: string;
    bytes: number;
    created_at: string;
    storage: 'local' | 'private_blob';
  }>;
}

interface PortableBackupCreated {
  filename: string;
  bytes: number;
  table_count: number;
  row_count: number;
  file_count: number;
  file_bytes: number;
  storage: 'local' | 'private_blob';
  download_url: string;
  expires_at: string | null;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function CompleteBackupsSection() {
  const { triggerToast, showConfirm } = useAppStore();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery<BackupList>({
    queryKey: ['backups'],
    queryFn: () => apiFetch<BackupList>('/api/backups'),
    staleTime: 30_000,
  });

  const createComplete = async () => {
    setBusy(true);
    try {
      const result = await apiFetch<PortableBackupCreated>('/api/backups/portable', { method: 'POST' });
      const link = document.createElement('a');
      link.href = result.download_url;
      link.download = result.filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      triggerToast(`Complete backup ready: ${result.row_count} rows + ${result.file_count} files`, 'success');
      qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (error) {
      triggerToast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = (name: string) => {
    showConfirm(`Delete complete backup ${name}? Keep a downloaded copy first.`, async () => {
      await apiFetch(`/api/backups/portable/${encodeURIComponent(name)}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['backups'] });
      triggerToast('Complete backup deleted.', 'info');
    });
  };

  return (
    <div className="bg-white border border-indigo-100 p-5 rounded-xl shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black flex items-center gap-2">
            <ShieldCheck size={13} className="text-[#4648d4]" />
            Complete disaster backup
          </h3>
          <p className="text-[11px] text-gray-500 mt-2 max-w-lg">
            One private ZIP with every PostgreSQL table and every Resource/task-note file, plus SHA-256 checksums.
          </p>
        </div>
        <button
          onClick={createComplete}
          disabled={busy || !data || data.portable_export.available === false}
          aria-label="Download complete database and file backup"
          className="px-3 py-2 rounded-lg text-[11px] font-bold bg-[#4648d4] text-white hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5 shrink-0"
        >
          {busy ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
          {busy ? 'Building…' : 'Download everything'}
        </button>
      </div>
      {data?.portable_export?.available === false && (
        <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mt-3">
          {data.portable_export.reason}
        </p>
      )}
      <p className="text-[10px] text-gray-400 font-mono mt-3">
        Verify after download: npm run backup:verify -- &lt;file.zip&gt;
      </p>
      <div className="space-y-1 max-h-44 overflow-y-auto mt-3">
        {(data?.portable_backups ?? []).length === 0 && (
          <p className="text-[11px] text-gray-300 font-mono">no complete backups created yet</p>
        )}
        {(data?.portable_backups ?? []).map(backup => (
          <div key={backup.name} className="flex items-center gap-2 text-[11px] border border-gray-100 rounded-lg px-2.5 py-1.5">
            <span className="font-mono text-gray-700 truncate flex-1">{backup.name}</span>
            <span className="text-gray-400 shrink-0">{fmtBytes(backup.bytes)}</span>
            <span className="text-gray-300 font-mono shrink-0">
              {new Date(backup.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            <a href={`/api/backups/portable/${encodeURIComponent(backup.name)}/download`} className="text-[#4648d4] hover:underline shrink-0" title="Download complete backup">
              download
            </a>
            <button onClick={() => remove(backup.name)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-300 hover:bg-red-50 hover:text-red-500" title="Delete complete backup" aria-label={`Delete complete backup ${backup.name}`}>
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BackupsSection() {
  const { triggerToast, showConfirm } = useAppStore();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery<BackupList>({
    queryKey: ['backups'],
    queryFn: () => apiFetch<BackupList>('/api/backups'),
    staleTime: 30_000,
  });

  const createNow = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<{ file: string; bytes: number }>('/api/backups', { method: 'POST' });
      triggerToast(`Backup created: ${r.file} (${fmtBytes(r.bytes)})`, 'success');
      qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = (name: string) => {
    showConfirm(`Delete backup ${name}? This file cannot be recovered.`, async () => {
      await apiFetch(`/api/backups/${name}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['backups'] });
      triggerToast('Backup deleted.', 'info');
    });
  };

  return (
    <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black">Database Backups</h3>
            <button
              onClick={createNow}
              disabled={busy || data?.available === false || data?.pg_dump_available === false}
              aria-label="Create database backup now"
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-[#4648d4] text-white hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
        >
          {busy ? <RefreshCw size={11} className="animate-spin" /> : null}
          Back up now
        </button>
      </div>
      <p className="text-[11px] text-gray-400 mb-1">
        Automatic backup runs daily (1 min after server start, then every 24h); the newest {data?.keep_last ?? 14} are kept.
        Files live in <code className="bg-gray-100 px-1 rounded text-[10px]">{data?.dir ?? 'server/backups'}</code>.
      </p>
      {data?.pg_dump_available === false && (
        <p className="text-[11px] text-red-500 mb-2">⚠ pg_dump not found — set <code className="bg-gray-100 px-1 rounded text-[10px]">PG_DUMP_PATH</code> in .env</p>
      )}
      <p className="text-[10px] text-gray-400 mb-3 font-mono">
        Restore (manual, deliberate): pg_restore -d &lt;DATABASE_URL&gt; --clean --if-exists &lt;file&gt;
      </p>
      <div className="space-y-1 max-h-56 overflow-y-auto">
        {(data?.backups ?? []).length === 0 && <p className="text-[11px] text-gray-300 font-mono">no backups yet</p>}
        {(data?.backups ?? []).map(b => (
          <div key={b.name} className="flex items-center gap-2 text-[11px] border border-gray-100 rounded-lg px-2.5 py-1.5">
            <span className="font-mono text-gray-700 truncate flex-1">{b.name}</span>
            <span className="text-gray-400 shrink-0">{fmtBytes(b.bytes)}</span>
            <span className="text-gray-300 font-mono shrink-0">{new Date(b.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <a
              href={`/api/backups/${b.name}/download`}
              className="text-[#4648d4] hover:underline shrink-0"
              title="Download this backup file"
            >
              download
            </a>
            <button onClick={() => remove(b.name)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-300 hover:bg-red-50 hover:text-red-500" title="Delete backup" aria-label={`Delete backup ${b.name}`}>
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function useInventory() {
  const [data, setData] = useState<{ tables: Record<string, number>; timestamp: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = () => {
    setLoading(true);
    apiFetch<{ tables: Record<string, number>; timestamp: string }>('/api/inventory')
      .then(setData).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);
  return { data, loading, refresh };
}

function DBInventorySection() {
  const { data, loading, refresh } = useInventory();

  const displayKeys = Object.keys(INVENTORY_LABELS);
  const rows = displayKeys.map(k => ({ key: k, label: INVENTORY_LABELS[k], count: data?.tables[k] ?? null }));

  return (
    <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black flex items-center gap-2">
          <Database size={12} className="text-indigo-500" />
          Database Inventory
        </h3>
        <button
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh database inventory"
          className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      <p className="text-[11px] text-gray-400 mb-3">Read-only row counts — your data, live from PostgreSQL.</p>
      {!data && !loading && <p className="text-xs text-gray-400">No data yet.</p>}
      {loading && <p className="text-xs text-gray-400">Loading…</p>}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          {rows.map(r => (
            <div key={r.key} className="flex items-center justify-between py-1 border-b border-gray-50 last:border-0">
              <span className="text-[11px] text-gray-600">{r.label}</span>
              <span className={`font-mono text-[11px] font-bold ${r.count === null || r.count < 0 ? 'text-gray-300' : r.count > 0 ? 'text-gray-800' : 'text-gray-300'}`}>
                {r.count === null ? '…' : r.count < 0 ? 'N/A' : r.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
      {data && (
        <p className="text-[9px] font-mono text-gray-300 mt-3 text-right">
          as of {new Date(data.timestamp).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function GoogleWorkspaceSection() {
  const { triggerToast, showConfirm } = useAppStore();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'connect' | 'sync' | 'toggle' | 'disconnect' | null>(null);
  const statusQuery = useQuery<GoogleSyncStatus>({
    queryKey: ['google-sync-status'],
    queryFn: () => apiFetch<GoogleSyncStatus>('/api/google/status'),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const status = statusQuery.data;
  const previewQuery = useQuery<GoogleSyncPreview>({
    queryKey: ['google-sync-preview'],
    queryFn: () => apiFetch<GoogleSyncPreview>('/api/google/preview'),
    enabled: Boolean(status?.connected && status.schema_ready && !status.initial_sync_complete),
    staleTime: 10_000,
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('google');
    if (!result) return;
    const message = params.get('google_message');
    if (result === 'connected') triggerToast('Google connected. Review the preview before the first sync.', 'success');
    else triggerToast(message || 'Google connection failed.', 'error');
    params.delete('google');
    params.delete('google_message');
    const queryString = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${queryString ? `?${queryString}` : ''}${window.location.hash}`);
    statusQuery.refetch();
  }, [statusQuery, triggerToast]);

  const connect = async () => {
    setBusy('connect');
    try {
      const result = await apiFetch<{ authorization_url: string }>('/api/google/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ return_to: '/?google=connected' }),
      });
      window.location.assign(result.authorization_url);
    } catch (error) {
      triggerToast((error as Error).message, 'error');
      setBusy(null);
    }
  };

  const sync = async (confirmInitial = false) => {
    setBusy('sync');
    try {
      const result = await apiFetch<{ stats: Record<string, number> }>('/api/google/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_initial: confirmInitial }),
      });
      const changed = Object.entries(result.stats).filter(([key, value]) => value > 0 && key !== 'skipped');
      triggerToast(changed.length ? `Google sync finished · ${changed.reduce((sum, [, value]) => sum + value, 0)} updates` : 'Google is already up to date.', 'success');
      await Promise.all([
        statusQuery.refetch(),
        qc.invalidateQueries({ queryKey: ['goals'] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: ['events'] }),
        qc.invalidateQueries({ queryKey: ['meetings'] }),
        qc.invalidateQueries({ queryKey: ['schedule-preview'] }),
      ]);
    } catch (error) {
      triggerToast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleAutoSync = async () => {
    if (!status?.connected) return;
    setBusy('toggle');
    try {
      await apiFetch('/api/google/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_sync_enabled: !status.auto_sync_enabled }),
      });
      await statusQuery.refetch();
      triggerToast(!status.auto_sync_enabled ? 'Live Google sync enabled.' : 'Automatic Google sync paused.', 'success');
    } catch (error) {
      triggerToast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const disconnect = () => {
    showConfirm('Disconnect Google? Marina will keep all of your Google tasks and calendar events, but live updates will stop.', async () => {
      setBusy('disconnect');
      try {
        await apiFetch('/api/google/connection', { method: 'DELETE' });
        await statusQuery.refetch();
        triggerToast('Google disconnected. Existing Google data was kept.', 'success');
      } catch (error) {
        triggerToast((error as Error).message, 'error');
      } finally {
        setBusy(null);
      }
    });
  };

  const preview = previewQuery.data;
  const lastSync = status?.last_synced_at ? new Date(status.last_synced_at).toLocaleString() : null;

  return (
    <section className="overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-sm">
      <div className="border-b border-blue-100 bg-gradient-to-r from-blue-50 via-white to-indigo-50 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
              <Calendar size={19} />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900">Google Tasks + Calendar</h3>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-500">
                Marina stays the organized home. Google becomes the always-available copy you can check and update anywhere.
              </p>
            </div>
          </div>
          {status?.connected ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700">
              <CheckCircle size={11} /> Connected{status.account_email ? ` · ${status.account_email}` : ''}
            </span>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ['Goals', 'One Google Tasks list per goal'],
            ['Tasks', 'Flattened leaves appear as Parent: Child; full paths stay in Marina'],
            ['One-offs', 'Collected in an Marina · One-offs list'],
            ['Schedule', 'Focus blocks and meetings use Marina Schedule'],
            ['All-day work', 'Tasks without a time stay as all-day items'],
            ['Changes', 'Dates, titles, completion, and time edits sync back'],
          ].map(([label, text]) => (
            <div key={label} className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">{label}</p>
              <p className="mt-0.5 text-xs text-slate-600">{text}</p>
            </div>
          ))}
        </div>

        {!status && statusQuery.isLoading ? (
          <p className="text-xs text-slate-400">Checking Google connection…</p>
        ) : status && (!status.configured || !status.schema_ready) ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5">
            <div className="flex gap-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
              <div>
                <p className="text-xs font-bold text-amber-900">Activation is safely paused</p>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
                  {!status.schema_ready
                    ? 'The integration code is ready, but its new empty sync tables have not been added to the production database.'
                    : `The Vercel environment still needs: ${status.missing_configuration.join(', ')}.`}
                  {' '}Your existing goals, tasks, and schedule have not been changed.
                </p>
              </div>
            </div>
          </div>
        ) : status?.connected ? (
          <>
            {!status.initial_sync_complete && preview ? (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-4">
                <div className="flex items-start gap-2">
                  <ShieldCheck size={17} className="mt-0.5 shrink-0 text-indigo-600" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-indigo-950">First-sync preview — nothing has been copied yet</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {[
                        [`${preview.goals_as_task_lists}`, 'goal lists'],
                        [`${preview.tasks}`, 'tasks'],
                        [`${preview.timed_schedule_blocks}`, 'focus blocks'],
                        [`${preview.meetings}`, 'meetings'],
                        [`${preview.all_day_tasks}`, 'all-day tasks'],
                        [`${preview.repeating_blocks_skipped}`, 'repeaters skipped'],
                      ].map(([value, label]) => (
                        <div key={label} className="rounded-lg bg-white px-3 py-2 text-center shadow-sm">
                          <p className="text-lg font-black text-indigo-700">{value}</p>
                          <p className="text-[10px] text-slate-500">{label}</p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-[11px] leading-relaxed text-indigo-800">
                      First sync creates dedicated Marina lists and one Marina Schedule calendar. It never deletes existing Google or Marina data.
                    </p>
                    <button
                      type="button"
                      onClick={() => sync(true)}
                      disabled={busy !== null}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-indigo-500 disabled:opacity-40"
                    >
                      <RefreshCw size={12} className={busy === 'sync' ? 'animate-spin' : ''} />
                      Start first sync
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold text-slate-800">{status.calendar_name || 'Marina Schedule'}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {status.sync_running ? 'Syncing now…' : lastSync ? `Last synced ${lastSync}` : 'Ready for the first update'}
                      {status.conflicts ? ` · ${status.conflicts} conflict${status.conflicts === 1 ? '' : 's'} need review` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => sync(false)}
                    disabled={busy !== null || status.sync_running}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    <RefreshCw size={12} className={busy === 'sync' || status.sync_running ? 'animate-spin' : ''} />
                    Sync now
                  </button>
                </div>
                {status.last_error ? <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-[11px] text-red-700">{status.last_error}</p> : null}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={Boolean(status.auto_sync_enabled)}
                  onChange={toggleAutoSync}
                  disabled={busy !== null || !status.initial_sync_complete}
                  className="h-4 w-4 accent-blue-600"
                />
                Live sync while Marina is open
              </label>
              <button type="button" onClick={disconnect} disabled={busy !== null} className="text-[11px] font-semibold text-slate-400 hover:text-red-600 disabled:opacity-40">
                Disconnect Google
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3.5">
            <div>
              <p className="text-xs font-bold text-slate-800">Connect your Google account</p>
              <p className="mt-0.5 text-[11px] text-slate-500">You will approve Google Tasks and Marina’s own secondary calendar.</p>
            </div>
            <button
              type="button"
              onClick={connect}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-blue-500 disabled:opacity-40"
            >
              {busy === 'connect' ? <RefreshCw size={12} className="animate-spin" /> : <Calendar size={12} />}
              Connect Google
            </button>
          </div>
        )}

        <p className="text-[10px] leading-relaxed text-slate-400">
          Google Calendar supports fast change notifications. Google Tasks currently requires polling, so Marina checks about every two minutes while open and immediately after your Marina edits. Google deletions never delete Marina data automatically.
        </p>
      </div>
    </section>
  );
}

export function SettingsView() {
  const {
    triggerToast,
    showConfirm,
    goalCategories,
    addGoalCategory,
    removeGoalCategory,
  } = useAppStore();
  const [categoryInput, setCategoryInput] = useState('');
  const health = useHealth();

  const handleAddCategory = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = categoryInput.trim();
    if (!trimmed) {
      triggerToast('Name the umbrella first.', 'error');
      return;
    }
    if (goalCategories.some(c => c.toLowerCase() === trimmed.toLowerCase())) {
      triggerToast('That umbrella already exists.', 'info');
      return;
    }
    addGoalCategory(trimmed);
    setCategoryInput('');
    triggerToast(`Umbrella "${trimmed}" added.`, 'success');
  };

  const handleRemoveCategory = (category: string) => {
    if (goalCategories.length <= 1) {
      triggerToast('Keep at least one goal umbrella.', 'error');
      return;
    }
    removeGoalCategory(category);
    triggerToast(`Umbrella "${category}" removed from new goal options.`, 'info');
  };

  return (
    <div className="max-w-[700px] mx-auto px-4 md:px-10 py-6 animate-fade-in">
      <div className="mb-8 border-b border-gray-100 pb-4">
        <h2 className="font-headline text-2xl font-black text-black mb-1">Settings</h2>
        <p className="text-sm text-gray-500">
          Your schedule, connected accounts and workspace preferences.
        </p>
      </div>

      <div className="space-y-6">
        <MobileDisplaySettings />
        <MobileSettingsSection title="Your schedule" description="Working hours and day overrides">
{/* Work Schedule */}
        <SchedulePrefsSection onSave={msg => triggerToast(msg, 'success')} />

        {/* Schedule Day Overrides */}
        <ScheduleOverridesSection onSave={(msg, type) => triggerToast(msg, type ?? 'success')} />

        </MobileSettingsSection>
        <MobileSettingsSection title="Connected accounts" description="Google Calendar and Tasks" defaultOpen={false}>
{/* Google Tasks + Calendar */}
        <GoogleWorkspaceSection />

        </MobileSettingsSection>
        <MobileSettingsSection title="Copilot" description="Model and workspace status" defaultOpen={false}>
{/* Copilot Metadata */}
        <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
          <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black mb-3">
            Copilot Metadata
          </h3>
          <div className="flex items-start gap-4">
            <div className="relative w-14 h-14 rounded-full border overflow-hidden shrink-0">
              <img
                src="https://lh3.googleusercontent.com/aida-public/AB6AXuC77RLeDDakGJQ4MP9wYcxIvZx0LhA3x49A5xlJOg4S4uEo34dcUMSBQVhKcZBFlyy4DyGXswu_nmLlGrM96KKrsDwJqdiwgn3Fq-1eo360fT94FzZEXJWyGw3kA5xy1tcXh-Gg4OaNLhI4M59l6zGRFM5KFSYJoyowOybjI-zdIKlvmZsMT3OpWwBsr7ftzsvCJZ2rsyvmpgtTinuxohWed8GXUyi1k1-OEHrRZdXUVXtQTu_RRoElUV-UE_b0WSUfslNnagddlw"
                alt="Marina AI"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-800">Marina DeepMind AI Engine</p>
              <p className="text-xs text-gray-400 mt-1">
                DB: <span className={health?.db === 'connected' ? 'text-green-400' : 'text-red-400'}>{health?.db ?? '…'}</span>
                {' · '}Chat: <span className={health?.ollama === 'ok' ? 'text-green-400' : 'text-yellow-400'}>{health?.ollama ?? '…'}</span>
                {health?.embed_model ? ` · Embed: ${health.embed_model} (${health.embed_dimension}d)` : ''}
              </p>
              {health?.provider && (
                <p className="text-[10px] font-mono mt-1">
                  <span className={`font-bold ${
                    health.provider.mode === 'local' ? 'text-green-500' :
                    health.provider.mode === 'hybrid' ? 'text-yellow-500' : 'text-orange-500'
                  }`}>
                    {health.provider.mode.toUpperCase()} MODE
                  </span>
                  {' · '}
                  <span className="text-gray-500">
                    Chat: {health.provider.chat.model}
                    {' · '}
                    Embed: {health.provider.embeddings.provider}
                    {health.provider.embeddings.sends_raw_text_to_cloud
                      ? ' (raw text sent to cloud)'
                      : health.provider.mode !== 'local' ? ' (summaries only)' : ''}
                  </span>
                </p>
              )}
              {health?.schema_version && (
                <p className="text-[10px] font-mono text-gray-500 mt-1">
                  Schema: {health.schema_version} ({health.migration_count} migrations applied)
                </p>
              )}
              {health?.queue && Object.keys(health.queue).length > 0 && (
                <p className="text-[10px] font-mono text-gray-500 mt-1">
                  Queue: {Object.entries(health.queue).map(([k, v]) => `${k}=${v}`).join(' ')}
                </p>
              )}
            </div>
          </div>
        </div>

        </MobileSettingsSection>
        <MobileSettingsSection title="Organization" description="Goal categories and entity names" defaultOpen={false}>
{/* Goal Umbrellas */}
        <div className="bg-white border border-gray-200 p-5 rounded-xl shadow-sm">
          <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-black mb-3">Goal Umbrellas</h3>

          <form onSubmit={handleAddCategory} className="flex gap-2 mb-4">
            <label htmlFor="settings-new-umbrella" className="sr-only">New goal umbrella</label>
            <input
              id="settings-new-umbrella"
              value={categoryInput}
              onChange={(e) => setCategoryInput(e.target.value)}
              placeholder="New umbrella"
              className="min-w-0 flex-1 text-xs font-sans rounded-lg border border-gray-200 p-2.5 focus:ring-1 focus:ring-black outline-none"
            />
            <button
              type="submit"
              className="bg-black text-white rounded-lg px-3 flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
              title="Add umbrella"
              aria-label="Add goal umbrella"
            >
              <Plus size={15} />
            </button>
          </form>

          <div className="flex flex-wrap gap-2">
            {goalCategories.map((category) => (
              <span
                key={category}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-[#f8f9fa] px-2.5 py-1.5 text-xs font-semibold text-gray-700"
              >
                {category}
                <button
                  type="button"
                  onClick={() => handleRemoveCategory(category)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-300"
                  disabled={goalCategories.length <= 1}
                  title="Remove umbrella"
                  aria-label={`Remove umbrella ${category}`}
                >
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Entity Aliases */}
        <EntityAliasesSection />

        </MobileSettingsSection>
        <MobileSettingsSection title="Data and backups" description="Storage, backups and data health" defaultOpen={false}>
{/* Data Readiness */}
        <DataReadinessSection />

        {/* DB Inventory */}
        <CompleteBackupsSection />
        <BackupsSection />
        <DBInventorySection />

        </MobileSettingsSection>
        <MobileSettingsSection title="About Marina" description="Technical information" defaultOpen={false}>
        {/* Tech Stack */}
        <div className="bg-[#EEF2FF] border border-[#4648d4]/10 p-5 rounded-xl">
          <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-[#4648d4] mb-3">Tech Stack</h3>
          <div className="space-y-2 text-xs text-gray-600">
            {[
              ['UI',        'React 19 + Vite 6 + TypeScript'],
              ['Styling',   'Tailwind CSS v4'],
              ['State',     'Zustand 5 (UI state only)'],
              ['Database',  'PostgreSQL + pgvector — graph-ready schema'],
              ['Editor',    'TipTap (StarterKit + Placeholder)'],
              ['Animations','Framer Motion (motion/react)'],
              ['Icons',     'Lucide React'],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center gap-3">
                <span className="font-mono text-[10px] text-[#4648d4] font-bold w-24 shrink-0">{label}</span>
                <span>{value}</span>
              </div>
            ))}
          </div>
        </div>
        </MobileSettingsSection>
      </div>
    </div>
  );
}
