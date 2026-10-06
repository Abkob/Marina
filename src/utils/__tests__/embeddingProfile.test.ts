import {describe,expect,it} from 'vitest';
import {embeddingProfile} from '../../../server/config/embeddingProfile';
describe('isolated embedding profiles',()=>{
 it('keeps model, provider, dimension and storage identifiers inseparable',()=>{
  expect(embeddingProfile('gemini-embedding-2')).toMatchObject({provider:'gemini',dimension:3072,table:'embeddings',column:'embedding_3072'});
  expect(embeddingProfile('nvidia/nemotron-3-embed-1b')).toMatchObject({provider:'nvidia',dimension:2048,table:'nemotron_embeddings',column:'embedding_2048',generation:'nemotron-byte-windows-mean-v1'});
 });
 it.each(['nvidia/nemotron-3-super-120b-a12b','gemini-embedding-001',"embeddings;DROP TABLE tasks",''])('rejects incompatible or arbitrary identifiers: %s',model=>{
  expect(()=>embeddingProfile(model)).toThrow('Unsupported embedding profile');
 });
});
