import { usePersistentDraft } from '../hooks/usePersistentDraft';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';
import { ModalFrame } from '../components/ModalFrame';
import { useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, Trash2, ScrollText, ChevronLeft, ChevronRight, StickyNote } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useNotes, useInvalidate, type DBJournalEntry } from '../api/hooks';
import { createNote, updateNoteContent, deleteNote } from '../db/queries/notes';
import { apiFetch, apiPost } from '../utils/apiFetch';
import { useAppStore } from '../store/useAppStore';
import type { DBNote } from '../db/schema';

/**
 * The capture wall: today is a wall of sticky notes. Type a thought, it lands
 * on the wall; click a note and it zooms into a focused editor; at the end of
 * the day the server binds the wall into a journal entry automatically (and
 * you can bind any note yourself at any time with "Log as journal").
 */

const NOTE_TINTS = [
  'bg-[#fff9c4] border-yellow-300/70',   // classic yellow
  'bg-[#ffe0f0] border-pink-300/60',
  'bg-[#e0f2fe] border-sky-300/60',
  'bg-[#dcfce7] border-emerald-300/60',
  'bg-[#f3e8ff] border-purple-300/60',
  'bg-[#ffedd5] border-orange-300/60',
];
const tintOf = (id: string) => NOTE_TINTS[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % NOTE_TINTS.length];
const tiltOf = (id: string) => ((([...id].reduce((s, c) => s + c.charCodeAt(0), 0) % 5) - 2) * 1.1);

const stripHtml = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').trim();

function localDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayOfIso = (iso: string) => iso.slice(0, 10);

export function CaptureWallView() {
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const { triggerToast, showConfirm } = useAppStore();
  const invalidate = useInvalidate();
  const { data: notes = [] } = useNotes();
  const [dayOffset, setDayOffset] = useState(0);
  const [quick, setQuick] = usePersistentDraft('capture');
  const [openId, setOpenId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const saving = useRef(false);

  const day = localDay(dayOffset);
  const isToday = dayOffset === 0;

  // Journal linkage badges: which notes are already bound into a journal entry
  const { data: journals = [] } = useQuery<Array<DBJournalEntry & { source_note_id?: string | null }>>({
    queryKey: ['journal'],
    queryFn: () => apiFetch('/api/journal'),
  });
  const journaledNoteIds = useMemo(
    () => new Set(journals.map(j => j.source_note_id).filter(Boolean) as string[]),
    [journals],
  );

  const wallNotes = useMemo(
    () => notes
      .filter(n => dayOfIso(n.created_at) === day)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [notes, day],
  );

  const openNote = wallNotes.find(n => n.id === openId) ?? null;

  const addQuick = async () => {
    const text = quick.trim();
    if (!text) return;
    setBusy(true);
    try {
      await createNote({
        title: text.split('\n')[0].slice(0, 48),
        content: text,
        type: 'thought' as DBNote['type'],
        date_str: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        suggested_action_text: null,
        suggested_action_applied: false,
        suggested_action_ignored: false,
        extracted_tasks_json: '[]',
        relevant_docs_json: '[]',
      });
      setQuick('');
      invalidate.notes();
    } catch (e) {
      triggerToast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const openEditor = (n: DBNote) => {
    setSaveError('');
    setOpenId(n.id);
    setEditText(stripHtml(n.content));
  };

  const saveEditor = async () => {
    if (!openNote) return;
    await updateNoteContent(openNote.id, editText);
    invalidate.notes();
  };

  const saveAndClose = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setSaveError('');
    try { await saveEditor(); setOpenId(null); }
    catch { setSaveError('Could not save your changes. Your text is still here — tap close to try again.'); }
    finally { saving.current = false; setBusy(false); }
  };

  const logAsJournal = async () => {
    if (!openNote || !editText.trim() || saving.current) return;
    saving.current = true;
    setSaveError('');
    setBusy(true);
    try {
      await saveEditor();
      const r = await apiPost<{ deduped?: boolean; updated?: boolean }>('/api/journal', {
        raw_text: editText.trim(), source_note_id: openNote.id, entry_date: day,
      });
      triggerToast(
        r.deduped ? 'Already in the journal — up to date.'
          : r.updated ? 'Journal entry updated from this note.'
          : 'Bound into the journal — AI extraction running.', 'success');
      invalidate.journal();
    } catch (e) {
      setSaveError((e as Error).message || 'Could not save your journal entry. Please try again.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const removeNote = (n: DBNote) => {
    showConfirm('Tear this sticky off the wall? (deletes the note)', async () => {
      await deleteNote(n.id);
      if (openId === n.id) setOpenId(null);
      invalidate.notes();
    });
  };

  return (
    <div className="mobile-capture-wall max-w-[1000px] mx-auto px-4 md:px-8 py-5">
      {/* Day header */}
      <div className="mobile-toolbar flex items-center justify-between mb-4">
        <div>
          <h2 className="font-headline text-2xl font-bold text-black flex items-center gap-2">
            <StickyNote size={20} className="text-[#4648d4]" />
            {isToday ? 'Today’s wall' : new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </h2>
          <p className="text-xs font-mono text-gray-400 uppercase tracking-widest mt-1">
            {wallNotes.length} note{wallNotes.length !== 1 ? 's' : ''} · thoughts to come back to
          </p>
        </div>
        <div className="flex gap-1 border border-gray-200 rounded-lg p-0.5 bg-[#f8f9fa]">
          <button onClick={() => setDayOffset(o => o - 1)} className="flex h-8 w-8 items-center justify-center rounded text-gray-600 hover:bg-gray-100" title="Previous day" aria-label="Previous capture day">
            <ChevronLeft size={14} />
          </button>
          {!isToday && (
            <button onClick={() => setDayOffset(0)} className="flex h-8 items-center rounded px-2 font-mono text-[9px] font-bold uppercase text-gray-500 hover:bg-gray-100" aria-label="Return to today">
              Today
            </button>
          )}
          <button onClick={() => setDayOffset(o => Math.min(0, o + 1))} className="flex h-8 w-8 items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30" disabled={isToday} title="Next day" aria-label="Next capture day">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Quick capture */}
      {isToday && (
        <div className="mobile-capture-composer flex gap-2 mb-6">
          <textarea
            aria-label="Quick capture note"
            value={quick}
            onChange={e => setQuick(e.target.value)}
            onKeyDown={e => { if (!mobile && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addQuick(); } }}
            placeholder={mobile ? "What’s on your mind?" : "Capture a thought… (Enter to save)"}
            rows={mobile ? 3 : 1}
            className="min-w-0 flex-1 bg-white border border-gray-200 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-[#4648d4] shadow-sm"
          />
          <button
            onClick={addQuick}
            disabled={!quick.trim() || busy}
            aria-label="Add quick note"
            className="px-4 rounded-xl bg-[#4648d4] text-white hover:opacity-90 disabled:opacity-40 shadow-sm"
          >
            <Plus size={16} /><span className="md:hidden">Save note</span>
          </button>
        </div>
      )}

      {/* The wall */}
      {wallNotes.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <StickyNote size={36} className="mx-auto mb-3 opacity-25" />
          <p className="text-sm">{isToday ? 'Blank wall. Stick your first thought up there ↑' : 'Nothing was captured this day.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          <AnimatePresence>
            {wallNotes.map(n => {
              const journaled = journaledNoteIds.has(n.id);
              return (
                <motion.button
                  key={n.id}
                  layoutId={`sticky-${n.id}`}
                  initial={{ opacity: 0, scale: 0.7, y: 14 }}
                  animate={{ opacity: 1, scale: 1, y: 0, rotate: tiltOf(n.id) }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  whileHover={{ scale: 1.045, rotate: 0, zIndex: 5 }}
                  onClick={() => openEditor(n)}
                  aria-label={`Open note ${stripHtml(n.content) || n.title}`}
                  className={`relative text-left rounded-sm border p-3.5 pt-4 shadow-[2px_4px_10px_rgba(0,0,0,0.10)] min-h-[128px] flex flex-col ${tintOf(n.id)}`}
                  style={{ transformOrigin: 'center' }}
                >
                  {/* “tape” */}
                  <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-10 h-3 bg-white/60 border border-black/5 rotate-[-2deg]" />
                  <p className="text-[12px] text-gray-800 leading-snug line-clamp-4 flex-1 whitespace-pre-wrap">
                    {stripHtml(n.content) || n.title}
                  </p>
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className="text-[9px] font-mono text-gray-500">
                      {new Date(n.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                    {journaled && (
                      <span className="text-[8px] font-mono uppercase bg-indigo-500/15 text-indigo-700 px-1 py-0.5 rounded" title="Already bound into a journal entry">
                        journaled
                      </span>
                    )}
                    {n.suggested_action_text && !n.suggested_action_applied && !n.suggested_action_ignored && (
                      <span className="text-[8px] font-mono uppercase bg-amber-500/20 text-amber-700 px-1 py-0.5 rounded" title="Has an unreviewed suggested action">
                        action?
                      </span>
                    )}
                  </div>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Zoomed editor */}
      <AnimatePresence>
        {openNote && (
<ModalFrame titleId="capture-note-title" onClose={() => { void saveAndClose(); }} className={`mobile-sheet w-full max-w-xl rounded-2xl border p-5 shadow-2xl ${tintOf(openNote.id)}`}><h2 id="capture-note-title" className="sr-only">Edit capture note</h2>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] font-mono text-gray-500">
                  {new Date(openNote.created_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
                {journaledNoteIds.has(openNote.id) && (
                  <span className="text-[9px] font-mono uppercase bg-indigo-500/15 text-indigo-700 px-1.5 py-0.5 rounded">journaled</span>
                )}
                <button
                  onClick={() => removeNote(openNote)}
                  disabled={busy}
                  className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500"
                  title="Delete this note"
                  aria-label="Delete this note"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  onClick={() => { void saveAndClose(); }}
                  disabled={busy}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-black/5 hover:text-gray-700"
                  title="Save & close"
                  aria-label="Save and close note"
                >
                  <X size={16} />
                </button>
              </div>
              <textarea
                aria-label="Capture note content"
                readOnly={busy}
                value={editText}
                onChange={e => setEditText(e.target.value)}
                rows={8}
                autoFocus
                className="w-full bg-transparent text-[14px] text-gray-800 leading-relaxed resize-none focus:outline-none"
              />
              {saveError && <p role="alert" className="mt-3 rounded-xl bg-white/80 p-3 text-sm text-red-700">{saveError}</p>}
              <div className="flex flex-wrap gap-3 items-center justify-between mt-3 pt-3 border-t border-black/10">
                <p role="status" className="text-xs text-gray-500">{busy ? 'Saving…' : 'Tap close to save your changes.'}</p>
                <button
                  onClick={logAsJournal}
                  disabled={busy || !editText.trim()}
                  aria-label="Log note as journal entry"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-black/80 text-white hover:bg-black disabled:opacity-40"
                  title="Bind this note into the journal now (AI extracts tasks, links, time)"
                >
                  <ScrollText size={12} />
                  {journaledNoteIds.has(openNote.id) ? 'Update journal entry' : 'Log as journal'}
                </button>
              </div>
          </ModalFrame>
        )}
      </AnimatePresence>
    </div>
  );
}
