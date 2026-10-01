// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resources: vi.fn(), retry: vi.fn(), open: vi.fn() }));
vi.mock('../../api/hooks', () => ({ useAllResources: mocks.resources, useInvalidate: () => vi.fn() }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: () => ({ focusedResourceId: null, setFocusedResourceId: mocks.open, triggerToast: vi.fn(), showConfirm: vi.fn() }) }));
vi.mock('../../views/ResourceProfilePage', () => ({ ResourceProfilePage: () => null }));
vi.mock('../FileViewerModal', () => ({ FileViewerModal: ({ name }: { name: string }) => <div role="dialog" aria-label={`Preview ${name}`} /> }));
import { ResourcesView } from '../../views/ResourcesView';
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
describe('resource library availability feedback', () => {
  it('distinguishes a failed fetch from an empty library', () => {
    mocks.resources.mockReturnValue({ data: [], isError: true, isFetching: false, refetch: mocks.retry });
    render(<ResourcesView />);
    expect(screen.getByRole('alert')).toHaveTextContent('saved files have not been removed');
    expect(screen.queryByText(/Library is empty/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });
  it('shows loading while the initial resource list is still pending', () => {
    mocks.resources.mockReturnValue({ data: [], isError: false, isFetching: true, refetch: mocks.retry });
    render(<ResourcesView />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading library');
    expect(screen.queryByText(/Library is empty/)).not.toBeInTheDocument();
  });
  it('shows the empty-state action only after a successful empty response', () => {
    mocks.resources.mockReturnValue({ data: [], isError: false, isFetching: false, refetch: mocks.retry });
    render(<ResourcesView />);
    expect(screen.getByText(/Library is empty/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add first resource' })).toBeEnabled();
  });
  it('opens a UUID-backed file using its original filename and isolates nested keyboard actions', () => {
    mocks.resources.mockReturnValue({ data: [{ id: 'file-a', title: 'Research', original_name: 'Research.pdf', mime_type: 'application/pdf', file_validation: 'valid',
      file_path: 'https://x.private.blob.vercel-storage.com/research.pdf', url: '/api/resources/blob/file-a', type: 'document', read_state: 'Unread', tags_json: '[]', created_at: '2026-10-01T00:00:00Z' }], isError: false, isFetching: false, refetch: mocks.retry });
    render(<ResourcesView />);
    const preview = screen.getByRole('button', { name: 'Preview Research' });
    fireEvent.keyDown(preview, { key: 'Enter' });
    expect(mocks.open).not.toHaveBeenCalled();
    fireEvent.click(preview);
    expect(screen.getByRole('dialog', { name: 'Preview Research.pdf' })).toBeInTheDocument();
  });
});
