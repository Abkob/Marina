// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CaptureWallView } from '../CaptureWallView';
import { updateNoteContent } from '../../db/queries/notes';

vi.mock('../../api/hooks', () => ({
  useNotes: () => ({ data: [{ id: 'note-1', title: 'A thought', content: 'Original thought', created_at: `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}T12:00:00` }] }),
  useInvalidate: () => ({ notes: vi.fn(), journal: vi.fn() }),
}));
vi.mock('../../db/queries/notes', () => ({ createNote: vi.fn(), updateNoteContent: vi.fn(), deleteNote: vi.fn() }));
vi.mock('../../utils/apiFetch', () => ({ apiFetch: async () => [], apiPost: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('retains edited text after a failed close and saves it on retry', async () => {
  vi.mocked(updateNoteContent).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CaptureWallView /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open note Original thought' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Capture note content' }), { target: { value: 'My edited thought' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and close note' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your text is still here');
  expect(screen.getByRole('textbox', { name: 'Capture note content' })).toHaveValue('My edited thought');
  fireEvent.click(screen.getByRole('button', { name: 'Save and close note' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(updateNoteContent).toHaveBeenLastCalledWith('note-1', 'My edited thought');
});
