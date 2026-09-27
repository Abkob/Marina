import { useState } from 'react';
import { Lightbulb, Check, X } from 'lucide-react';
import { useAIProposals, useInvalidate, type DBProposal } from '../api/hooks';
import { useAppStore } from '../store/useAppStore';
import { apiPost } from '../utils/apiFetch';

const ACTION_COLORS: Record<string, string> = {
  create_routine: 'bg-teal-500/20 text-teal-300',
  update_routine: 'bg-teal-500/20 text-teal-300',
  check_in_routine: 'bg-teal-500/20 text-teal-300',
  create_task:      'bg-blue-500/20 text-blue-300',
  break_down_task:  'bg-cyan-500/20 text-cyan-300',
  update_task:      'bg-indigo-500/20 text-indigo-300',
  create_goal:      'bg-purple-500/20 text-purple-300',
  create_goal_with_tasks: 'bg-purple-500/20 text-purple-300',
  create_milestone: 'bg-teal-500/20 text-teal-300',
  move_schedule_items: 'bg-violet-500/20 text-violet-300',
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.round(value * 100));
  const color = pct >= 75 ? 'bg-green-500' : pct >= 45 ? 'bg-amber-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-gray-500">{pct}%</span>
    </div>
  );
}

function ProposalRow({ proposal, onApply, onReject }: {
  proposal: DBProposal;
  onApply: () => void;
  onReject: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const colorClass = ACTION_COLORS[proposal.action_type] ?? 'bg-gray-700 text-gray-300';
  const snippet = proposal.explanation?.slice(0, 80) ?? proposal.action_type;

  const handle = async (fn: () => void) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-900/40 transition-colors">
      <span className={`mt-0.5 shrink-0 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${colorClass}`}>
        {proposal.action_type.replace(/_/g, ' ')}
      </span>
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-xs text-gray-300 leading-snug">{snippet}{(proposal.explanation?.length ?? 0) > 80 ? '…' : ''}</p>
        <ConfidenceBar value={proposal.confidence} />
        {proposal.source_type === 'journal_entry' && proposal.source_entry_date && (
          <p className="text-[9px] font-mono text-gray-600">
            From journal: <span className="text-gray-500">{proposal.source_entry_date}</span>
          </p>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        <button
          onClick={() => handle(onApply)}
          disabled={busy}
          className="p-1.5 rounded-lg bg-green-600/20 hover:bg-green-600/40 text-green-400 transition-colors disabled:opacity-50"
          title="Apply"
        >
          <Check size={12} />
        </button>
        <button
          onClick={() => handle(onReject)}
          disabled={busy}
          className="p-1.5 rounded-lg bg-red-600/10 hover:bg-red-600/30 text-red-400 transition-colors disabled:opacity-50"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

export function ProposalsPanel() {
  const { data: proposals } = useAIProposals();
  const invalidate = useInvalidate();
  const { triggerToast } = useAppStore();

  if (!proposals?.length) return null;

  const apply = async (id: string, type: string) => {
    await apiPost(`/api/ai/proposals/${id}/apply`, {});
    invalidate.aiProposals();
    invalidate.allTasks();
    invalidate.goals();
    triggerToast(`Applied: ${type.replace(/_/g, ' ')}`, 'success');
  };

  const reject = async (id: string) => {
    await apiPost(`/api/ai/proposals/${id}/reject`, {});
    invalidate.aiProposals();
  };

  return (
    <div className="bg-surface border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800">
        <Lightbulb size={13} className="text-amber-400" />
        <span className="text-xs font-mono font-bold text-gray-300 uppercase tracking-wider">AI Proposals</span>
        <span className="ml-auto text-[10px] font-mono text-gray-600">{proposals.length} pending</span>
      </div>
      <div className="divide-y divide-gray-900">
        {proposals.map(p => (
          <ProposalRow
            key={p.id}
            proposal={p}
            onApply={() => apply(p.id, p.action_type)}
            onReject={() => reject(p.id)}
          />
        ))}
      </div>
    </div>
  );
}
