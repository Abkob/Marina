import { useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { createNote } from '../db/queries/notes';
import { ModalFrame } from '../components/ModalFrame';

export function NewNoteModal() {
  const { closeNewNoteModal, setActiveNoteId, triggerToast } = useAppStore();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      triggerToast('Please provide a title for your thought log', 'error');
      return;
    }
    const now = new Date();
    const dateStr = `Today, ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

    const noteId = await createNote({
      title: title.trim(),
      content: content || 'Empty thought trace. Tap here to start typing...',
      type: 'capture',
      date_str: dateStr,
      suggested_action_text: null,
      suggested_action_applied: false,
      suggested_action_ignored: false,
      extracted_tasks_json: '[]',
      relevant_docs_json: '[]',
    });

    setActiveNoteId(noteId);
    triggerToast('New thought trace captured!', 'success');
    closeNewNoteModal();
  };

  return (
    <ModalFrame
      onClose={closeNewNoteModal}
      titleId="new-note-title"
      className="bg-white rounded-xl border border-gray-200 max-w-md w-full p-6 shadow-2xl relative"
    >
      <button
        onClick={closeNewNoteModal}
        aria-label="Close thought dialog"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black"
      >
        <X size={16} />
      </button>
      <h3 id="new-note-title" className="font-headline text-lg font-black text-gray-900 border-b border-gray-100 pb-2 mb-4">
        Capture Thought Trace
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="new-note-title-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
            Idea Title
          </label>
          <input
            id="new-note-title-input"
            type="text"
            required
            placeholder="e.g. Afternoon Synthesis Logs"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2.5 focus:ring-1 focus:ring-black outline-none"
          />
        </div>
        <div>
          <label htmlFor="new-note-content-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
            Thought Content
          </label>
          <textarea
            id="new-note-content-input"
            placeholder="Write whatever flows in your headspace..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2.5 focus:ring-1 focus:ring-black outline-none resize-none h-44"
          />
        </div>
        <div className="flex gap-2 justify-end pt-3">
          <button type="button" onClick={closeNewNoteModal} className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-[#f8f9fa] hover:bg-gray-100 text-gray-500 font-semibold">
            Cancel
          </button>
          <button type="submit" className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-black text-white font-bold">
            Commit Log
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
