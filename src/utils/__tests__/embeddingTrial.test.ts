import {beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('../../../server/services/nemotronEmbeddings',()=>({nemotronEmbeddings:vi.fn()}));
import {nemotronEmbeddings} from '../../../server/services/nemotronEmbeddings';
import {embeddingTrialSamples,runEmbeddingTrial} from '../../../server/services/embeddingTrial';
const vector=(index:number)=>Array.from({length:2048},(_,i)=>i===index?1:0);
const embed=vi.mocked(nemotronEmbeddings);
beforeEach(()=>embed.mockReset());
describe('sample source matching',()=>{
 it('checks independent expected sources and shares the deadline/cancellation across both roles',async()=>{
  embed.mockResolvedValueOnce(embeddingTrialSamples.passages.map((_,i)=>vector(i))).mockResolvedValueOnce([vector(0),vector(1),vector(2)]);
  const signal=new AbortController().signal;const result=await runEmbeddingTrial(signal);
  expect(result).toMatchObject({correct_top_matches:3,total_queries:3,dimension:2048,sample_only:true,index_changed:false});
  expect(embed.mock.calls.map(c=>c[1])).toEqual(['passage','query']);
  expect(embed.mock.calls[0][2]).toBe(embed.mock.calls[1][2]);expect(embed.mock.calls[0][2]?.signal).toBe(signal);
 });
 it('counts a wrong source and ambiguous tie as failures, regardless of successful inference',async()=>{
  const passages=embeddingTrialSamples.passages.map((_,i)=>vector(i));passages[3]=vector(0);
  embed.mockResolvedValueOnce(passages).mockResolvedValueOnce([vector(0),vector(4),vector(2)]);
  expect(await runEmbeddingTrial()).toMatchObject({correct_top_matches:1,total_queries:3});
 });
 it('never launches query inference after passage failure',async()=>{
  embed.mockRejectedValueOnce(new Error('unavailable'));await expect(runEmbeddingTrial()).rejects.toThrow('unavailable');expect(embed).toHaveBeenCalledTimes(1);
 });
});
