// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SemanticIndexPanel } from '../resource-profile/SemanticIndexPanel';
import type { ResourceProcessing } from '../../utils/resourceFiles';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('../../utils/apiFetch', () => ({ apiFetch: mocks.fetch, apiPost: mocks.post }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: () => ({ triggerToast: mocks.toast }) }));
let state: ResourceProcessing;
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  state = { status: 'queued', stage: 'extract', chunks: 0, embedded: 0 };
  mocks.fetch.mockImplementation(async url => url.endsWith('/processing') ? { ...state } : []);
  mocks.post.mockResolvedValue({ status: 'queued' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); });
async function mount() {
  render(<QueryClientProvider client={client}><SemanticIndexPanel resourceId="resource-a" hasFile /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
}
describe('persistent indexing feedback', () => {
  it('polls while zero chunks are queued, then stops when the job finishes', async () => {
    await mount(); expect(screen.getByRole('status')).toHaveTextContent('waiting to check');
    state = { status: 'ready', stage: 'embed', chunks: 1, embedded: 1 };
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(screen.getByRole('status')).toHaveTextContent('Ready for search');
    const count = mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/processing')).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/processing'))).toHaveLength(count);
  });
  it('shows a saved image’s OCR limitation without an endless spinner', async () => {
    state = { ...state, status: 'unsupported', error: 'Image saved. OCR is not enabled.' };
    await mount(); expect(screen.getByRole('status')).toHaveTextContent('OCR is not enabled');
    expect(screen.queryByText(/Not indexed yet/)).not.toBeInTheDocument();
  });
  it('retries failed processing using the existing resource and announces queued work', async () => {
    state = { ...state, status: 'failed', error: 'Index unavailable. Original preserved.' };
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Retry file processing' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(mocks.post).toHaveBeenCalledWith('/api/resources/resource-a/rechunk', {});
    expect(mocks.toast).toHaveBeenCalledWith('Processing queued. Your original file is preserved.', 'success');
  });
  it('makes missing background configuration visible', async () => {
    state = { ...state, worker_available: false };
    await mount(); expect(screen.getByRole('status')).toHaveTextContent('needs to be connected');
  });
  it('shows status fetch failures with a usable retry action', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'));
    await mount(); expect(screen.getByRole('alert')).toHaveTextContent('Could not load processing status');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
  it('keeps incomplete visual coverage visible after text indexing reaches ready', async () => {
    state={status:'ready',stage:'embed',chunks:12,embedded:12,total_pages:6,visual_pages_ready:4,visual_pages_failed:2};
    await mount(); expect(screen.getByRole('status')).toHaveTextContent('2 pages have incomplete visual evidence');
    expect(screen.getByRole('button',{name:'Re-index file'})).toBeEnabled();
  });
  it('offers an explicit visual-index upgrade for a legacy text-only document',async()=>{
    state={status:'ready',stage:'embed',chunks:12,embedded:12,mime_type:'application/pdf'};
    await mount(); expect(screen.getByText(/Text index only/)).toBeVisible();
  });
});
