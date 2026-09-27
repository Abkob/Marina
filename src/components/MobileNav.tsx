import { useState } from 'react';
import { ChevronRight, LayoutGrid, Search, X } from 'lucide-react';
import { useAppStore, type Tab } from '../store/useAppStore';
import { ModalFrame } from './ModalFrame';
import { MOBILE_PAGES, mobilePageId } from './mobileNavigation';

export function MobileNav() {
  const { currentTab } = useAppStore();
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState('');
  const activePage = mobilePageId(currentTab);
  const selectedPage = currentTab === 'Journal' ? 'Brain Dump' : currentTab;
  const primary = MOBILE_PAGES.slice(0, 4);
  const activeMore = !primary.some(page => page.id === activePage);
  const go = (id: Tab) => {
    const repeated = id === currentTab || (id === 'Brain Dump' && currentTab === 'Journal');
    // Each tab keeps its detail page. Tapping the selected tab returns to its root.
    useAppStore.setState({ currentTab: id,
      ...(repeated && id === 'Goals' ? { selectedGoalId: null, focusedTaskId: null } : {}),
      ...(repeated && id === 'Resources' ? { focusedResourceId: null } : {}),
    });
    if (repeated) window.dispatchEvent(new Event('marina:tab-reselect'));
    setMoreOpen(false);
    setQuery('');
  };
  const pages = (query.trim() ? MOBILE_PAGES : MOBILE_PAGES.slice(4)).filter(page => `${page.label} ${page.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <>
    <nav aria-label="Main navigation" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 flex items-center border-t border-slate-200/80 bg-white/95 px-2 pt-2 backdrop-blur-xl md:hidden">
      {primary.map(({ id, label, Icon }) => <button key={id} onClick={() => go(id)} aria-label={`Open ${label}`} aria-current={activePage === id ? 'page' : undefined}
        className={`mobile-nav-item ${activePage === id ? 'text-indigo-600' : 'text-slate-500'}`}>
        <span className={`flex h-8 w-12 items-center justify-center rounded-2xl ${activePage === id ? 'bg-indigo-50' : ''}`}><Icon size={22} strokeWidth={activePage === id ? 2.4 : 1.8} /></span>
        <span className="text-[11px] font-semibold">{label}</span>
      </button>)}
      <button onClick={() => { setMoreOpen(true); setQuery(''); }} aria-label="Open all pages" aria-expanded={moreOpen} aria-haspopup="dialog" className={`mobile-nav-item ${activeMore || moreOpen ? 'text-indigo-600' : 'text-slate-500'}`}>
        <span className={`flex h-8 w-12 items-center justify-center rounded-2xl ${activeMore || moreOpen ? 'bg-indigo-50' : ''}`}><LayoutGrid size={21} /></span><span className="text-[11px] font-semibold">More</span>
      </button>
    </nav>
    {moreOpen && <ModalFrame onClose={() => setMoreOpen(false)} titleId="mobile-pages-title" className="mobile-sheet mobile-page-menu w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl">
      <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-200" aria-hidden="true" />
      <div className="sticky -top-5 z-10 -mx-5 mb-4 flex items-center justify-between gap-3 bg-white px-5 py-2"><div><p className="text-xs font-semibold text-indigo-600">Marina</p><h2 id="mobile-pages-title" className="text-2xl font-bold tracking-tight text-slate-900">Your workspace</h2></div><button onClick={() => setMoreOpen(false)} aria-label="Close all pages" className="mobile-icon-button bg-slate-100 text-slate-500"><X size={20} /></button></div>
      <label className="mb-5 flex items-center gap-2 rounded-2xl bg-slate-100 px-3 text-slate-400"><Search size={18} /><input aria-label="Find a page" placeholder="Find a page…" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-3 text-slate-900 outline-none" /></label>
      {['Your day', 'Your workspace', 'Manage'].map(group => {
        const items = pages.filter(page => page.group === group);
        return items.length > 0 && <section key={group} className="mb-5 last:mb-0"><h3 className="mb-2 text-xs font-semibold text-slate-500">{group}</h3><div className="divide-y divide-slate-100">
          {items.map(({ id, label, description, Icon }) => <button key={id} onClick={() => go(id)} aria-label={`Open ${label}`} aria-description={description} aria-current={selectedPage === id ? 'page' : undefined} className={`flex min-h-16 w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left ${selectedPage === id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'}`}>
            <Icon size={21} className="shrink-0 text-slate-400" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}</span><span className="mt-0.5 block text-xs text-slate-400">{description}</span></span><ChevronRight size={16} className="text-slate-300" />
          </button>)}
        </div></section>;
      })}
      {pages.length === 0 && <p role="status" className="py-6 text-center text-sm text-slate-500">No pages found. Try another name.</p>}
    </ModalFrame>}
  </>;
}
