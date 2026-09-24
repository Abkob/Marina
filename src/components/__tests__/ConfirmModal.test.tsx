// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmModal } from '../ConfirmModal';
import { useAppStore } from '../../store/useAppStore';
vi.mock('zustand/middleware', () => ({ persist: (creator: unknown) => creator }));

afterEach(() => { cleanup(); useAppStore.getState().closeConfirm(); });

it('waits for deletion and prevents repeated submissions', async () => {
  let finish!: () => void;
  const remove = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  useAppStore.getState().showConfirm('Delete this task?', remove);
  render(<ConfirmModal />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(useAppStore.getState().confirmOpen).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(useAppStore.getState().confirmOpen).toBe(false));
});

it('keeps a failed action open with an error and allows retry', async () => {
  const remove = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(undefined);
  useAppStore.getState().showConfirm('Delete this task?', remove);
  render(<ConfirmModal />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  expect(useAppStore.getState().confirmOpen).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(useAppStore.getState().confirmOpen).toBe(false));
  expect(remove).toHaveBeenCalledTimes(2);
});
