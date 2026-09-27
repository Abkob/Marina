import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGoogleOAuthState,
  decryptGoogleRefreshToken,
  encryptGoogleRefreshToken,
  verifyGoogleOAuthState,
} from '../../../server/services/googleWorkspaceAuth';
import {
  marinaTaskTitleFromGoogle,
  buildGoogleCalendarPayload,
  buildGoogleTaskPayload,
  buildGoogleTaskProjections,
  googleTaskDisplayTitle,
} from '../../../server/services/googleWorkspaceSync';

beforeEach(() => {
  vi.stubEnv('GOOGLE_TOKEN_ENCRYPTION_KEY', 'test-token-encryption-key-that-is-long-enough');
  vi.stubEnv('GOOGLE_OAUTH_STATE_SECRET', 'test-oauth-state-secret-that-is-long-enough');
});

afterEach(() => vi.unstubAllEnvs());

describe('Google Workspace OAuth safety', () => {
  it('encrypts refresh tokens with authenticated encryption', () => {
    const encrypted = encryptGoogleRefreshToken('refresh-token-secret');
    expect(encrypted).not.toContain('refresh-token-secret');
    expect(decryptGoogleRefreshToken(encrypted)).toBe('refresh-token-secret');
    const parts = encrypted.split('.');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    expect(() => decryptGoogleRefreshToken(parts.join('.'))).toThrow();
  });

  it('signs short-lived state and rejects unsafe return URLs', () => {
    const now = Date.UTC(2026, 7, 17, 10);
    const state = createGoogleOAuthState('//attacker.example', now);
    expect(verifyGoogleOAuthState(state, now + 1_000).return_to).toBe('/?google=connected');
    expect(() => verifyGoogleOAuthState(state, now + 11 * 60_000)).toThrow(/expired/i);
  });
});

describe('Google mapping', () => {
  const task = {
    id: '11111111-1111-4111-8111-111111111111',
    goal_id: 'goal-1',
    parent_task_id: 'parent-1',
    title: 'Finish problem set',
    description: 'Questions 1–8',
    due_date: '2026-08-20T18:30:00',
    start_date: '2026-08-18',
    estimated_minutes: 150,
    completed: false,
    position: 1,
    updated_at: '2026-08-17T10:00:00.000Z',
  };

  it('preserves task context while respecting Google Tasks date-only deadlines', () => {
    const payload = buildGoogleTaskPayload(task, 'PSYCI 210', 'Week 4', ['Coursework', 'Week 4', 'Finish problem set']);
    expect(payload.due).toBe('2026-08-20T00:00:00.000Z');
    expect(payload.status).toBe('needsAction');
    expect(payload.title).toBe('Week 4: Finish problem set');
    expect(payload.notes).toContain('Goal: PSYCI 210');
    expect(payload.notes).toContain('Parent: Week 4');
    expect(payload.notes).toContain('Marina path: Coursework > Week 4 > Finish problem set');
    expect(payload.notes).toContain(`Marina task: ${task.id}`);
  });

  it('names only flattened leaves as Parent: Child and keeps Marina titles clean', () => {
    expect(googleTaskDisplayTitle('Finish Studying', ['Incomplete Courses', 'Physics 210', 'Finish Studying']))
      .toBe('Physics 210: Finish Studying');
    expect(googleTaskDisplayTitle('Physics 210', ['Incomplete Courses', 'Physics 210']))
      .toBe('Physics 210');
    expect(marinaTaskTitleFromGoogle(
      'Physics 210: Finish Chapter 6',
      'Finish Studying',
      ['Incomplete Courses', 'Physics 210', 'Finish Studying'],
    )).toBe('Finish Chapter 6');
    expect(marinaTaskTitleFromGoogle(
      'Review for the exam',
      'Finish Studying',
      ['Incomplete Courses', 'Physics 210', 'Finish Studying'],
    )).toBe('Review for the exam');
  });

  it('projects roots and active leaves while hiding unfinished intermediate containers', () => {
    const root = { ...task, id: 'root', parent_task_id: null, title: 'Incomplete Courses', position: 0 };
    const parent = { ...task, id: 'parent', parent_task_id: root.id, title: 'Physics 210', position: 1 };
    const activeLeaf = { ...task, id: 'active-leaf', parent_task_id: parent.id, title: 'Finish Studying', position: 2 };
    const doneLeaf = { ...task, id: 'done-leaf', parent_task_id: parent.id, title: 'Get Slides', completed: true, position: 3 };

    const projection = buildGoogleTaskProjections([root, parent, activeLeaf, doneLeaf]);
    expect(projection.get(root.id)).toMatchObject({ visible: true, google_parent_task_id: null });
    expect(projection.get(parent.id)).toMatchObject({ visible: false, google_parent_task_id: root.id });
    expect(projection.get(activeLeaf.id)).toMatchObject({
      visible: true,
      google_parent_task_id: root.id,
      path_titles: ['Incomplete Courses', 'Physics 210', 'Finish Studying'],
    });
    expect(projection.get(doneLeaf.id)).toMatchObject({ visible: true, google_parent_task_id: root.id });
  });

  it('reveals an intermediate parent after all of its descendants are completed', () => {
    const root = { ...task, id: 'root', parent_task_id: null, title: 'Incomplete Courses', position: 0 };
    const parent = { ...task, id: 'parent', parent_task_id: root.id, title: 'Physics 210', position: 1 };
    const doneLeaf = { ...task, id: 'done-leaf', parent_task_id: parent.id, title: 'Finish Studying', completed: true, position: 2 };

    const projection = buildGoogleTaskProjections([root, parent, doneLeaf]);
    expect(projection.get(parent.id)).toMatchObject({ visible: true, google_parent_task_id: root.id });
  });

  it('creates all-day calendar items with Google-exclusive end dates', () => {
    const payload = buildGoogleCalendarPayload({ kind: 'task_day', row: task }, 'Asia/Beirut');
    expect(payload.start).toEqual({ date: '2026-08-18' });
    expect(payload.end).toEqual({ date: '2026-08-19' });
    expect(payload.extendedProperties.private).toMatchObject({ marinaKind: 'task_day', marinaId: task.id });
  });

  it('keeps an Marina focus block attached to its concrete date and timezone', () => {
    const payload = buildGoogleCalendarPayload({
      kind: 'event',
      row: {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'PSYCI 210 focus',
        type: 'focus',
        day_index: 2,
        start_hour: 9.5,
        duration_hours: 1.5,
        description: '',
        week_start: '2026-08-17',
        updated_at: '2026-08-17T10:00:00.000Z',
      },
    }, 'Asia/Beirut');
    expect(payload.start).toEqual({ dateTime: '2026-08-19T09:30:00', timeZone: 'Asia/Beirut' });
    expect(payload.end).toEqual({ dateTime: '2026-08-19T11:00:00', timeZone: 'Asia/Beirut' });
  });
});
