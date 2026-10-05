import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateHierarchyReply, replayGate } from './hierarchyAnswerEvaluation.js';
import { loadHierarchyAnswerFixtures } from './hierarchyAnswerFixtures.js';

export function hierarchyAnswerReplay() {
  const suite = loadHierarchyAnswerFixtures();
  const rows = suite.cases.flatMap(fixture => fixture.samples.map(sample => ({ sample_id: sample.id,
    verdicts: evaluateHierarchyReply(fixture, { reply: sample.reply, actions: [] }, { writes: 0 }) })));
  return { suite, rows, gate: replayGate(suite, rows) };
}
export function captureAnswerIdentity() {
  return { code_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    fixture_version:1,fixture_sha256:createHash('sha256').update(readFileSync('audits/planning/fixtures/hierarchyAnswers.json')).digest('hex') };
}
export async function saveAnswerReceipt(prefix: string, body: Record<string, unknown>, root = 'tmp/planning-answer-evaluations', identity = captureAnswerIdentity()) {
  const runId = randomUUID(); const directory = path.join(root, runId);
  await mkdir(directory, { recursive: true });
  const receipt = { ...body, version: 1, run_id: runId, created_at: new Date().toISOString(), ...identity,
    tracked_working_tree_dirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()),
    node: process.version };
  const file = path.join(directory, `${prefix}.json`);
  await writeFile(file, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return { file, receipt };
}
