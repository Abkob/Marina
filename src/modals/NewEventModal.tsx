import { useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { createEvent } from '../db/queries/events';
import { fmtYMD, mondayOf } from '../utils/calendar';
import type { EventType } from '../db/schema';
import { ModalFrame } from '../components/ModalFrame';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TYPES: EventType[] = ['Focus', 'Buffer', 'Review', 'Admin'];

function fmtTime(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const ampm = hh < 12 ? 'AM' : 'PM';
  const disp = hh % 12 || 12;
  return `${disp}:${mm === 0 ? '00' : String(mm)} ${ampm}`;
}

export function NewEventModal() {
  const { closeNewEventModal, triggerToast } = useAppStore();

  const [title, setTitle] = useState('');
  const [dayIndex, setDayIndex] = useState(0);
  const [eventType, setEventType] = useState<EventType>('Focus');
  const [startHour, setStartHour] = useState(10);
  const [duration, setDuration] = useState(2);
  const [desc, setDesc] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      triggerToast('Please provide a title for the block', 'error');
      return;
    }
    const endHour = startHour + duration;
    await createEvent({
      title: title.trim(),
      type: eventType,
      day_index: dayIndex,
      start_hour: startHour,
      duration_hours: duration,
      time_str: `${fmtTime(startHour)} - ${fmtTime(endHour)}`,
      description: desc || 'Custom scheduled block designed to support task execution.',
      // Anchor to the current week so the block lands on a real date on the
      // Schedule calendar (null would make it repeat every week).
      week_start: mondayOf(fmtYMD(new Date())),
      connected_resource_json: null,
      locked: false,
      source: 'manual',
    });
    triggerToast(`Scheduled "${title.trim()}"!`, 'success');
    closeNewEventModal();
  };

  return (
    <ModalFrame
      onClose={closeNewEventModal}
      titleId="new-event-title"
      className="bg-white rounded-xl border border-gray-200 max-w-md w-full p-6 shadow-2xl relative"
    >
      <button
        onClick={closeNewEventModal}
        aria-label="Close scheduling block dialog"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black"
      >
        <X size={16} />
      </button>
      <h3 id="new-event-title" className="font-headline text-lg font-black text-gray-900 border-b border-gray-100 pb-2 mb-4">
        Schedule Planning Block
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="new-event-title-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
            Block Name
          </label>
          <input
            id="new-event-title-input"
            type="text"
            required
            placeholder="e.g. Finalize specs iteration"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2.5 focus:ring-1 focus:ring-black outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="new-event-day-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
              Week Day
            </label>
            <select
              id="new-event-day-input"
              value={dayIndex}
              onChange={(e) => setDayIndex(Number(e.target.value))}
              className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2 focus:ring-1 focus:ring-black outline-none bg-white"
            >
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="new-event-type-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
              Block Type
            </label>
            <select
              id="new-event-type-input"
              value={eventType}
              onChange={(e) => setEventType(e.target.value as EventType)}
              className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2 focus:ring-1 focus:ring-black outline-none bg-white"
            >
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="new-event-start-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
              Start Hour (8-22)
            </label>
            <input
              id="new-event-start-input"
              type="number"
              step="0.5"
              min="8"
              max="22"
              value={startHour}
              onChange={(e) => setStartHour(Number(e.target.value))}
              className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2 focus:ring-1 focus:ring-black outline-none"
            />
          </div>
          <div>
            <label htmlFor="new-event-duration-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
              Duration (Hours)
            </label>
            <input
              id="new-event-duration-input"
              type="number"
              step="0.5"
              min="0.5"
              max="6"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2 focus:ring-1 focus:ring-black outline-none"
            />
          </div>
        </div>
        <div>
          <label htmlFor="new-event-description-input" className="block text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-1 font-bold">
            Description (optional)
          </label>
          <textarea
            id="new-event-description-input"
            placeholder="Review component naming layouts and document redundancy..."
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full text-xs font-sans rounded-lg border border-gray-200 p-2.5 focus:ring-1 focus:ring-black outline-none resize-none h-16"
          />
        </div>
        <div className="flex gap-2 justify-end pt-3">
          <button type="button" onClick={closeNewEventModal} className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-[#f8f9fa] hover:bg-gray-100 text-gray-500 font-semibold">
            Cancel
          </button>
          <button type="submit" className="font-mono text-[10px] uppercase py-2 px-4 rounded-lg bg-black text-white font-bold">
            Commit Block
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
