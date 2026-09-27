import { describe, expect, it } from 'vitest';
import { resolvePlanWindow } from '../../../server/services/planLayout';

const TODAY = '2026-07-06';

describe('resolvePlanWindow', () => {
  it('defaults to two weeks from today', () => {
    expect(resolvePlanWindow({}, TODAY, 10)).toEqual({ from: '2026-07-06', to: '2026-07-19' });
  });

  it('handles a single specific day ("plan Monday")', () => {
    expect(resolvePlanWindow({ from_date: '2026-07-13', to_date: '2026-07-13' }, TODAY, 10))
      .toEqual({ from: '2026-07-13', to: '2026-07-13' });
  });

  it('clamps a past start date to today', () => {
    const w = resolvePlanWindow({ from_date: '2026-07-01', to_date: '2026-07-08' }, TODAY, 10);
    expect(w.from).toBe(TODAY);
    expect(w.to).toBe('2026-07-08');
  });

  it('never lets the end precede the start', () => {
    const w = resolvePlanWindow({ from_date: '2026-07-10', to_date: '2026-07-08' }, TODAY, 10);
    expect(w).toEqual({ from: '2026-07-10', to: '2026-07-10' });
  });

  it('caps the span at 90 days', () => {
    const w = resolvePlanWindow({ from_date: '2026-07-06', to_date: '2026-12-01' }, TODAY, 10);
    expect(w.to).toBe('2026-10-03');
  });

  it('resolves "next 3 hours" against the clock, snapped to the next quarter hour', () => {
    const w = resolvePlanWindow({ relative_hours: 3 }, TODAY, 14.1); // 2:06 PM
    expect(w).toEqual({ from: TODAY, to: TODAY, startHour: 14.25, endHour: 17.25 });
  });

  it('caps relative windows at midnight', () => {
    const w = resolvePlanWindow({ relative_hours: 6 }, TODAY, 21.9);
    expect(w.endHour).toBe(24);
  });

  it('passes through a sensible afternoon window', () => {
    const w = resolvePlanWindow({ from_date: TODAY, to_date: TODAY, start_hour: 13, end_hour: 18 }, TODAY, 9);
    expect(w).toEqual({ from: TODAY, to: TODAY, startHour: 13, endHour: 18 });
  });

  it('drops a nonsensical hour pair instead of failing', () => {
    const w = resolvePlanWindow({ start_hour: 18, end_hour: 9 }, TODAY, 9);
    expect(w.startHour).toBeUndefined();
    expect(w.endHour).toBeUndefined();
  });
});
