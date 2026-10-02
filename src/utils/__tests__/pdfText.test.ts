// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractPdfPages, renderPdfPage } from '../../../server/services/pdfText.js';
import { DocumentError } from '../../../server/services/uploadValidation.js';
import { textPdf } from '../../../server/__tests__/fixtures/uploadPdf.js';
import { encryptedPdf } from '../../../server/__tests__/fixtures/encryptedPdf.js';

afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('pdf-parse'); vi.doUnmock('pdf-parse/worker'); vi.resetModules(); });

describe('serverless PDF extraction', () => {
  it('renders a real PDF page with the embedded serverless worker', async () => {
    const result = await renderPdfPage(new Uint8Array(textPdf('Visual evidence')), 1);
    expect(result.total).toBe(1); expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  });
  it.each([0, -1, 1.5])('rejects invalid physical page %s', async page => {
    await expect(renderPdfPage(new Uint8Array(textPdf()), page)).rejects.toThrow('positive');
  });
  it('does not silently inspect page one when a requested PDF page is absent', async () => {
    await expect(renderPdfPage(new Uint8Array(textPdf()), 2)).rejects.toThrow('does not exist');
  });
  it('extracts real PDF text and page numbers with the embedded worker', async () => {
    const result = await extractPdfPages(new Uint8Array(textPdf('Algebra deployment check')));
    expect(result.total).toBe(1);
    expect(result.pages[0]).toMatchObject({ num: 1 });
    expect(result.pages[0].text).toContain('Algebra deployment check');
  });
  it('preserves an empty page so scanned PDFs can be reported as needing OCR', async () => {
    const result = await extractPdfPages(new Uint8Array(textPdf()));
    expect(result.total).toBe(1);
    expect(result.pages[0].text.trim()).toBe('');
  });
  it('distinguishes corrupt content from an unavailable parser', async () => {
    await expect(extractPdfPages(new Uint8Array(Buffer.from('%PDF-1.7\ninvalid document'))))
      .rejects.toMatchObject({ code: 'corrupt_pdf' });
  });
  it('identifies password protection using the parser error type', async () => {
    await expect(extractPdfPages(new Uint8Array(Buffer.from(encryptedPdf, 'base64'))))
      .rejects.toMatchObject({ code: 'encrypted_pdf' });
  });
  it('keeps a missing worker retryable instead of blaming the uploaded PDF', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('pdf-parse/worker', () => { throw new Error('Native worker dependency unavailable'); });
    const { extractPdfPages: isolatedExtract } = await import('../../../server/services/pdfText.js');
    const error = await isolatedExtract(new Uint8Array(textPdf())).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DocumentError);
    expect(error).not.toHaveProperty('code', 'corrupt_pdf');
    expect(log).toHaveBeenCalledWith('PDF runtime failure', { phase: 'worker-import', kind: 'parser-runtime' });
  });
  it('releases the parser after a runtime failure and keeps it retryable', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('Setting up fake worker failed');
    const destroy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('pdf-parse/worker', () => ({getData: () => 'embedded-worker', CanvasFactory: class {}}));
    vi.doMock('pdf-parse', () => ({PDFParse: class {
      static setWorker() {}
      getText() { return Promise.reject(failure); }
      destroy = destroy;
    }}));
    const { extractPdfPages: isolatedExtract } = await import('../../../server/services/pdfText.js');
    await expect(isolatedExtract(new Uint8Array(textPdf()))).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('PDF runtime failure', { phase: 'text-extraction', kind: 'worker-runtime' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message);
  });
});
