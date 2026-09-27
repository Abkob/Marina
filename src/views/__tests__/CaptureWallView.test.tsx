// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptureWallView } from '../CaptureWallView';
import { setNoteCompleted, updateNoteContent } from '../../db/queries/notes';
import type { DBNote } from '../../db/schema';
import { apiPost } from '../../utils/apiFetch';

const state = vi.hoisted(() => ({ notes: [] as DBNote[], now: new Date('2026-09-27T12:00:00') }));
vi.mock('../../utils/useNow', () => ({ useNow: () => state.now }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: () => ({ triggerToast: vi.fn(), showConfirm: vi.fn() }) }));
vi.mock('../../db/queries/notes', () => ({ createNote: vi.fn(), updateNoteContent: vi.fn(), setNoteCompleted: vi.fn(), deleteNote: vi.fn() }));
vi.mock('../../utils/apiFetch', () => ({ apiFetch: async (url: string) => url === '/api/notes' ? state.notes : [], apiPost: vi.fn() }));

const note = (overrides: Partial<DBNote> = {}): DBNote => ({
  id: 'note-1', title: 'A thought', content: 'Original thought', type: 'thought', date_str: '',
  suggested_action_text: null, suggested_action_applied: false, suggested_action_ignored: false,
  extracted_tasks_json: '[]', relevant_docs_json: '[]', created_at: '2026-09-27T10:00:00', updated_at: '2026-09-27T10:00:00',
  ...overrides,
});

const clients: QueryClient[] = [];
function renderWall() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = () => <QueryClientProvider client={client}><CaptureWallView /></QueryClientProvider>;
  const result = render(view());
  return { ...result, refreshClock: () => result.rerender(view()) };
}

beforeEach(() => {
  state.now = new Date('2026-09-27T12:00:00');
  state.notes = [note()];
  vi.mocked(setNoteCompleted).mockImplementation(async (id, completed, content) => {
    state.notes = state.notes.map(n => n.id === id ? {
      ...n, completed_at: completed ? state.now.toISOString() : null,
      ...(content !== undefined ? { content } : {}),
    } : n);
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.resetAllMocks();
});

it('retains edited text after a failed close and saves it on retry', async () => {
  vi.mocked(updateNoteContent).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(undefined);
  renderWall();
  fireEvent.click(await screen.findByRole('button', { name: 'Open note Original thought' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Capture note content' }), { target: { value: 'My edited thought' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and close note' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your text is still here');
  expect(screen.getByRole('textbox', { name: 'Capture note content' })).toHaveValue('My edited thought');
  fireEvent.click(screen.getByRole('button', { name: 'Save and close note' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(updateNoteContent).toHaveBeenLastCalledWith('note-1', 'My edited thought');
});

it('carries unfinished notes across multiple days and excludes notes not created yet', async () => {
  state.notes = [note({ created_at: '2026-09-23T09:00:00' }), note({ id: 'future', content: 'Future thought', created_at: '2026-09-28T09:00:00' })];
  renderWall();
  expect(await screen.findByRole('button', { name: 'Open note Original thought' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open note Future thought' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous capture day' }));
  expect(screen.getByRole('button', { name: 'Open note Original thought' })).toBeInTheDocument();
});

it('finishes an older sticky on the completion day and preserves it after remounting', async () => {
  state.notes = [note({ created_at: '2026-09-23T09:00:00' })];
  const wall = renderWall();
  fireEvent.click(await screen.findByRole('button', { name: 'Mark note Original thought as finished' }));
  expect((await screen.findByRole('button', { name: 'Open finished note Original thought' })).querySelector('s')).toHaveTextContent('Original thought');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Open note Original thought' })).not.toBeInTheDocument());
  expect(setNoteCompleted).toHaveBeenCalledWith('note-1', true, undefined);
  wall.unmount();
  renderWall();
  expect(await screen.findByRole('button', { name: 'Open finished note Original thought' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous capture day' }));
  expect(screen.queryByRole('button', { name: 'Open finished note Original thought' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Return to today' }));
  expect(screen.getByRole('button', { name: 'Open finished note Original thought' })).toBeInTheDocument();
});

it('keeps only unfinished stickies on the next day and finds finished ones in yesterday', async () => {
  state.notes = [note(), note({ id: 'done', content: 'Finished thought', completed_at: state.now.toISOString() })];
  const wall = renderWall();
  await screen.findByRole('button', { name: 'Open finished note Finished thought' });
  state.now = new Date('2026-09-28T00:00:01');
  wall.refreshClock();
  expect(screen.getByRole('button', { name: 'Open note Original thought' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open finished note Finished thought' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous capture day' }));
  expect(screen.getByRole('button', { name: 'Open finished note Finished thought' })).toBeInTheDocument();
});

it('uses the local completion date near midnight rather than slicing the UTC date', async () => {
  state.notes = [note({ created_at: '2026-09-26T09:00:00', completed_at: new Date('2026-09-27T00:15:00').toISOString() })];
  renderWall();
  expect(await screen.findByRole('button', { name: 'Open finished note Original thought' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous capture day' }));
  expect(screen.queryByRole('button', { name: 'Open finished note Original thought' })).not.toBeInTheDocument();
});

it('reopens a finished note from a previous day and carries it onto today', async () => {
  state.notes = [note({ created_at: '2026-09-25T09:00:00', completed_at: '2026-09-26T18:00:00' })];
  renderWall();
  fireEvent.click(screen.getByRole('button', { name: 'Previous capture day' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reopen note Original thought' }));
  expect(await screen.findByRole('button', { name: 'Open note Original thought' })).toBeInTheDocument();
  expect(setNoteCompleted).toHaveBeenCalledWith('note-1', false, undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Return to today' }));
  expect(screen.getByRole('button', { name: 'Open note Original thought' })).toBeInTheDocument();
});

it('saves editor changes and completion together, retaining the draft when finishing fails', async () => {
  vi.mocked(setNoteCompleted).mockRejectedValueOnce(new Error('Offline'));
  renderWall();
  fireEvent.click(await screen.findByRole('button', { name: 'Open note Original thought' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Capture note content' }), { target: { value: 'Updated before finishing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark as finished' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not update');
  expect(screen.getByRole('textbox', { name: 'Capture note content' })).toHaveValue('Updated before finishing');
  expect(screen.queryByRole('button', { name: 'Open finished note Updated before finishing' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Mark as finished' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(setNoteCompleted).toHaveBeenLastCalledWith('note-1', true, 'Updated before finishing');
  expect(await screen.findByRole('button', { name: 'Open finished note Updated before finishing' })).toBeInTheDocument();
});

it('does not overwrite a finished note when inspecting or closing it', async () => {
  state.notes = [note({ content: '<p>Formatted thought</p>', completed_at: state.now.toISOString() })];
  renderWall();
  fireEvent.click(await screen.findByRole('button', { name: 'Open finished note Formatted thought' }));
  expect(screen.getByRole('textbox', { name: 'Capture note content' })).toHaveAttribute('readonly');
  fireEvent.click(screen.getByRole('button', { name: 'Save and close note' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(updateNoteContent).not.toHaveBeenCalled();
  expect(setNoteCompleted).not.toHaveBeenCalled();
});

it('logging a note as a journal does not finish it', async () => {
  vi.mocked(apiPost).mockResolvedValue({});
  renderWall();
  fireEvent.click(await screen.findByRole('button', { name: 'Open note Original thought' }));
  fireEvent.click(screen.getByRole('button', { name: 'Log note as journal entry' }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/journal', expect.objectContaining({ source_note_id: 'note-1' })));
  expect(setNoteCompleted).not.toHaveBeenCalled();
  expect(state.notes[0].completed_at).toBeUndefined();
});
