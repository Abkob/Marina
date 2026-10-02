// Optional independent experiment. Uses an installed tesseract.js package,
// supplied with --module <absolute module directory>. Not a runtime dependency.
// It downloads public English OCR weights on first use into ignored tmp/.
// All recognition is local; the fixture image is not uploaded.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
const moduleIndex = process.argv.indexOf('--module');
if (moduleIndex < 0 || !process.argv[moduleIndex + 1]) throw new Error('Supply --module pointing to an installed tesseract.js directory');
const require = createRequire(import.meta.url);
const { createWorker } = require(path.resolve(process.argv[moduleIndex + 1]));
const directory = path.resolve('tmp/copilot-ocr');
await mkdir(directory, { recursive: true });
const start = performance.now();
const worker = await createWorker('eng', 1, { cachePath: directory });
try {
  const ready = performance.now();
  const result = await worker.recognize(fileURLToPath(new URL('./fixtures/visual-evidence.png', import.meta.url)));
  const text = result.data.text;
  const findings = {
    fixture: 'Synthetic clean English scan and labelled bar chart; no real-document quality claim',
    ocr_engine: 'tesseract.js',
    worker_start_ms: Math.round(ready - start),
    recognition_ms: Math.round(performance.now() - ready),
    code_found: text.includes('NEBULA-731'),
    before_label_found: /Before\s*:\s*25/i.test(text),
    after_label_found: /After\s*:\s*45/i.test(text),
    recognized_text: text,
    limitation: 'Recognizing labels does not establish chart geometry, reading order, mathematical reasoning, or VLM accuracy.',
  };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
} finally { await worker.terminate(); }
