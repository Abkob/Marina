// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JournalView } from '../JournalView';
import type { DBJournalEntry } from '../../api/hooks';

const mocks = vi.hoisted(() => ({ post: vi.fn(), invalidate: vi.fn(), entries: [] as DBJournalEntry[] }));
vi.mock('../../api/hooks', () => ({
  useJournalEntries: () => ({ data: mocks.entries, isLoading: false }),
  useJournalLinks: () => ({ data: [] }), useSearch: () => ({ data: { results: [] } }),
  useInvalidate: () => ({ journal: mocks.invalidate }),
}));
vi.mock('../../utils/apiFetch', () => ({ apiPost: mocks.post, apiFetch: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: () => ({ triggerToast: vi.fn() }) }));
vi.mock('../../components/ProposalsPanel', () => ({ ProposalsPanel: () => null }));
vi.mock('../../components/EntityTopicChips', () => ({ EntityTopicChips: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries = [];
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('scrollTo', vi.fn());
  const drafts = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => drafts.get(key) ?? null, setItem: (key: string, value: string) => drafts.set(key, value), removeItem: (key: string) => drafts.delete(key),
  } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('phone journal', () => {
  it('opens writing on demand and preserves text and its date when dismissed and reopened', () => {
    render(<JournalView />);
    expect(screen.queryByLabelText('Journal entry text')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Write a journal entry' }));
    expect(screen.getByLabelText('Journal entry text')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Journal entry text'), { target: { value: 'Made time for a walk.' } });
    fireEvent.change(screen.getByLabelText('Journal entry date'), { target: { value: '2026-09-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close write an entry' }));
    expect(screen.getByText('Continue writing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Write a journal entry' }));
    expect(screen.getByLabelText('Journal entry text')).toHaveValue('Made time for a walk.');
    expect(screen.getByLabelText('Journal entry date')).toHaveValue('2026-09-20');
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('retains failed saves and closes the editor only when the entry is saved', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ id: 'saved' });
    render(<JournalView />);
    fireEvent.click(screen.getByRole('button', { name: 'Write a journal entry' }));
    fireEvent.change(screen.getByLabelText('Journal entry text'), { target: { value: 'Read chapter four.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log journal entry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log journal entry' })).toBeEnabled());
    expect(screen.getByLabelText('Journal entry text')).toHaveValue('Read chapter four.');
    fireEvent.click(screen.getByRole('button', { name: 'Log journal entry' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('combines date and text filters instead of ignoring search after selecting a date', () => {
    mocks.entries = [
      { id: 'a', entry_date: '2026-09-20', raw_text: 'Read chapter four', ingestion_status: 'processed' },
      { id: 'b', entry_date: '2026-09-20', raw_text: 'Went for a walk', ingestion_status: 'processed' },
    ] as DBJournalEntry[];
    render(<JournalView />);
    expect(screen.queryByLabelText('Search journal entries')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter journal' }));
    fireEvent.change(screen.getByLabelText('Jump to journal date'), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText('Search journal entries'), { target: { value: 'chapter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show entries' }));
    expect(screen.getByText('Read chapter four')).toBeInTheDocument();
    expect(screen.queryByText('Went for a walk')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete journal entry 2026-09-20' })).not.toBeInTheDocument();
  });
});
