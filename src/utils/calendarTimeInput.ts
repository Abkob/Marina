/** Exact clock entry, independent of OS time wheels. 24:00 is an end only. */
export function parseClockTime(value: string, allowMidnightEnd = false): number | null {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59) return null;
  if (match[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (match[3] === 'pm' ? 12 : 0);
  }
  if (hour > 23 && !(allowMidnightEnd && hour === 24 && minute === 0)) return null;
  return hour + minute / 60;
}

export function clockInput(hour: number): string {
  const minutes = Math.round(hour * 60);
  return `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`;
}

export function timeRangeError(start: number | null, end: number | null): string {
  if (start === null || end === null) return 'Enter a time like 14:30 or 2:30pm.';
  if (end > 24) return 'This block must end by midnight.';
  if (end <= start) return 'End must be after Start, on the same day.';
  if (Math.round((end - start) * 60) < 15) return 'Allow at least 15 minutes for a block.';
  return '';
}
