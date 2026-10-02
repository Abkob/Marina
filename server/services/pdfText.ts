import { DocumentError } from './uploadValidation.js';

async function createParser(data: Uint8Array) {
  // Import the worker first so its canvas globals are available during PDF.js
  // initialization. The embedded worker survives serverless dependency tracing;
  // PDF.js's default relative worker path may be absent from a Vercel function.
  let phase = 'worker-import';
  return (async () => {
    try {
      const { getData, CanvasFactory } = await import('pdf-parse/worker');
      phase = 'parser-import';
      const { PDFParse } = await import('pdf-parse');
      phase = 'parser-init';
      PDFParse.setWorker(getData());
      return new PDFParse({ data, CanvasFactory });
    } catch (error) { reportRuntimeFailure(error, phase); throw error; }
  })();
}

export async function extractPdfPages(data: Uint8Array) {
  const parser = await createParser(data);
  try {
    return await parser.getText();
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') {
      throw new DocumentError('encrypted_pdf', 'This PDF is password protected. Upload an unlocked copy to index its text.');
    }
    if (name === 'InvalidPDFException' || name === 'FormatError') {
      throw new DocumentError('corrupt_pdf', 'The PDF could not be read. The original file is preserved; try exporting a new PDF.');
    }
    // Missing workers, native dependencies, and other runtime failures are
    // retryable processing errors, not evidence of a damaged user document.
    reportRuntimeFailure(error, 'text-extraction');
    throw error;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** Render one physical page, bounding pixel area before allocating a canvas. */
export async function renderPdfPage(data: Uint8Array, page: number) {
  if (!Number.isInteger(page) || page < 1) throw new Error('Choose a positive PDF page number.');
  const parser = await createParser(data);
  try {
    const info = await parser.getInfo({ partial: [page], parsePageInfo: true });
    if (page > info.total) throw new Error(`This PDF has ${info.total} pages; page ${page} does not exist.`);
    const size = info.pages.find(p => p.pageNumber === page);
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new Error('This PDF page has invalid dimensions.');
    const scale = Math.min(1600 / size.width, 2200 / size.height, 2);
    const result = await parser.getScreenshot({ partial: [page], scale, imageBuffer: false, imageDataUrl: true });
    const screenshot = result.pages.find(p => p.pageNumber === page);
    if (!screenshot?.dataUrl) throw new Error('This PDF page could not be rendered.');
    return { dataUrl: screenshot.dataUrl, total: info.total };
  } finally { await parser.destroy().catch(() => {}); }
}

function reportRuntimeFailure(error: unknown, phase: string) {
  // Never log parser messages: malformed documents can put file text in them.
  const message = error instanceof Error ? error.message : '';
  console.error('PDF runtime failure', {
    phase,
    kind: /cannot find|module not found/i.test(message) ? 'missing-dependency'
      : /native binding|canvas|DOMMatrix/i.test(message) ? 'canvas-runtime'
      : /worker/i.test(message) ? 'worker-runtime' : 'parser-runtime',
  });
}
