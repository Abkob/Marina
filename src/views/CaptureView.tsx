import { BookOpen, ScrollText } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { CaptureWallView } from './CaptureWallView';
import { JournalView } from './JournalView';

/**
 * Unified Capture experience: Thoughts (free-form notes) and Journal (dated
 * entries that flow through AI extraction → links → embeddings → suggestions)
 * live behind one destination with a segmented switch. The two remain
 * distinct storage models on purpose — a thought is scratch space; a journal
 * entry is a semantic event. "Log as journal" in the note editor bridges them.
 *
 * The store keeps 'Brain Dump' and 'Journal' as separate Tab values so deep
 * links (search results, graph nodes) land on the right segment.
 */
export function CaptureView() {
  const { currentTab, setCurrentTab } = useAppStore();
  const segment = currentTab === 'Journal' ? 'journal' : 'thoughts';

  return (
    <div className="flex flex-col h-full">
      <div className="mobile-capture-tabs flex justify-center pt-4 pb-1">
        <div className="inline-flex rounded-xl border border-gray-200 bg-white p-0.5 shadow-sm">
          <button
            onClick={() => setCurrentTab('Brain Dump')} aria-pressed={segment === 'thoughts'}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-[11px] font-mono uppercase tracking-wider font-bold transition-colors ${
              segment === 'thoughts' ? 'bg-[#4648d4] text-white' : 'text-gray-500 hover:text-gray-800'
            }`}
            title="Free-form thought capture with OO classification"
          >
            <BookOpen size={12} /> Thoughts
          </button>
          <button
            onClick={() => setCurrentTab('Journal')} aria-pressed={segment === 'journal'}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-[11px] font-mono uppercase tracking-wider font-bold transition-colors ${
              segment === 'journal' ? 'bg-[#4648d4] text-white' : 'text-gray-500 hover:text-gray-800'
            }`}
            title="Dated entries — AI extracts links, work sessions, and topic suggestions"
          >
            <ScrollText size={12} /> Journal
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {segment === 'thoughts' ? <CaptureWallView /> : <JournalView />}
      </div>
    </div>
  );
}
