import fs from 'node:fs';

// tsx resolves extensionless imports locally; Vercel's emitted native ESM does
// not. Inspect the actual server dependency graph before tsx can hide the error.
const graph = JSON.parse(fs.readFileSync(new URL('../tmp/vercel-api-meta.json', import.meta.url), 'utf8')) as {
  inputs: Record<string, { imports: Array<{ original?: string }> }>;
};
for (const [file, input] of Object.entries(graph.inputs)) {
  for (const dependency of input.imports) {
    if (dependency.original?.startsWith('.') && !/\.(?:[cm]?js|json|node)$/.test(dependency.original)) {
      throw new Error(`Native server import needs its emitted file extension: ${file} → ${dependency.original}`);
    }
  }
}

process.env.VERCEL = '1';
process.env.NODE_ENV = 'production';

const entry = await import('../api/index.js');
if (typeof entry.default !== 'function') {
  throw new Error('api/index.ts must default-export an Express request handler');
}

// Exercise lazy PDF dependencies on the build's OS as well as importing the
// handler. A successful entry import alone cannot prove PDF workers are usable.
const { extractPdfPages } = await import('../server/services/pdfText.js');
const { textPdf } = await import('../server/__tests__/fixtures/uploadPdf.js');
const pdf = await extractPdfPages(new Uint8Array(textPdf('Marina PDF deployment check')));
if (pdf.total !== 1 || !pdf.pages[0]?.text.includes('Marina PDF deployment check')) {
  throw new Error('PDF extraction failed the serverless readiness check');
}
console.log(JSON.stringify({ ok: true, listener_started: false, database_touched: false, pdf_extraction: true }));
