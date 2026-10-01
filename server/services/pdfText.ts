import { DocumentError } from './uploadValidation.js';

export async function extractPdfPages(data: Uint8Array) {
  // Import the worker first so its canvas globals are available during PDF.js
  // initialization. The embedded worker survives serverless dependency tracing;
  // PDF.js's default relative worker path may be absent from a Vercel function.
  let phase = 'worker-import';
  const parser = await (async () => {
    try {
      const { getData, CanvasFactory } = await import('pdf-parse/worker');
      phase = 'parser-import';
      const { PDFParse } = await import('pdf-parse');
      phase = 'parser-init';
      PDFParse.setWorker(getData());
      return new PDFParse({ data, CanvasFactory });
    } catch (error) { reportRuntimeFailure(error, phase); throw error; }
  })();
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
