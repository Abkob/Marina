// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleDriveResources } from '../GoogleDriveResources';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), post: vi.fn(), reset: vi.fn() }));
vi.mock('../../utils/apiFetch', () => ({ apiFetch: mocks.fetch, apiPost: mocks.post }));
vi.mock('../../utils/blobUpload', () => ({ resetUploadCapabilities: mocks.reset }));
const connection = { configured: true, connected: true, account_email: 'owner@example.test', folder_url: 'https://drive.google.com/drive/folders/abc', last_error: null };
const files = [{ id: 'file1', name: 'Research.pdf', folder: false, supported: true }, { id: 'file2', name: 'Notes.txt', folder: false, supported: true },
  { id: 'file3', name: 'Already.pdf', folder: false, supported: true, resource_id: 'saved' }, { id: 'file4', name: 'Program.exe', folder: false, supported: false }];
const clients: QueryClient[] = [];
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  const imported = vi.fn(); render(<QueryClientProvider client={client}><GoogleDriveResources onImported={imported} /></QueryClientProvider>); return imported;
}
async function open() { fireEvent.click(screen.getByRole('button', { name: /Google Drive/ })); await screen.findByRole('checkbox', { name: 'Import Research.pdf' }); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.fetch.mockImplementation(async url => url.endsWith('/status') ? connection : { files }); mocks.post.mockResolvedValue({ id: 'saved', checked: 2 });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
describe('Drive library controls', () => {
  it('starts collapsed and does not list Drive files until opened', async () => {
    show(); await screen.findByLabelText('Drive connected');
    expect(screen.getByRole('button', { name: /Google Drive/ })).toHaveAttribute('aria-expanded', 'false');
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await open(); expect(screen.getByRole('button', { name: /^Google Drive/ })).toHaveAttribute('aria-expanded', 'true');
  });
  it('clearly distinguishes missing server setup from an empty Drive', async () => {
    mocks.fetch.mockResolvedValue({ ...connection, configured: false, connected: false }); show();
    fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }));
    expect(await screen.findByText(/awaiting server setup/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect Drive' })).toBeDisabled();
  });
  it('keeps supported import selection accessible and disables duplicates and unsupported files', async () => {
    show(); await open();
    expect(screen.getByRole('checkbox', { name: 'Import Already.pdf' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Import Program.exe' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Research.pdf' }));
    expect(screen.getByRole('button', { name: 'Add 1 to library' })).toBeEnabled();
  });
  it('keeps successful imports and exposes the reason for a partial failure', async () => {
    mocks.post.mockResolvedValueOnce({ id: 'saved' }).mockRejectedValueOnce(new Error('Google denied access'));
    const imported = show(); await open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Research.pdf' })); fireEvent.click(screen.getByRole('checkbox', { name: 'Import Notes.txt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Notes.txt: Google denied access');
    expect(imported).toHaveBeenCalledTimes(1); expect(screen.getByRole('status')).toHaveTextContent('1 added');
  });
  it('requires submitting search and sends an encoded literal query', async () => {
    show(); await open(); const field = screen.getByRole('textbox', { name: 'Search Google Drive files' });
    fireEvent.change(field, { target: { value: '50% research' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(2); fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('/api/google-drive/files?search=50%25+research'));
  });
  it('shows sync completion and refreshes the Resource Library', async () => {
    const imported = show(); await open(); fireEvent.click(screen.getByRole('button', { name: 'Sync Google Drive resources' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Checked 2 resources'); expect(imported).toHaveBeenCalled();
  });
  it('shows status fetch failure and provides a touch-accessible retry', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline')); show();
    const retry = await screen.findByRole('button', { name: 'Retry Drive status' });
    expect(retry.className).toContain('min-h-11'); fireEvent.click(retry);
    await screen.findByLabelText('Drive connected'); expect(mocks.reset).toHaveBeenCalled();
  });
});
