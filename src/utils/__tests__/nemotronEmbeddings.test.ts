import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {nemotronEmbeddings} from '../../../server/services/nemotronEmbeddings';
import {NEMOTRON_EMBED_MODEL as model} from '../../../shared/embeddingTrial';
const vector = (index = 0) => Array.from({length:2048}, (_, i) => i === index ? 1 : 0);
const response = (data: unknown, extra = {}) => new Response(JSON.stringify({model,data,...extra}));
beforeEach(() => {vi.stubEnv('NVIDIA_API_KEY','private-chat-key'); vi.stubEnv('NVIDIA_EMBED_API_KEY','private-embed-key');});
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});
describe('isolated NVIDIA embedding trial adapter', () => {
  it('uses the dedicated server credential and hosted role, preserving input order', async () => {
    const fetcher = vi.fn().mockImplementation(() => response([{index:1,embedding:vector(1)},{index:0,embedding:vector()}]));
    vi.stubGlobal('fetch',fetcher);
    expect(await nemotronEmbeddings(['first','second'],'passage')).toEqual([vector(),vector(1)]);
    const [url,init]=fetcher.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/embeddings');
    expect(init).toMatchObject({redirect:'error',headers:{Authorization:'Bearer private-embed-key'}});
    expect(JSON.parse(init.body)).toEqual({model,input:['first','second'],input_type:'passage',encoding_format:'float',truncate:'NONE'});
    await nemotronEmbeddings(['first','second'],'query');
    expect(JSON.parse(fetcher.mock.calls[1][1].body).input_type).toBe('query');
  });
  it('can reuse the existing NVIDIA connection without changing it', async () => {
    vi.stubEnv('NVIDIA_EMBED_API_KEY',''); const fetcher=vi.fn().mockResolvedValue(response([{index:0,embedding:vector()}]));vi.stubGlobal('fetch',fetcher);
    await nemotronEmbeddings(['test'],'query'); expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer private-chat-key');
  });
  it.each([[], [''], ['x'.repeat(3001)], Array(9).fill('x')])('rejects bounded-input violations before inference (%j)', async texts => {
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(nemotronEmbeddings(texts,'query')).rejects.toMatchObject({status:400});expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks UTF-8 bytes and fails before network when configuration or time is missing', async () => {
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(nemotronEmbeddings(['م'.repeat(1501)],'query')).rejects.toMatchObject({status:400});
    vi.stubEnv('NVIDIA_API_KEY','');vi.stubEnv('NVIDIA_EMBED_API_KEY','');
    await expect(nemotronEmbeddings(['test'],'query')).rejects.toMatchObject({status:503});
    vi.stubEnv('NVIDIA_EMBED_API_KEY','test');
    await expect(nemotronEmbeddings(['test'],'query',{deadlineMs:Date.now()-1})).rejects.toMatchObject({status:504});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [{index:0,embedding:Array(3072).fill(1)}], [{index:0,embedding:Array(2048).fill(0)}],
    [{index:0,embedding:[null,...vector().slice(1)]}], [{index:0,embedding:Array(2048).fill(1e308)}],
    [{index:1,embedding:vector()}], [{embedding:vector()}], [],
  ])('rejects incompatible or numerically unsafe vectors (%#)', async data => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(data)));
    await expect(nemotronEmbeddings(['test'],'query')).rejects.toMatchObject({status:502});
  });
  it('rejects duplicate indices and a changed model identity', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response([{index:0,embedding:vector()},{index:0,embedding:vector()}])));
    await expect(nemotronEmbeddings(['a','b'],'query')).rejects.toMatchObject({status:502});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response([{index:0,embedding:vector()}],{model:'gemini-embedding-2'})));
    await expect(nemotronEmbeddings(['a'],'query')).rejects.toMatchObject({status:502});
  });
  it.each([202,401,429,503])('does not expose provider bodies or claim delivery for HTTP %i', async status => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('private-body private-embed-key',{status})));
    await expect(nemotronEmbeddings(['test'],'query')).rejects.toMatchObject({status:status===202?503:status,message:expect.not.stringContaining('private')});
  });
  it('masks malformed JSON and transport exception details', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('private-body')));
    await expect(nemotronEmbeddings(['test'],'query')).rejects.toMatchObject({status:502,message:'The search model trial could not finish.'});
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('private-embed-key')));
    await expect(nemotronEmbeddings(['test'],'query')).rejects.toMatchObject({status:502,message:'The search model trial could not finish.'});
  });
  it('bounds streamed bytes before parsing and closes the reader', async () => {
    const cancel=vi.fn();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(512*1024+1));},cancel}))));
    await expect(nemotronEmbeddings(['test'],'query')).rejects.toMatchObject({status:502});expect(cancel).toHaveBeenCalled();
  });
  it('cancels stalled fetches and stalled bodies within the shared deadline', async () => {
    vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>new Promise(()=>{})));
    await expect(nemotronEmbeddings(['test'],'query',{deadlineMs:Date.now()+20})).rejects.toMatchObject({status:504});
    const cancel=vi.fn();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(new ReadableStream({cancel}))));
    await expect(nemotronEmbeddings(['test'],'query',{deadlineMs:Date.now()+20})).rejects.toMatchObject({status:504});expect(cancel).toHaveBeenCalled();
  });
  it('honors caller cancellation without making a new request', async () => {
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const controller=new AbortController();controller.abort();
    await expect(nemotronEmbeddings(['test'],'query',{signal:controller.signal})).rejects.toMatchObject({status:504});expect(fetcher).not.toHaveBeenCalled();
  });
});
