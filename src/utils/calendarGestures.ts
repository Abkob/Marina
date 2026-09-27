import { clampHour, snapHour } from './calendar';

export const CALENDAR_HOLD_MS = 360;
export const CALENDAR_MOVE_TOLERANCE = 8;
export const CALENDAR_MIN_DURATION = 0.25;

export type CalendarGestureMode = 'move' | 'resize-start' | 'resize-end' | 'create';
export interface CalendarPlacement { date: string; startHour: number; durationHours: number }

export function gesturePlacement(original: CalendarPlacement, mode: CalendarGestureMode, deltaHours: number): CalendarPlacement {
  const end = original.startHour + original.durationHours;
  if (mode === 'move') return { ...original, startHour: clampHour(snapHour(original.startHour + deltaHours), 0, 24 - original.durationHours) };
  if (mode === 'resize-start') {
    const startHour = clampHour(snapHour(original.startHour + deltaHours), 0, end - CALENDAR_MIN_DURATION);
    return { ...original, startHour, durationHours: end - startHour };
  }
  if (mode === 'create' && deltaHours < 0) {
    const startHour = clampHour(snapHour(original.startHour + deltaHours), 0, original.startHour);
    return { ...original, startHour, durationHours: Math.max(CALENDAR_MIN_DURATION, original.startHour - startHour) };
  }
  if (mode === 'create') return { ...original, durationHours: clampHour(snapHour(deltaHours || original.durationHours), CALENDAR_MIN_DURATION, 24 - original.startHour) };
  return { ...original, durationHours: clampHour(snapHour(original.durationHours + deltaHours), CALENDAR_MIN_DURATION, 24 - original.startHour) };
}

export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  return Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.6 ? (dx < 0 ? 1 : -1) : 0;
}
