import { describe, expect, it } from 'vitest';
import { gesturePlacement, swipeDirection } from '../calendarGestures';

const original = { date: '2026-09-24', startHour: 9, durationHours: 1 };
describe('calendar gesture bounds', () => {
  it('snaps moves to 15 minutes and keeps the full event within the day', () => {
    expect(gesturePlacement(original, 'move', 0.37).startHour).toBe(9.25);
    expect(gesturePlacement(original, 'move', -30).startHour).toBe(0);
    expect(gesturePlacement(original, 'move', 30).startHour).toBe(23);
  });
  it('resizes either edge without crossing the other edge or midnight', () => {
    expect(gesturePlacement(original, 'resize-start', 0.5)).toMatchObject({ startHour: 9.5, durationHours: 0.5 });
    expect(gesturePlacement(original, 'resize-start', 8)).toMatchObject({ startHour: 9.75, durationHours: 0.25 });
    expect(gesturePlacement(original, 'resize-end', -5).durationHours).toBe(0.25);
    expect(gesturePlacement(original, 'resize-end', 30).durationHours).toBe(15);
  });
  it('creates a range both above and below the held time', () => {
    expect(gesturePlacement(original, 'create', 2)).toMatchObject({ startHour: 9, durationHours: 2 });
    expect(gesturePlacement(original, 'create', -2)).toMatchObject({ startHour: 7, durationHours: 2 });
  });
  it('ignores short, vertical and diagonal swipes', () => {
    expect(swipeDirection(-90, 10)).toBe(1);
    expect(swipeDirection(90, -10)).toBe(-1);
    expect(swipeDirection(25, 0)).toBe(0);
    expect(swipeDirection(80, 60)).toBe(0);
    expect(swipeDirection(80, 100)).toBe(0);
  });
});
