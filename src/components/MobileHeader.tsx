import { useState } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { mobilePageLabel } from './mobileNavigation';
import { GlobalSearch } from './Header';
import { ModalFrame } from './ModalFrame';
import { appLocationKey } from '../utils/appNavigation';

export function MobileHeader() {
  const { currentTab, selectedGoalId, focusedTaskId, focusedResourceId } = useAppStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const inGoal = currentTab === 'Goals' && selectedGoalId;
  const inResource = currentTab === 'Resources' && focusedResourceId;
  const returnTo = (target: { selectedGoalId?: string | null; focusedTaskId?: string | null; focusedResourceId?: string | null }) => {
    const next = { ...useAppStore.getState(), ...target };
    if (history.state?.marinaPreviousKey === appLocationKey(next)) history.back();
    else useAppStore.setState(target);
  };
  const back = inGoal ? () => focusedTaskId ? returnTo({ focusedTaskId: null }) : returnTo({ selectedGoalId: null, focusedTaskId: null }) : inResource ? () => returnTo({ focusedResourceId: null }) : null;
  const backLabel = focusedTaskId && inGoal ? 'Back to goal' : inGoal ? 'Back to goals' : 'Back to resources';
  return <>
    <header className="mobile-app-header fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-slate-100 bg-white/95 px-4 backdrop-blur-xl md:hidden">
      <div className="flex min-w-0 items-center gap-2">
        {back ? <button onClick={back} aria-label={backLabel} className="mobile-icon-button -ml-2 text-indigo-600"><ArrowLeft size={21} /></button> : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-base font-bold text-white" aria-hidden="true">M</span>}
        <div className="min-w-0"><p className="truncate text-base font-semibold text-slate-900">{inGoal ? focusedTaskId ? 'Task' : 'Goal' : inResource ? 'Resource' : mobilePageLabel(currentTab)}</p></div>
      </div>
      <button onClick={() => setSearchOpen(true)} aria-label="Search workspace" aria-haspopup="dialog" className="mobile-icon-button text-slate-500"><Search size={21} /></button>
    </header>
    {searchOpen && <ModalFrame titleId="mobile-search-title" onClose={() => setSearchOpen(false)} className="mobile-sheet w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between"><h2 id="mobile-search-title" className="text-xl font-bold text-slate-900">Search your workspace</h2><button onClick={() => setSearchOpen(false)} aria-label="Close workspace search" className="mobile-icon-button text-slate-500"><X size={20} /></button></div>
      <GlobalSearch mobile onNavigate={() => setSearchOpen(false)} />
    </ModalFrame>}
  </>;
}
