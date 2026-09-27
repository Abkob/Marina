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

console.log(JSON.stringify({ ok: true, listener_started: false, database_touched: false }));
