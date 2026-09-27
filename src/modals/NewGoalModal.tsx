import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { createGoal } from '../db/queries/goals';
import { createTask } from '../db/queries/tasks';
import { ModalFrame } from '../components/ModalFrame';

export function NewGoalModal() {
  const { closeNewGoalModal, triggerToast, goalTitlePrefill, goalCategories } = useAppStore();
  const categoryOptions = goalCategories.length > 0 ? goalCategories : ['General'];

  const [title, setTitle] = useState(goalTitlePrefill);
  const [category, setCategory] = useState(categoryOptions[0]);
  const [quarter, setQuarter] = useState('');
  const [desc, setDesc] = useState('');

  useEffect(() => {
    const options = goalCategories.length > 0 ? goalCategories : ['General'];
    if (!options.includes(category)) setCategory(options[0]);
  }, [goalCategories, category]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      triggerToast('Please provide a title for your goal', 'error');
      return;
    }

    const targetDeadline = quarter.trim() || null;
    const goalId = await createGoal({
      title: title.trim(),
      description: desc || (targetDeadline
        ? `Goal targeting ${targetDeadline}.`
        : 'Goal with finish estimated from tasks and subtasks.'),
      category,
      status: 'Safe',
      progress: 0,
      deadline: targetDeadline,
      overdue: false,
      activity_level: 1,
    });

    await createTask({
      goal_id: goalId, parent_task_id: null,
      title: 'Initial strategy kickoff and scope definition.',
      description: '', status: 'todo', priority: 'high', kind: 'next_action',
      critical_path_status: null, tags_json: '[]', due_date: null,
      estimated_duration: null, completed: false, position: -1,
    });

    await createTask({
      goal_id: goalId, parent_task_id: null,
      title: 'Scoping & Architecture', description: 'Assess base dependencies and coordinate initial milestone list.',
      status: 'in_progress', priority: 'medium', kind: 'critical_path',
      critical_path_status: 'In Progress', tags_json: '[]', due_date: null,
      estimated_duration: null, completed: false, position: 0,
    });

    await createTask({
      goal_id: goalId, parent_task_id: null,
      title: 'Implementation', description: 'Execute the core milestones and refactor as needed.',
      status: 'todo', priority: 'medium', kind: 'critical_path',
      critical_path_status: 'Future', tags_json: '[]', due_date: null,
      estimated_duration: null, completed: false, position: 1,
    });

    await createTask({
      goal_id: goalId, parent_task_id: null,
      title: 'Formulate timeline tasks', description: '',
      status: 'todo', priority: 'medium', kind: 'ai_generated',
      critical_path_status: null, tags_json: '[]', due_date: null,
      estimated_duration: 'Est. 1 hr', completed: false, position: 0,
    });

    triggerToast(`Goal "${title.trim()}" created!`, 'success');
    closeNewGoalModal();
  };

  return (
    <ModalFrame
      onClose={closeNewGoalModal}
      titleId="new-goal-modal-title"
      className="bg-white rounded-xl border border-gray-200 max-w-md w-full p-6 shadow-2xl relative"
    >
      <button
        onClick={closeNewGoalModal}
        aria-label="Close goal dialog"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black"
      >
        <X size={16} />
      </button>
      <h3 id="new-goal-modal-title" className="font-headline text-lg font-black text-gray-900 border-b border-gray-100 pb-2 mb-4">
        Initialize Goal Trace
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="goal-name-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">Goal Name</label>
          <input
            id="goal-name-input"
            type="text"
            required
            placeholder="e.g. Launch v2.0 Design System"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2.5 focus:ring-1 focus:ring-black outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="goal-category-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">Umbrella</label>
            <select
              id="goal-category-input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2 focus:ring-1 focus:ring-black outline-none bg-white"
            >
              {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="goal-deadline-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">Target Deadline (optional)</label>
            <input
              id="goal-deadline-input"
              type="text"
              placeholder="e.g. 2026-09-30"
              value={quarter}
              onChange={(e) => setQuarter(e.target.value)}
              className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2 focus:ring-1 focus:ring-black outline-none"
            />
          </div>
        </div>
        <div>
          <label htmlFor="goal-description-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">Brief Scope Description</label>
          <textarea
            id="goal-description-input"
            placeholder="Establish key credentials guidelines and milestone checklists..."
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2.5 focus:ring-1 focus:ring-black outline-none resize-none h-20"
          />
        </div>
        <div className="flex gap-2 justify-end pt-3">
          <button type="button" onClick={closeNewGoalModal} className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-[#f8f9fa] hover:bg-gray-100 text-gray-500 font-semibold">
            Cancel
          </button>
          <button type="submit" className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-black text-white font-bold">
            Kickstart Goal
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
