import {EventEmitter} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../../server/services/embeddingTrial',()=>({runEmbeddingTrial:vi.fn()}));
import {runEmbeddingTrial} from '../../../server/services/embeddingTrial';
import {EmbeddingTrialError} from '../../../server/services/nemotronEmbeddings';
import {embeddingTrialsRouter} from '../../../server/routes/embedding-trials';
import {NEMOTRON_EMBED_MODEL as model} from '../../../shared/embeddingTrial';
const run=vi.mocked(runEmbeddingTrial);
afterEach(()=>run.mockReset());
describe('bounded sample trial route',()=>{
 it('accepts only the supported model, excludes user documents, and caps inference attempts',async()=>{
  run.mockResolvedValue({model,dimension:2048,correct_top_matches:3,total_queries:3,elapsed_ms:100,sample_only:true,index_changed:false});
  const app=express();app.use(express.json());app.use('/trial-models',embeddingTrialsRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/trial-models/trial`;
  const post=(body:unknown)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
   expect((await post({model:'gemini-embedding-2'})).status).toBe(400);
   expect((await post({model,text:'private document'})).status).toBe(400);expect(run).not.toHaveBeenCalled();
   const valid=await post({model});expect(valid.status).toBe(200);expect(await valid.json()).toMatchObject({correct_top_matches:3,index_changed:false});
   const capped=await post({model});expect(capped.status).toBe(429);expect(Number(capped.headers.get('Retry-After'))).toBeGreaterThan(0);expect(run).toHaveBeenCalledTimes(1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 const handler=embeddingTrialsRouter.stack.find(layer=>layer.route?.path==='/trial')!.route.stack.at(-1)!.handle;
 function invoke(){
  const res=Object.assign(new EventEmitter(),{writableEnded:false,status:vi.fn(),json:vi.fn()});res.status.mockReturnValue(res);res.json.mockReturnValue(res);
  const pending=handler({body:{model}} as any,res as any,vi.fn());return {res,pending};
 }
 it('exposes only safe errors',async()=>{
  run.mockRejectedValueOnce(new Error('credential private-body'));let call=invoke();await call.pending;
  expect(call.res.status).toHaveBeenCalledWith(502);expect(call.res.json).toHaveBeenCalledWith({error:'The search-model trial could not finish.'});
  run.mockRejectedValueOnce(new EmbeddingTrialError('The NVIDIA search model is unavailable (HTTP 429).',429));call=invoke();await call.pending;
  expect(call.res.status).toHaveBeenCalledWith(429);
 });
 it('aborts provider work and excludes late success on client disconnect',async()=>{
  let resolve:(result:any)=>void;run.mockImplementation(()=>new Promise(r=>resolve=r));const {res,pending}=invoke();
  res.emit('close');expect(run.mock.calls[0][0]?.aborted).toBe(true);resolve!({model});await pending;expect(res.json).not.toHaveBeenCalled();expect(res.listenerCount('close')).toBe(0);
 });
});
