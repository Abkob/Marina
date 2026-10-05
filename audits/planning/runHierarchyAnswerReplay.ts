import { hierarchyAnswerReplay, saveAnswerReceipt } from './hierarchyAnswerReplay.js';
import { replayGate } from './hierarchyAnswerEvaluation.js';
const run = hierarchyAnswerReplay();
let negativeControlSampleId: string | undefined;
if (process.argv.includes('--negative-control')) {
  const original = run.suite.cases.flatMap(item => item.samples).find(sample => sample.id === 'E01-E02-recheck-shortfall');
  if (!original) throw new Error('The original shortfall failure is missing from the negative control.');
  negativeControlSampleId = original.id;
  const row = run.rows.find(item => item.sample_id === original.id)!;
  for (const verdict of Object.values(row.verdicts)) { verdict.status = 'pass'; verdict.reasons = ['Deliberately disabled negative-control check.']; }
  run.gate = replayGate(run.suite, run.rows);
}
const { file } = await saveAnswerReceipt('offline-replay', { kind: 'offline_curated_replay', live_provider_calls: 0,
  negative_control_sample_id: negativeControlSampleId, gate: run.gate, verdicts: run.rows, recovery_checks: run.suite.recovery_checks });
console.log(JSON.stringify({ receipt: file, ...run.gate }));
if (!run.gate.pass) process.exitCode = 1;
