import {describe,it,expect} from 'vitest';
import {documentExcerpt} from '../../../server/services/documentExcerpt';
describe('exact source excerpts',()=>{
 it('preserves short complete passages and their offsets',()=>{expect(documentExcerpt('Rotations preserve distances.','isometry')).toEqual({content:'Rotations preserve distances.',passage_start_char:0,passage_end_char:29,source_content_chars:29,passage_coverage:'complete'});});
 it('retrieves literal evidence beyond the old prefix and reports incomplete coverage',()=>{
  const source='Ordinary maintenance introduction. '.repeat(200)+'The compass marker is SILVER ORCHID.';
  const result=documentExcerpt(source,'Which marker is used when checking the compass?');
  expect(result.content).toContain('SILVER ORCHID');expect(result.passage_coverage).toBe('excerpt');
  expect(result.content).toBe(source.slice(result.passage_start_char,result.passage_end_char));expect(result.content.length).toBeLessThanOrEqual(2400);
 });
 it('does not invent evidence when lexical matching is unavailable',()=>{
  expect(documentExcerpt('General material. '.repeat(300),'أين استمارة التسجيل؟')).toMatchObject({passage_start_char:0,passage_coverage:'excerpt'});
 });
 it('keeps emoji and Arabic codepoints intact at both boundaries',()=>{
  const source='😀'.repeat(1700)+'موعد التسجيل يوم الخميس';const result=documentExcerpt(source,'التسجيل الخميس',100);
  expect(result.content).toContain('الخميس');expect(result.content).toBe(source.slice(result.passage_start_char,result.passage_end_char));
  expect(/[\uD800-\uDFFF]/u.test(result.content)).toBe(false);
 });
});
