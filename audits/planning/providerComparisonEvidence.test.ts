import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {hierarchyAnswerCaseSchema,curatedReviewSchema} from './hierarchyAnswerFixtures.js';
import {evaluateHierarchyReply,answerAccepted} from './hierarchyAnswerEvaluation.js';

const evidence=JSON.parse(readFileSync('audits/planning/fixtures/p032-groq-comparison.json','utf8'));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
describe('6 October provider comparison regressions',()=>{
 it('retains unavailable attempts and binds independent reviews to exact public replies',()=>{
  expect(evidence.rows).toHaveLength(14);expect(new Set(evidence.rows.map((r:any)=>`${r.provider}:${r.scenario}`)).size).toBe(14);
  for(const row of evidence.rows){expect(row.application_writes).toBe(0);expect(row.production_data_sent).toBe(false);
   if(row.public_reply){expect(hash(row.public_reply)).toBe(row.public_reply_sha256);
    for(const finding of row.manual_review.findings)expect(row.public_reply).toContain(finding.quote);
   }else{expect(row.manual_review.correctness).toBe('unavailable');expect(row.manual_review.usefulness).toBe('unavailable');}
  }
  expect(evidence.release_qualified).toBe(false);
 });
 it('does not count HTTP 200 with an empty public message as a delivered answer',()=>{
  const rows=evidence.rows.filter((r:any)=>r.provider_http_status===200&&!r.delivered);
  expect(rows.map((r:any)=>r.scenario).sort()).toEqual(['C01-inclusive','C02-additive','C14-unread-resource']);
  for(const row of rows){expect(row.error_code).toBe('INCOMPLETE_RESPONSE');expect(row.public_reply).toBeNull();}
 });
 it.each(['C01-inclusive','C02-additive','C05-required-reading','C14-unread-resource'])('independently replays the Nemotron %s answer instead of trusting its model reviewer',scenario=>{
  const row=evidence.rows.find((r:any)=>r.provider==='nemotron'&&r.scenario===scenario);
  const review=curatedReviewSchema.parse(row.curated_review);
  const fixture=hierarchyAnswerCaseSchema.parse({...row.oracle_fixture,samples:[{id:`groq-comparison-${scenario}`,origin:'historical_public_reply',
   source_receipt:null,model:row.model,recorded_at:row.created_at,historical_configuration_fingerprint:row.source_fingerprint,
   reply:row.public_reply,expected_verdict:scenario==='C01-inclusive'?'pass':'fail',review}]});
  const verdicts=evaluateHierarchyReply(fixture,{reply:row.public_reply,actions:[]},{writes:0,review});
  expect(answerAccepted(verdicts)).toBe(scenario==='C01-inclusive');
  if(scenario==='C05-required-reading'){expect(row.automated_accepted).toBe(true);expect(verdicts.grounding.status).toBe('fail');}
  if(scenario==='C14-unread-resource'){expect(row.automated_accepted).toBe(true);expect(verdicts.scope.status).toBe('fail');}
  if(scenario==='C02-additive'){expect(verdicts.facts.status).toBe('pass');expect(verdicts.usefulness.status).toBe('fail');}
 });
 it('keeps an accepted bad answer from the earlier adapter-development cohort outside primary delivery counts',()=>{
  const failure=evidence.additional_failure;expect(hash(failure.public_reply)).toBe(failure.public_reply_sha256);
  expect(failure.automated_accepted).toBe(true);expect(failure.manual_review.correctness).toBe('fail');
  expect(failure.cohort_id).not.toBe(evidence.primary_cohort);
 });
 it('preserves the unknown-own-work ownership failure for subsequent evidence-boundary repair',()=>{
  const row=evidence.rows.find((r:any)=>r.provider==='nemotron'&&r.scenario==='C08-unknown-included');
  const root=row.oracle_fixture.expected.tasks.find((t:any)=>t.id.endsWith('0001'));
  const children=row.oracle_fixture.tasks.filter((t:any)=>t.parent_task_id===root.id);
  expect(root.own_minutes).toBeNull();expect(children.filter((t:any)=>t.estimated_minutes===null)).toHaveLength(1);
  expect(row.public_reply).toContain('2 unestimated subtasks');expect(row.manual_review.correctness).toBe('fail');
 });
 it.each(['groq:C02-additive','nemotron:C02-additive','groq:C14-unread-resource','nemotron:C14-unread-resource'])('rejects the delivered but incorrect compact-evidence answer %s',identity=>{
  const row=evidence.compact_experiment.rows.find((r:any)=>`${r.provider}:${r.scenario}`===identity);
  expect(hash(row.public_reply)).toBe(row.public_reply_sha256);expect(row.delivered).toBe(true);
  const review=curatedReviewSchema.parse(row.curated_review);
  const fixture=hierarchyAnswerCaseSchema.parse({...row.oracle_fixture,samples:[{id:`compact-${identity}`,origin:'historical_public_reply',source_receipt:null,
   model:row.model,recorded_at:null,historical_configuration_fingerprint:row.source_fingerprint,reply:row.public_reply,expected_verdict:'fail',review}]});
  const verdicts=evaluateHierarchyReply(fixture,{reply:row.public_reply,actions:[]},{writes:0,review});
  expect(answerAccepted(verdicts)).toBe(false);
  expect(verdicts[row.scenario==='C14-unread-resource'?'scope':'grounding'].status).toBe('fail');
 });
});
