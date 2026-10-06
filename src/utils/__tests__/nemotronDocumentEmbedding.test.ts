import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../../server/services/nemotronEmbeddings',async()=>({...await vi.importActual<any>('../../../server/services/nemotronEmbeddings'),nemotronEmbeddings:vi.fn()}));
import {nemotronEmbeddings} from '../../../server/services/nemotronEmbeddings';
import {embeddingWindows,embedNemotronDocument} from '../../../server/services/nemotronDocumentEmbedding';
const embed=vi.mocked(nemotronEmbeddings),v=(index:number)=>Array.from({length:2048},(_,i)=>i===index?1:0);
beforeEach(()=>{embed.mockReset();});afterEach(()=>vi.unstubAllEnvs());
describe('bounded document embedding windows',()=>{
 it.each(['abc'.repeat(2500),'مرحبا'.repeat(1200),'😀'.repeat(1000)])('preserves every byte and Unicode character across hosted-safe windows',text=>{
  const windows=embeddingWindows(text);expect(windows.join('')).toBe(text);
  for(const window of windows){expect(Buffer.byteLength(window,'utf8')).toBeLessThanOrEqual(3000);expect(window).not.toContain('\uFFFD');}
 });
 it('leaves short passage vectors intact',async()=>{
  embed.mockResolvedValueOnce([v(0)]);expect(await embedNemotronDocument('short source')).toEqual(v(0));
  expect(embed.mock.calls[0].slice(0,2)).toEqual([['short source'],'passage']);
 });
 it('weights all windows by byte coverage and normalizes the centroid',async()=>{
  embed.mockResolvedValueOnce([v(0),v(1)]);const result=await embedNemotronDocument('x'.repeat(4000));
  expect(result[0]/result[1]).toBeCloseTo(3);expect(result.reduce((sum,value)=>sum+value*value,0)).toBeCloseTo(1);
 });
 it('uses bounded batches under one shared deadline',async()=>{
  embed.mockImplementation(async texts=>texts.map(()=>v(0)));await embedNemotronDocument('x'.repeat(40000));
  expect(embed.mock.calls.map(row=>row[0].length)).toEqual([8,6]);expect(embed.mock.calls[0][2]).toEqual(embed.mock.calls[1][2]);
 });
 it('rejects oversized/empty input and cancellation-centroids before claiming success',async()=>{
  for(const text of ['','x'.repeat(48001)])await expect(embedNemotronDocument(text)).rejects.toMatchObject({status:400});
  expect(embed).not.toHaveBeenCalled();
  embed.mockResolvedValueOnce([v(0),v(0).map(value=>-value)]);
  await expect(embedNemotronDocument('x'.repeat(6000))).rejects.toMatchObject({status:502});
 });
});
