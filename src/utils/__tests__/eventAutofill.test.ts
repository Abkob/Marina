import { describe, expect, it } from 'vitest';
import {
  autofillFromTask, eventCompletion, remainingMinutes,
  DEFAULT_EVENT_DURATION_HOURS,
} from '../eventAutofill';

describe('remainingMinutes', () => {
  it('subtracts logged work from the estimate', () => {
    expect(remainingMinutes(120, 45)).toBe(75);
  });

  it('keeps unfinished overruns unknown', () => {
    expect(remainingMinutes(60, 90)).toBeNull();
  });

  it('returns null when there is no estimate', () => {
    expect(remainingMinutes(null)).toBeNull();
    expect(remainingMinutes(0)).toBeNull();
  });

  it('requires correction of invalid negative logs', () => {
    expect(remainingMinutes(60, -30)).toBeNull();
  });
});

describe('autofillFromTask', () => {
  it('uses the task title and sizes the block to the remaining estimate', () => {
    const fill = autofillFromTask({ title: 'Draft Final Report', estimated_minutes: 90 });
    expect(fill.title).toBe('Draft Final Report');
    expect(fill.duration_hours).toBe(1.5);
    expect(fill.planned_minutes).toBe(90);
  });

  it('rounds partial half-hours up so the block covers the work', () => {
    expect(autofillFromTask({ title: 't', estimated_minutes: 80 }).duration_hours).toBe(1.5);
  });

  it('subtracts already-logged work', () => {
    const fill = autofillFromTask({ title: 't', estimated_minutes: 120 }, 60);
    expect(fill.duration_hours).toBe(1);
    expect(fill.planned_minutes).toBe(60);
  });

  it('caps the block at 4 hours but plans only what fits', () => {
    const fill = autofillFromTask({ title: 't', estimated_minutes: 600 });
    expect(fill.duration_hours).toBe(4);
    expect(fill.planned_minutes).toBe(240);
  });

  it('floors tiny estimates at a half-hour block', () => {
    const fill = autofillFromTask({ title: 't', estimated_minutes: 10 });
    expect(fill.duration_hours).toBe(0.5);
    expect(fill.planned_minutes).toBe(10);
  });

  it('falls back to the default block when the task has no estimate left', () => {
    const noEstimate = autofillFromTask({ title: 't', estimated_minutes: null });
    expect(noEstimate.duration_hours).toBe(DEFAULT_EVENT_DURATION_HOURS);
    expect(noEstimate.planned_minutes).toBeNull();

    const exhausted = autofillFromTask({ title: 't', estimated_minutes: 60 }, 60);
    expect(exhausted.duration_hours).toBe(DEFAULT_EVENT_DURATION_HOURS);
    expect(exhausted.planned_minutes).toBeNull();
  });
});

describe('eventCompletion', () => {
  it('is none without links', () => {
    expect(eventCompletion([])).toBe('none');
  });

  it('is none while no linked task is finished', () => {
    expect(eventCompletion([{ completed: false }, { task_status: 'doing' }])).toBe('none');
  });

  it('is partial when some linked tasks are finished', () => {
    expect(eventCompletion([{ completed: true }, { completed: false }])).toBe('partial');
  });

  it('is done when every linked task is finished', () => {
    expect(eventCompletion([{ completed: true }, { task_status: 'done' }])).toBe('done');
  });
});
