import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, Trash2, ChevronRight, ChevronDown, Sparkles, Rocket, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { NeedsImplementationBadge } from '../components/NeedsImplementationBadge';
import { ModalFrame } from '../components/ModalFrame';
import { createGoal } from '../db/queries/goals';
import { createTask } from '../db/queries/tasks';
import { generateSuggestions } from '../utils/subtaskSuggestions';
import type { CriticalPathStatus } from '../db/schema';

const DEADLINES = Array.from({ length: 8 }, (_, offset) => {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + offset;
  return `Q${quarter % 4 + 1} ${now.getFullYear() + Math.floor(quarter / 4)}`;
});

const CP_STATUSES: CriticalPathStatus[] = ['In Progress', 'Future', 'Completed'];

interface MilestoneDraft {
  id: string;
  title: string;
  cpStatus: CriticalPathStatus;
  expanded: boolean;
}

interface SubtaskDraft {
  id: string;
  title: string;
}

const uid = () => crypto.randomUUID();

// ─── Step indicator ────────────────────────────────────────────────────────────
function Steps({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2 mb-6">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-mono font-bold transition-all ${
            i < current  ? 'bg-[#10B981] text-white' :
            i === current ? 'bg-[#4648d4] text-white' :
            'bg-gray-100 text-gray-400'
          }`}>
            {i < current ? <CheckCircle2 size={12} /> : i + 1}
          </div>
          {i < 3 && <div className={`h-px w-8 transition-all ${i < current ? 'bg-[#10B981]' : 'bg-gray-200'}`} />}
        </div>
      ))}
      <span className="ml-2 font-mono text-[10px] text-gray-400 uppercase tracking-widest">
        {['Foundation', 'Milestones', 'Subtasks', 'Launch'][current]}
      </span>
    </div>
  );
}

// ─── Suggestion chips ──────────────────────────────────────────────────────────
function SuggestionChips({ chips, onPick }: { chips: string[]; onPick: (s: string) => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {chips.map((chip) => (
        <button
          key={chip}
          onClick={() => onPick(chip)}
          className="flex items-center gap-1 text-[10px] font-mono bg-[#EEF2FF] hover:bg-[#dde3ff] text-[#4648d4] px-2 py-0.5 rounded-full border border-[#4648d4]/20 transition-colors"
        >
          <Sparkles size={8} />
          {chip}
        </button>
      ))}
    </div>
  );
}

export function NewGoalWizard() {
  const { closeNewGoalModal, triggerToast, navigateToGoal, goalCategories } = useAppStore();
  const categoryOptions = goalCategories.length > 0 ? goalCategories : ['General'];

  const [step, setStep] = useState(0);

  // ── Step 0 ──
  const [title, setTitle]       = useState('');
  const [category, setCategory] = useState(categoryOptions[0]);
  const [deadline, setDeadline] = useState('');

  // ── Step 1 ──
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([
    { id: uid(), title: '', cpStatus: 'In Progress', expanded: true },
  ]);

  // ── Step 2 ──
  const [subtasks, setSubtasks] = useState<Record<string, SubtaskDraft[]>>({});
  const [addInputs, setAddInputs] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});

  // ── Submit ──
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    const options = goalCategories.length > 0 ? goalCategories : ['General'];
    if (!options.includes(category)) setCategory(options[0]);
  }, [goalCategories, category]);

  // ── Step 1 helpers ──
  const addMilestone = () => {
    setMilestones(prev => [...prev, { id: uid(), title: '', cpStatus: 'Future', expanded: false }]);
  };
  const removeMilestone = (id: string) => {
    setMilestones(prev => prev.filter(m => m.id !== id));
  };
  const updateMilestone = (id: string, patch: Partial<MilestoneDraft>) => {
    setMilestones(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  };

  // ── Step 2 helpers ──
  const getSubtasks = (milestoneId: string) => subtasks[milestoneId] ?? [];
  const setInput = (milestoneId: string, val: string) => {
    setAddInputs(prev => ({ ...prev, [milestoneId]: val }));
    const existing = getSubtasks(milestoneId).map(s => s.title);
    setSuggestions(prev => ({
      ...prev,
      [milestoneId]: generateSuggestions(
        title,
        category,
        milestones.find(m => m.id === milestoneId)?.title ?? '',
        val,
        existing,
      ),
    }));
  };

  const addSubtask = (milestoneId: string, value?: string) => {
    const text = (value ?? addInputs[milestoneId] ?? '').trim();
    if (!text) return;
    setSubtasks(prev => ({
      ...prev,
      [milestoneId]: [...(prev[milestoneId] ?? []), { id: uid(), title: text }],
    }));
    setAddInputs(prev => ({ ...prev, [milestoneId]: '' }));
    setSuggestions(prev => ({ ...prev, [milestoneId]: [] }));
  };
  const removeSubtask = (milestoneId: string, subtaskId: string) => {
    setSubtasks(prev => ({
      ...prev,
      [milestoneId]: (prev[milestoneId] ?? []).filter(s => s.id !== subtaskId),
    }));
  };

  // ── Validation ──
  const canAdvance = () => {
    if (step === 0) return title.trim().length > 0;
    if (step === 1) return milestones.length > 0 && milestones.every(m => m.title.trim().length > 0);
    return true;
  };

  // ── Submit ──
  const handleSubmit = async () => {
    if (!title.trim() || milestones.length === 0) return;
    setSubmitting(true);
    try {
      const targetDeadline = deadline.trim() || null;
      const goalId = await createGoal({
        title: title.trim(),
        description: targetDeadline
          ? `${category} goal targeting ${targetDeadline}.`
          : `${category} goal with finish estimated from tasks and subtasks.`,
        category,
        status: 'Safe', // computed dynamically at display time
        progress: 0,
        deadline: targetDeadline,
        overdue: false,
        activity_level: 3,
      });

      for (let mi = 0; mi < milestones.length; mi++) {
        const m = milestones[mi];
        const milestoneId = await createTask({
          goal_id: goalId,
          parent_task_id: null,
          title: m.title.trim(),
          description: '',
          status: m.cpStatus === 'Completed' ? 'done' : m.cpStatus === 'In Progress' ? 'in_progress' : 'todo',
          priority: 'high',
          kind: 'critical_path',
          critical_path_status: m.cpStatus,
          tags_json: '[]',
          due_date: null,
          estimated_duration: null,
          completed: m.cpStatus === 'Completed',
          position: mi,
        });

        const subs = subtasks[m.id] ?? [];
        for (let si = 0; si < subs.length; si++) {
          await createTask({
            goal_id: goalId,
            parent_task_id: milestoneId,
            title: subs[si].title,
            description: '',
            status: 'todo',
            priority: 'medium',
            kind: 'manual',
            critical_path_status: null,
            tags_json: '[]',
            due_date: null,
            estimated_duration: null,
            completed: false,
            position: si,
          });
        }
      }

      triggerToast(`Goal "${title.trim()}" created with ${milestones.length} milestones!`, 'success');
      navigateToGoal(goalId);
      closeNewGoalModal();
    } catch {
      triggerToast('Failed to create goal. Please try again.', 'info');
    } finally {
      setSubmitting(false);
    }
  };

  const totalSubtasks = Object.values(subtasks).reduce((n, arr) => n + arr.length, 0);

  return (
    <ModalFrame
      onClose={closeNewGoalModal}
      titleId="new-goal-title"
      overlayClassName="bg-black/50"
      className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
    >
        {/* Header */}
        <div className="px-6 pt-6 pb-0 shrink-0">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h2 id="new-goal-title" className="font-headline text-xl font-black text-gray-900">New Goal</h2>
              <p className="text-xs text-gray-400 mt-0.5">Define your objective and break it into milestones</p>
            </div>
            <button
              onClick={closeNewGoalModal}
              aria-label="Close new goal dialog"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <X size={18} />
            </button>
          </div>
          <Steps current={step} />
        </div>

        {/* Body */}
        <div className="px-6 pb-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {/* ── Step 0: Foundation ── */}
            {step === 0 && (
              <motion.div key="step0" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.18 }} className="space-y-4 pb-4">
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-widest text-gray-500 mb-1.5">Goal Title *</label>
                  <input
                    ref={titleRef}
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && canAdvance()) setStep(1); }}
                    placeholder="e.g. Launch v2.0 Design System"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none focus:border-[#4648d4] focus:ring-1 focus:ring-[#4648d4]/30 transition-all"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-gray-500 mb-1.5">Umbrella</label>
                    <select
                      value={category}
                      onChange={e => setCategory(e.target.value)}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-gray-800 bg-white focus:outline-none focus:border-[#4648d4] transition-all"
                    >
                      {categoryOptions.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-gray-500 mb-1.5">Target Deadline (optional)</label>
                    <select
                      value={deadline}
                      onChange={e => setDeadline(e.target.value)}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-gray-800 bg-white focus:outline-none focus:border-[#4648d4] transition-all"
                    >
                      <option value="">Estimate from tasks</option>
                      {DEADLINES.map(d => <option key={d}>{d}</option>)}
                    </select>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ── Step 1: Milestones ── */}
            {step === 1 && (
              <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.18 }} className="space-y-3 pb-4">
                <p className="text-xs text-gray-500 leading-relaxed">Define the critical path milestones for <span className="font-semibold text-gray-800">{title}</span>.</p>
                {milestones.map((m, i) => (
                  <div key={m.id} className="bg-[#f8f9fa] rounded-xl border border-gray-200 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-5 h-5 rounded-full bg-gray-200 text-[10px] font-mono font-bold text-gray-500 flex items-center justify-center shrink-0">{i + 1}</span>
                      <input
                        value={m.title}
                        onChange={e => updateMilestone(m.id, { title: e.target.value })}
                        placeholder={`Milestone title, e.g. "Research & Discovery"`}
                        className="flex-1 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-[#4648d4] transition-all"
                        autoFocus={i === milestones.length - 1}
                      />
                      {milestones.length > 1 && (
                        <button onClick={() => removeMilestone(m.id)} className="text-gray-300 hover:text-red-400 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      {CP_STATUSES.map(s => (
                        <button
                          key={s}
                          onClick={() => updateMilestone(m.id, { cpStatus: s })}
                          className={`flex-1 py-1 rounded-lg text-[9px] font-mono font-bold uppercase tracking-wider border transition-all ${
                            m.cpStatus === s
                              ? s === 'Completed'  ? 'bg-emerald-100 border-emerald-300 text-emerald-700'
                              : s === 'In Progress' ? 'bg-[#EEF2FF] border-[#4648d4]/30 text-[#4648d4]'
                              : 'bg-gray-100 border-gray-200 text-gray-500'
                              : 'bg-white border-gray-100 text-gray-300 hover:border-gray-200'
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  onClick={addMilestone}
                  className="w-full py-2.5 border-2 border-dashed border-gray-200 hover:border-[#4648d4]/40 text-gray-400 hover:text-[#4648d4] rounded-xl text-xs font-mono font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2"
                >
                  <Plus size={13} />
                  Add Milestone
                </button>
              </motion.div>
            )}

            {/* ── Step 2: Subtasks ── */}
            {step === 2 && (
              <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.18 }} className="space-y-3 pb-4">
                <p className="text-xs text-gray-500">Break each milestone into subtasks. Type or pick from AI suggestions.</p>
                {milestones.map((m) => {
                  const subs = getSubtasks(m.id);
                  const isExpanded = m.expanded;
                  const inputVal = addInputs[m.id] ?? '';
                  const chips = suggestions[m.id] ?? generateSuggestions(title, category, m.title, '', subs.map(s => s.title));

                  return (
                    <div key={m.id} className="bg-[#f8f9fa] rounded-xl border border-gray-200 overflow-hidden">
                      <button
                        onClick={() => updateMilestone(m.id, { expanded: !isExpanded })}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-100 transition-colors"
                      >
                        {isExpanded ? <ChevronDown size={13} className="text-gray-400 shrink-0" /> : <ChevronRight size={13} className="text-gray-400 shrink-0" />}
                        <span className="text-xs font-semibold text-gray-800 flex-1">{m.title}</span>
                        <span className="text-[10px] font-mono text-gray-400">{subs.length} subtask{subs.length !== 1 ? 's' : ''}</span>
                      </button>

                      {isExpanded && (
                        <div className="px-3 pb-3 border-t border-gray-200 pt-2.5">
                          {subs.length > 0 && (
                            <ul className="space-y-1.5 mb-2.5">
                              {subs.map(s => (
                                <li key={s.id} className="flex items-center gap-2 group">
                                  <div className="w-3 h-3 rounded-full border-2 border-gray-300 shrink-0" />
                                  <span className="text-xs text-gray-700 flex-1">{s.title}</span>
                                  <button
                                    onClick={() => removeSubtask(m.id, s.id)}
                                    className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all"
                                  >
                                    <X size={11} />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}

                          <div className="flex gap-2">
                            <input
                              value={inputVal}
                              onChange={e => setInput(m.id, e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') addSubtask(m.id); }}
                              placeholder="Add subtask…"
                              className="flex-1 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-[#4648d4] transition-all"
                            />
                            <button
                              onClick={() => addSubtask(m.id)}
                              disabled={!inputVal.trim()}
                              className="bg-[#4648d4] disabled:bg-gray-200 text-white rounded-lg px-2.5 py-1.5 transition-colors"
                            >
                              <Plus size={12} />
                            </button>
                          </div>

                          <div className="mt-2">
                            <p className="text-[9px] font-mono text-[#4648d4] uppercase tracking-widest mb-1.5 flex items-center gap-1">
                              <Sparkles size={8} /> AI suggests
                              <NeedsImplementationBadge className="ml-1" />
                            </p>
                            <SuggestionChips
                              chips={chips}
                              onPick={text => addSubtask(m.id, text)}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </motion.div>
            )}

            {/* ── Step 3: Review ── */}
            {step === 3 && (
              <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.18 }} className="pb-4">
                <div className="bg-gradient-to-br from-[#EEF2FF] to-white rounded-xl border border-[#4648d4]/15 p-4 mb-4">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <h3 className="font-headline text-base font-black text-gray-900 leading-tight">{title}</h3>
                      <p className="text-[10px] font-mono text-gray-400 mt-0.5">{category} · {deadline || 'Dynamic from tasks'}</p>
                    </div>
                    <span className="font-mono text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg shrink-0 bg-gray-100 text-gray-500">
                      Auto-health
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <CheckCircle2 size={12} className="text-[#4648d4]" />
                      <span className="font-semibold">{milestones.length}</span> milestone{milestones.length !== 1 ? 's' : ''}
                    </div>
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <CheckCircle2 size={12} className="text-[#4648d4]" />
                      <span className="font-semibold">{totalSubtasks}</span> subtask{totalSubtasks !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {milestones.map((m, i) => {
                    const subs = getSubtasks(m.id);
                    return (
                      <div key={m.id} className="flex items-start gap-3 p-3 bg-[#f8f9fa] rounded-xl border border-gray-150">
                        <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${
                          m.cpStatus === 'Completed'   ? 'bg-[#10B981]' :
                          m.cpStatus === 'In Progress' ? 'bg-[#4648d4]' : 'bg-gray-300'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-gray-800">{m.title}</p>
                          {subs.length > 0 && (
                            <p className="text-[10px] text-gray-400 mt-0.5">{subs.map(s => s.title).join(', ')}</p>
                          )}
                        </div>
                        <span className="font-mono text-[9px] text-gray-400">{subs.length} subtask{subs.length !== 1 ? 's' : ''}</span>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex justify-between items-center shrink-0 bg-white">
          <button
            onClick={() => step === 0 ? closeNewGoalModal() : setStep(s => s - 1)}
            className="text-xs font-mono text-gray-400 hover:text-gray-700 transition-colors px-3 py-2 rounded-lg hover:bg-gray-50"
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>

          {step < 3 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canAdvance()}
              className="flex items-center gap-2 bg-[#4648d4] disabled:bg-gray-200 disabled:text-gray-400 text-white font-mono text-xs font-bold uppercase tracking-widest px-4 py-2 rounded-xl transition-all hover:opacity-95 active:scale-95"
            >
              Next <ChevronRight size={13} />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex items-center gap-2 bg-black disabled:opacity-50 text-white font-mono text-xs font-bold uppercase tracking-widest px-5 py-2 rounded-xl transition-all hover:opacity-90 active:scale-95"
            >
              <Rocket size={13} />
              {submitting ? 'Launching…' : 'Launch Goal'}
            </button>
          )}
        </div>
    </ModalFrame>
  );
}
