// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResourceUploadPanel } from '../ResourceUploadPanel';
import type { UploadProgressListener } from '../../utils/blobUpload';

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../../db/queries/resources', () => ({ uploadResourceFile: mocks.upload }));

function setup() {
  const onUploaded = vi.fn();
  const onBusyChange = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><ResourceUploadPanel onUploaded={onUploaded} onBusyChange={onBusyChange} /></QueryClientProvider>);
  const select = (files: File[]) => fireEvent.change(screen.getByLabelText('Choose resource files'), { target: { files } });
  return { select, onUploaded, onBusyChange };
}

beforeEach(() => vi.resetAllMocks());

describe('Resource Manager upload feedback', () => {
  it('keeps partial successes visible, continues after failure, and retries only the failed file', async () => {
    const failed = new File(['first'], 'first.pdf');
    const saved = new File(['second'], 'second.pdf');
    mocks.upload.mockRejectedValueOnce(new Error('Storage temporarily unavailable')).mockResolvedValue('saved-id');
    const { select, onUploaded, onBusyChange } = setup();
    select([failed, saved]);
    await screen.findByText('1 saved · 1 failed');
    expect(screen.getByText('Storage temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry first.pdf' }));
    await screen.findByText('2 saved');
    expect(mocks.upload.mock.calls.map(call => call[0])).toEqual([failed, saved, failed]);
    expect(onUploaded).toHaveBeenCalledTimes(2);
  });

  it('serializes files, blocks overlapping selections, and waits for save confirmation', async () => {
    let resolveFirst!: (value: string) => void;
    let report!: UploadProgressListener;
    mocks.upload.mockImplementationOnce((_file: File, progress: UploadProgressListener) => {
      report = progress;
      return new Promise<string>(resolve => { resolveFirst = resolve; });
    }).mockResolvedValue('second-id');
    const { select, onUploaded } = setup();
    const first = new File(['first'], 'first.pdf');
    select([first, new File(['second'], 'second.pdf')]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Upload resource files' })).toBeDisabled();
    fireEvent.drop(screen.getByRole('button', { name: 'Upload resource files' }), { dataTransfer: { files: [first] } });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    act(() => report({ phase: 'uploading', percentage: 42 }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '42');
    act(() => report({ phase: 'saving' }));
    expect(screen.getByText('Saving to library…')).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
    await act(async () => resolveFirst('first-id'));
    await screen.findByText('2 saved');
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(onUploaded).toHaveBeenCalledTimes(2);
  });

  it('explains invalid files immediately while uploading supported files in the same batch', async () => {
    mocks.upload.mockResolvedValue('saved-id');
    const { select } = setup();
    select([new File(['word'], 'report.docx'), new File(['text'], 'notes.txt')]);
    await screen.findByText('1 saved · 1 failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Export Word documents as PDF first');
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry report.docx' })).not.toBeInTheDocument();
  });

  it('refreshes the library and offers an idempotent retry after an uncertain save', async () => {
    mocks.upload.mockImplementation(async (_file: File, report: UploadProgressListener) => {
      report({ phase: 'saving' });
      throw new TypeError('Failed to fetch');
    });
    const { select, onUploaded } = setup();
    select([new File(['data'], 'notes.txt')]);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('same upload safely'));
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Retry notes.txt' })).toBeEnabled();
  });
});
