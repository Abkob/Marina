import { DocumentError } from './uploadValidation.js';

export async function extractPdfPages(data: Uint8Array) {
  // Import the worker first so its canvas globals are available during PDF.js
  // initialization. The embedded worker survives serverless dependency tracing;
  // PDF.js's default relative worker path may be absent from a Vercel function.
  const { getData, CanvasFactory } = await import('pdf-parse/worker');
  const { PDFParse } = await import('pdf-parse');
  PDFParse.setWorker(getData());
  const parser = new PDFParse({ data, CanvasFactory });
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
    throw error;
  } finally {
    await parser.destroy().catch(() => {});
  }
}
