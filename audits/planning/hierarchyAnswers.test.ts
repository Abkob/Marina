import { describe, expect, it, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadHierarchyAnswerFixtures, hierarchyAnswerSuiteSchema, answerHash } from './hierarchyAnswerFixtures.js';
import { evaluateHierarchyReply, answerAccepted, replayGate, verifyReplayReceipt } from './hierarchyAnswerEvaluation.js';
import { hierarchyAnswerReplay, saveAnswerReceipt, captureAnswerIdentity } from './hierarchyAnswerReplay.js';
import { createHierarchyFixtureTools } from './hierarchyFixtureTools.js';
import { createCopilotTools } from '../../server/services/copilotTools.js';
import { compactSchema } from '../../server/services/copilotContracts.js';
import { packContext, unpackContext } from '../../server/services/copilotContextWire.js';
import { runCopilotConversation } from '../../server/services/copilotConversation.js';
import type { chat } from '../../server/ollama.js';

const suite=loadHierarchyAnswerFixtures();
describe('P03.2.7 independent answer replays',()=>{
  it.each(suite.cases.flatMap(fixture=>fixture.samples.map(sample=>({fixture,sample}))))('U01 $sample.id has the independently expected acceptance',({fixture,sample})=>{
    const verdicts=evaluateHierarchyReply(fixture,{reply:sample.reply,actions:[]},{writes:0});
    expect(answerAccepted(verdicts)).toBe(sample.expected_verdict==='pass');
    expect(Object.values(verdicts).some(row=>row.status==='unavailable')).toBe(false);
  });
  it('U02 the original wrong prose fails despite correct numeric metadata and no action',()=>{
    const fixture=suite.cases.find(row=>row.id==='C02-additive')!;
    const sample=fixture.samples.find(row=>row.id==='correct-metadata-wrong-prose')!;
    const verdicts=evaluateHierarchyReply(fixture,{reply:sample.reply,actions:[],claims:{subtree_remaining_minutes:150}},{writes:0});
    expect(verdicts.facts.status).toBe('pass');expect(verdicts.grounding.status).toBe('fail');expect(answerAccepted(verdicts)).toBe(false);
  });
  it('U03 an unseen paraphrase or unavailable judge cannot be inferred correct from a numeric token',()=>{
    const fixture=suite.cases[1];const reply='150 minutes. Do the report in thirty minutes and you are done.';
    const verdicts=evaluateHierarchyReply(fixture,{reply,actions:[]},{writes:0});
    expect(verdicts.protocol.status).toBe('pass');expect(verdicts.usefulness.status).toBe('unavailable');expect(answerAccepted(verdicts)).toBe(false);
    const sample=fixture.samples[0];const changed=evaluateHierarchyReply(fixture,{reply:`${sample.reply} Changed.`,actions:[]},{writes:0,review:sample.review});
    expect(changed.facts.status).toBe('unavailable');
  });
  it.each(['version','missing-ledger','stale-review','missing-quote','duplicate-id','credential-field','unsafe-minutes'])('U04 malformed %s fixture fails closed',kind=>{
    const value=structuredClone(suite) as any;
    if(kind==='version')value.version=0;
    if(kind==='missing-ledger')value.recovery_checks=[];
    if(kind==='stale-review')value.cases[0].samples[0].reply+=' Changed';
    if(kind==='missing-quote')value.cases[0].samples[0].review.checks[0].quote='Absent claim';
    if(kind==='duplicate-id')value.cases[0].tasks[1].id=value.cases[0].tasks[0].id;
    if(kind==='credential-field')value.credentials='secret';
    if(kind==='unsafe-minutes')value.cases[0].expected.tasks[0].own_minutes=Number.MAX_SAFE_INTEGER;
    expect(hierarchyAnswerSuiteSchema.safeParse(value).success).toBe(false);
  });
  it('U05 the replay gate rejects missing results, judge failures, malformed grades and a deliberately accepted original bad answer',()=>{
    const run=hierarchyAnswerReplay();expect(run.gate.pass).toBe(true);expect(run.gate.planning_release_qualified).toBe(false);
    expect(replayGate(suite,run.rows.slice(1)).pass).toBe(false);
    const bad=structuredClone(run.rows);const original=bad.find(row=>row.sample_id==='E01-E02-recheck-shortfall')!;
    for(const grade of Object.values(original.verdicts)){grade.status='pass';grade.reasons=['Broken judge accepted historical failure'];}
    expect(replayGate(suite,bad).pass).toBe(false);
    const unavailable=structuredClone(run.rows);unavailable[0].verdicts.usefulness.status='unavailable';expect(replayGate(suite,unavailable).pass).toBe(false);
    const malformed=structuredClone(run.rows) as any;malformed[0].verdicts.facts.status='maybe';expect(replayGate(suite,malformed).pass).toBe(false);
  });
  it('U06 stale/malformed receipts and a claimed green gate cannot override the actual verdicts',()=>{
    const run=hierarchyAnswerReplay();const fingerprint=createHash('sha256').update(readFileSync('audits/planning/fixtures/hierarchyAnswers.json')).digest('hex');
    const receipt={version:1,run_id:'f0320000-0000-4000-8000-000000000099',fixture_version:1,fixture_sha256:fingerprint,kind:'offline_curated_replay',verdicts:run.rows};
    expect(verifyReplayReceipt(receipt,fingerprint,suite).pass).toBe(true);
    for(const value of [null,{...receipt,fixture_sha256:'0'.repeat(64)},{...receipt,fixture_version:0},{...receipt,verdicts:[],gate:{pass:true}}])expect(verifyReplayReceipt(value,fingerprint,suite).pass).toBe(false);
    expect(()=>loadHierarchyAnswerFixtures('tmp/definitely-missing-hierarchy-fixture.json')).toThrow();
  });
  it('U07 receipts use unique paths and fixed identities without overwriting earlier attempts',async()=>{
    const a=await saveAnswerReceipt('unit-receipt',{kind:'test',run_id:'wrong',fixture_version:99});
    const before=readFileSync(a.file,'utf8');const b=await saveAnswerReceipt('unit-receipt',{kind:'test'});
    expect(a.file).not.toBe(b.file);expect(readFileSync(a.file,'utf8')).toBe(before);
    expect(a.receipt.fixture_version).toBe(1);expect(a.receipt.run_id).not.toBe('wrong');
  });
  it('U08 all ten original ledger IDs have replay or explicit still-open provider-recovery evidence',()=>{
    const ids=new Set([...suite.cases.flatMap(row=>row.failure_ids),...suite.recovery_checks.map(row=>row.id)]);
    for(let n=1;n<=10;n++)expect(ids.has(`E${String(n).padStart(2,'0')}`)).toBe(true);
    expect(suite.recovery_checks.every(row=>row.disposition==='historical_failure_current_recovery_open')).toBe(true);
    expect(suite.transcript_states.map(row=>row.state).sort()).toEqual(['accepted','canceled','provider_unavailable','unsaved','unverified']);
    expect(suite.transcript_states.find(row=>row.state==='unsaved')).toMatchObject({accepted_recommendation:true,saved:false,recovery:'save_retry'});
  });
  it('U09 correctness and usefulness are separate even for a complete readable answer',()=>{
    const fixture=suite.cases[1];const sample=fixture.samples.find(row=>row.id==='facts-only-unhelpful')!;
    const grades=evaluateHierarchyReply(fixture,{reply:sample.reply,actions:[]},{writes:0});
    expect(grades.facts.status).toBe('pass');expect(grades.arithmetic.status).toBe('pass');expect(grades.usefulness.status).toBe('fail');
    expect(answerAccepted(grades)).toBe(false);
  });
  it('U10 independent expected values do not import the production aggregator, and available original receipts keep their hashes',()=>{
    for(const file of ['hierarchyAnswerFixtures.ts','hierarchyAnswerEvaluation.ts','hierarchyFixtureTools.ts','liveModels.ts'])
      expect(readFileSync(`audits/planning/${file}`,'utf8')).not.toContain('buildWorkHierarchy');
    for(const source of suite.sources){const file=`tmp/planning-baseline/${source.file}`;if(existsSync(file))expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(source.sha256);}
  });
  it('U11 a delayed receipt retains the input identity captured at attempt start',async()=>{
    const identity={...captureAnswerIdentity(),fixture_sha256:'a'.repeat(64)};
    const saved=await saveAnswerReceipt('identity-race',{kind:'test'},undefined,identity);
    expect(saved.receipt.fixture_sha256).toBe(identity.fixture_sha256);
    expect(saved.receipt.fixture_sha256).not.toBe(captureAnswerIdentity().fixture_sha256);
  });
  it('I01 fixture adapters retain production schemas, selected sections and lossless packed observations',async()=>{
    const noop=async()=>({});const actual=createCopilotTools({workspace:noop,previewSchedule:noop,previewRoutine:noop,scheduleDay:noop,overdueTasks:noop});
    for(const fixture of suite.cases){
      const {tools}=createHierarchyFixtureTools(fixture);
      for(const name of Object.keys(actual))expect(compactSchema(tools[name].parameters)).toBe(compactSchema(actual[name].parameters));
      expect(tools.task_details.parameters.safeParse({task_ids:[fixture.tasks[0].id],unexpected:true}).success).toBe(false);
      const data=(await tools.task_details.execute(tools.task_details.parameters.parse({task_ids:[fixture.tasks[0].id]}) as any)).data;
      expect(unpackContext(JSON.parse(JSON.stringify(packContext(data))))).toEqual(data);
      const resourceData=(await tools.workspace_context.execute({sections:['resources']})).data as any;
      expect(resourceData.graph).toBeUndefined();expect(resourceData.included_sections).toEqual(['resources']);
      await expect(tools.preview_schedule.execute({horizon_days:1})).rejects.toThrow('No application data');
    }
  });
  it('I02 real conversation still returns the historical bad read-only answer, and the independent replay rejects it',async()=>{
    const fixture=suite.cases[1];const sample=fixture.samples.find(row=>row.id==='E01-E02-recheck-shortfall')!;
    const {tools}=createHierarchyFixtureTools(fixture);let observed='';
    const complete=vi.fn<typeof chat>().mockResolvedValueOnce(JSON.stringify({tool_calls:[{id:'work',name:'workspace_context',arguments:{sections:['tasks','resources']}}]}))
      .mockImplementationOnce(async messages=>{observed=messages.at(-1)!.content;return JSON.stringify({reply:sample.reply,actions:[]});});
    const result=await runCopilotConversation({turns:[{role:'user',content:fixture.prompt}],clock:{today:'2026-10-06',time:'12:00',timezone:'Asia/Beirut'},tools,complete});
    expect(result.reply).toBe(sample.reply);expect(result.actions).toEqual([]);expect(observed).toContain('Tool observations');
    expect(answerAccepted(evaluateHierarchyReply(fixture,result,{writes:0}))).toBe(false);
    // This is a reproduced runtime gap owned by P03.2.10, not a repaired answer validator.
  });
  it('S01 100 bounded replays preserve grades under sample/task reordering and reject an out-of-scope identity',()=>{
    for(let n=0;n<100;n++){
      const fixture=structuredClone(suite.cases[n%suite.cases.length]);if(n%2)fixture.tasks.reverse();
      for(const sample of fixture.samples)expect(answerAccepted(evaluateHierarchyReply(fixture,{reply:sample.reply,actions:[]},{writes:0}))).toBe(sample.expected_verdict==='pass');
    }
    const fixture=suite.cases[0];const sample=fixture.samples[0];const review=structuredClone(sample.review);
    (review.checks[0] as any).task_id='f0320000-0000-4000-8000-000000000999';
    expect(evaluateHierarchyReply(fixture,{reply:sample.reply,actions:[]},{writes:0,review}).scope.status).toBe('fail');
    expect(suite.cases[0].samples[0].review.reply_sha256).toBe(answerHash(sample.reply));
  });
});
