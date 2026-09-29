import { expect, it } from 'vitest';
import { parseClockTime, timeRangeError } from '../calendarTimeInput';

it('supports exact clock entry and explicit midnight boundaries', () => {
  expect(parseClockTime('2:30pm')).toBe(14.5);
  expect(parseClockTime('14:30')).toBe(14.5);
  expect(parseClockTime('12am')).toBe(0);
  expect(parseClockTime('12pm')).toBe(12);
  expect(parseClockTime('24:00')).toBeNull();
  expect(parseClockTime('24:00', true)).toBe(24);
  for (const input of ['14:70', '25:00', '0pm', '14pm', '2:3', 'tomorrow']) expect(parseClockTime(input)).toBeNull();
  expect(timeRangeError(14, 13)).toContain('after Start');
  expect(timeRangeError(23.5, 24)).toBe('');
});
