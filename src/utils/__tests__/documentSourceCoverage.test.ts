import {describe,expect,it} from 'vitest';
import {selectSourceCoverage} from '../../../server/services/documentRag';
const ranked=[{resource_id:'best',chunk_id:'b1'},{resource_id:'best',chunk_id:'b2'},{resource_id:'second',chunk_id:'s1'},{resource_id:'third',chunk_id:'t1'}];
describe('source coverage preserves relevance under a bounded evidence limit',()=>{
 it('does not let the first selected file replace a better-ranked passage',()=>{
  expect(selectSourceCoverage(ranked,['third','second','best'],1)).toEqual([ranked[0]]);
 });
 it('reserves a passage for each source before filling extra passages',()=>{
  expect(selectSourceCoverage(ranked,['third','second','best'],4)).toEqual([ranked[0],ranked[2],ranked[3],ranked[1]]);
 });
 it('ignores missing and duplicate requested IDs without inventing evidence',()=>{
  expect(selectSourceCoverage(ranked,['absent','best','best'],2)).toEqual([ranked[0],ranked[1]]);
 });
 it('retains the unscoped ranking and returns no evidence for a zero limit',()=>{
  expect(selectSourceCoverage(ranked,[],2)).toEqual(ranked.slice(0,2));
  expect(selectSourceCoverage(ranked,['best'],0)).toEqual([]);
 });
});
