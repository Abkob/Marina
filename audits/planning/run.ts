import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { knownPlanningBaselineFailures, summarizeVitest } from './knownFailures.js';

const output = path.resolve('tmp/planning-baseline');
await mkdir(output, { recursive: true });
await rm(path.join(output, 'receipt.json'), { force: true });
const suites = [
  { name: 'planning', args: ['--config', 'vitest.planning.config.ts'] },
  { name: 'copilot-audit', args: ['--config', 'vitest.copilot-audit.config.ts'] },
  { name: 'focused', args: [
    'src/utils/__tests__/estimateSuggest.test.ts', 'src/utils/__tests__/scheduler.test.ts', 'src/utils/__tests__/planLayout.test.ts',
    'src/utils/__tests__/resourceScopeBoundary.test.ts', 'src/utils/__tests__/copilotPromptBudget.test.ts', 'src/utils/__tests__/copilotContextPersistence.test.ts',
    'src/utils/__tests__/CopilotSources.test.tsx', 'src/utils/__tests__/CopilotMarkdown.test.tsx', 'src/components/__tests__/CopilotTraceDetails.test.tsx',
    'src/components/__tests__/PlanningPreviewBaseline.test.tsx',
  ] },
];
async function execute(name: string, args: string[], extraEnv: Record<string, string> = {}) {
  const file = path.join(output, `${name}.json`);
  await rm(file, { force: true }); // A prior receipt must never stand in for this run.
  const code = await new Promise<number>((resolve, reject) => {
    const processChild = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...args, '--maxWorkers=2', '--reporter=json', `--outputFile=${file}`],
      { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // Generated logs remain local; the receipt below contains test names/counts,
    // never raw provider responses, environment values or credentials.
    let log = ''; processChild.stdout.on('data', data => { log = (log + data).slice(-100000); });
    processChild.stderr.on('data', data => { log = (log + data).slice(-100000); });
    processChild.on('error', reject);
    processChild.on('close', async code => { await writeFile(path.join(output, `${name}.log`), log); resolve(code ?? 1); });
  });
  return { code, raw: JSON.parse(await readFile(file, 'utf8')) };
}
const results: Record<string, ReturnType<typeof summarizeVitest>> = {};
for (const suite of suites) {
  console.log(`Running ${suite.name} baseline...`);
  const { code, raw } = await execute(suite.name, suite.args);
  results[suite.name] = summarizeVitest(raw, code, suite.name === 'copilot-audit' ? knownPlanningBaselineFailures : []);
}
const canary = await execute('negative-control', ['--config', 'vitest.planning.config.ts'], { PLANNING_NEGATIVE_CONTROL: '1' });
const negativeControlPassed = canary.code !== 0 && canary.raw.numFailedTests === 1
  && canary.raw.testResults.some((file: any) => file.assertionResults.some((test: any) => test.fullName.includes('P00.2-S01') && test.status === 'failed'));
const receipt = { version: 1, created_at: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  working_tree_dirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()),
  node: process.version, database_configured: Boolean(process.env.DATABASE_URL_TEST), live_models: false,
  negative_control_passed: negativeControlPassed, known_failures: knownPlanningBaselineFailures, suites: results,
  success: negativeControlPassed && Object.values(results).every(result => result.success),
};
await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ...receipt, suites: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, {
  success: value.success, ordinary_passes: value.ordinary_passes, expected_failures: value.expected_failures.length, failed: value.failed.length, failed_suites: value.failed_suites, skipped: value.skipped.length,
}])) }, null, 2));
if (!receipt.success) process.exitCode = 1;
