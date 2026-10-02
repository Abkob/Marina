// @vitest-environment node
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ query: vi.fn(), open: vi.fn(), render: vi.fn(), analyze: vi.fn(), ocr: vi.fn(), parse: vi.fn(), enabled: vi.fn() }));
vi.mock('../../../server/db.js', () => ({ query: mock.query }));
vi.mock('../../../server/services/fileStorage.js', () => ({ openStoredFile: mock.open }));
vi.mock('../../../server/services/pdfText.js', () => ({ renderPdfPage: mock.render }));
vi.mock('../../../server/services/nvidiaEvidence.js', () => ({ analyzeDocumentImage: mock.analyze, transcribeDocumentImage: mock.ocr, parseDocumentImage: mock.parse, nvidiaEvidenceAvailable: mock.enabled, MAX_VISION_IMAGE_BYTES: 8 * 1024 * 1024 }));
import { defaultEvidenceModels } from '../../../server/services/copilotModelRoles.js';
import { findResources, readDocument, inspectDocumentPage } from '../../../server/services/documentReading.js';
const resource = { id: 'r', title: 'Paper', status: 'ready', mime_type: 'application/pdf', file_path: 'gdrive://private-id', file_id: 'private-id', checked_at: 'yesterday', last_error: null };
beforeEach(() => {
  vi.resetAllMocks(); mock.query.mockResolvedValue({ rows: [resource] }); mock.enabled.mockReturnValue(true);
  mock.open.mockResolvedValue({ size: 3, stream: Readable.from([Buffer.from('pdf')]) });
  mock.render.mockResolvedValue({ dataUrl: 'data:image/png;base64,cGRm', total: 5 });
  mock.analyze.mockResolvedValue({ analysis: 'After: 45', evidence_type: 'model_interpretation_of_image' });
  mock.ocr.mockRejectedValue(new Error('OCR unavailable'));
});

describe('document discovery and reading', () => {
  it('pages literal title queries and excludes archived/unavailable resources', async () => {
    mock.query.mockResolvedValue({ rows: [resource, { ...resource, id: 's' }] });
    const result = await findResources({ search: '50% draft_', after: 'q', limit: 1 });
    expect(result).toMatchObject({ has_more: true, next_after: 'r', resources: [{ id: 'r', source_url: 'https://drive.google.com/file/d/private-id/view' }] });
    expect(mock.query.mock.calls[0][1]).toEqual(['%50\\%%', '%draft\\_%', 'q', 2]);
    expect(mock.query.mock.calls[0][0]).toContain('archived_at'); expect(mock.query.mock.calls[0][0]).toContain('d.available');
    expect(JSON.stringify(result)).not.toContain('gdrive://');
  });
  it('reports missing resources instead of reading an arbitrary original', async () => {
    mock.query.mockResolvedValue({ rows: [] });
    await expect(inspectDocumentPage({ resource_id: 'missing', page: 1, question: 'q' })).rejects.toThrow('missing');
    expect(mock.open).not.toHaveBeenCalled();
  });
  it('reads consecutive passages with an exact page filter and continuation', async () => {
    mock.query.mockResolvedValueOnce({ rows: [resource] }).mockResolvedValueOnce({ rows: [
      { id: 'c4', chunk_index: 4, content: 'passage', page_start: 3, page_end: 3 },
      { id: 'c5', chunk_index: 5, content: 'next' },
    ] });
    const result = await readDocument({ resource_id: 'r', page: 3, after_chunk: 3, limit: 1 });
    expect(result).toMatchObject({ passages: [{ chunk_id: 'c4', passage: 'passage', page_start: 3 }], has_more: true, next_after_chunk: 4 });
    expect(mock.query.mock.calls[1][1]).toEqual(['r', 3, 3, 2]);
  });
  it.each(['queued', 'extracting', 'unsupported', 'no_text', 'failed'])('does not present an old text generation as ready during %s', async status => {
    mock.query.mockResolvedValue({ rows: [{ ...resource, status }] });
    expect(await readDocument({ resource_id: 'r' })).toMatchObject({ status, passages: [] });
    expect(mock.query).toHaveBeenCalledOnce();
  });
  it('inspects the requested original page even when no text layer was indexed', async () => {
    mock.query.mockResolvedValue({ rows: [{ ...resource, status: 'no_text' }] });
    const result = await inspectDocumentPage({ resource_id: 'r', page: 3, question: 'Read the chart' });
    expect(mock.render).toHaveBeenCalledWith(new Uint8Array(Buffer.from('pdf')), 3);
    expect(mock.analyze).toHaveBeenCalledWith('Read the chart', 'data:image/png;base64,cGRm', undefined);
    expect(result).toMatchObject({ resource_id: 'r', page_start: 3, page_end: 3, total_pages: 5, analysis: 'After: 45' });
    expect(JSON.stringify(result)).not.toContain('data:image');
  });
  it('propagates visual service failure without inventing an answer', async () => {
    mock.analyze.mockRejectedValue(new Error('HTTP 503'));
    await expect(inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' })).rejects.toThrow('503');
  });
  it('returns a disclosed OCR fallback when vision is busy, without claiming visual interpretation', async () => {
    mock.analyze.mockRejectedValue(new Error('HTTP 503'));
    mock.ocr.mockResolvedValue({ text: 'Before 25 After 45', evidence_type: 'ocr_transcription' });
    expect(await inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' }, defaultEvidenceModels)).toMatchObject({ text: 'Before 25 After 45', vision_unavailable: true, fallback_from: 'vision', evidence_type: 'ocr_transcription' });
  });
  it('never overrides disabled OCR to recover a visual outage', async () => {
    mock.analyze.mockRejectedValue(new Error('HTTP 503'));
    await expect(inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' }, { ...defaultEvidenceModels, ocr: 'off' })).rejects.toThrow('503');
    expect(mock.ocr).not.toHaveBeenCalled();
  });
  it.each(['ocr', 'structure'] as const)('routes %s to its selected specialist and preserves page provenance', async mode => {
    const selected = { ...defaultEvidenceModels, ocr: 'nvidia/nemotron-ocr-v1' };
    const specialist = mode === 'ocr' ? mock.ocr : mock.parse;
    specialist.mockResolvedValue({ text: 'page evidence' });
    expect(await inspectDocumentPage({ resource_id: 'r', page: 2, question: 'Read', mode }, selected)).toMatchObject({ text: 'page evidence', page_start: 2, page_end: 2, source_url: 'https://drive.google.com/file/d/private-id/view' });
    expect(specialist).toHaveBeenCalledWith('data:image/png;base64,cGRm', selected[mode]);
    expect(mock.analyze).not.toHaveBeenCalled();
  });
  it.each(['ocr', 'vision', 'structure'] as const)('honors disabled %s before reading originals', async mode => {
    await expect(inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q', mode }, { ...defaultEvidenceModels, [mode]: 'off' })).rejects.toThrow('disabled');
    expect(mock.open).not.toHaveBeenCalled(); expect(mock.query).not.toHaveBeenCalled();
  });
  it('does not download originals when the service is unconfigured', async () => {
    mock.enabled.mockReturnValue(false);
    await expect(inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' })).rejects.toThrow('not configured');
    expect(mock.query).not.toHaveBeenCalled(); expect(mock.open).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'text/html', 'image/svg+xml'])('rejects unsupported %s originals', async mime_type => {
    mock.query.mockResolvedValue({ rows: [{ ...resource, mime_type }] });
    await expect(inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' })).rejects.toThrow('supports');
    expect(mock.open).not.toHaveBeenCalled();
  });
  it('rejects an image page other than one', async () => {
    mock.query.mockResolvedValue({ rows: [{ ...resource, mime_type: 'image/png' }] });
    await expect(inspectDocumentPage({ resource_id: 'r', page: 2, question: 'q' })).rejects.toThrow('page');
    expect(mock.open).not.toHaveBeenCalled();
  });
  it('reads an image directly without invoking the PDF parser', async () => {
    mock.query.mockResolvedValue({ rows: [{ ...resource, mime_type: 'image/png' }] });
    expect(await inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' })).toMatchObject({ total_pages: 1 });
    expect(mock.render).not.toHaveBeenCalled();
  });
  it('rejects oversized original metadata and releases its stream', async () => {
    const stream = Readable.from([Buffer.from('x')]);
    mock.open.mockResolvedValue({ size: 26 * 1024 * 1024, stream });
    await expect(inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' })).rejects.toThrow('25 MB');
    expect(stream.destroyed).toBe(true); expect(mock.render).not.toHaveBeenCalled();
  });
  it('enforces the byte limit even when storage underreports size', async () => {
    const stream = Readable.from([Buffer.alloc(26 * 1024 * 1024)]);
    mock.open.mockResolvedValue({ size: 1, stream });
    await expect(inspectDocumentPage({ resource_id: 'r', page: 1, question: 'q' })).rejects.toThrow('size limit');
    expect(stream.destroyed).toBe(true); expect(mock.render).not.toHaveBeenCalled();
  });
});
