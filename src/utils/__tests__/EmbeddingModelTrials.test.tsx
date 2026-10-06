// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EmbeddingModelTrials} from '../../components/EmbeddingModelTrials';
import {NEMOTRON_EMBED_MODEL as model} from '../../../shared/embeddingTrial';
const options=[{model,label:'Nemotron 3 Embed 1B',dimension:2048,configured:true,requires_reindex:true as const}];
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));afterEach(()=>vi.unstubAllGlobals());
describe('embedding model trial controls',()=>{
 it('runs only fixed sample search and displays partial correctness honestly',async()=>{
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({model,dimension:2048,correct_top_matches:2,total_queries:3,elapsed_ms:1234,sample_only:true,index_changed:false})));
  render(<EmbeddingModelTrials options={options} disabled={false}/>);
  fireEvent.click(screen.getByText('Try a search model'));fireEvent.click(screen.getByRole('button',{name:'Try sample search'}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('2/3 · 1.23s'));
  expect(fetch).toHaveBeenCalledTimes(1);const [url,init]=vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('/api/ai/embedding-models/trial');expect(JSON.parse(init!.body as string)).toEqual({model});
  expect(screen.getByText(/library search index stays unchanged/)).toBeInTheDocument();
 });
 it('prevents duplicate trials and aborts the pending request when the panel closes',async()=>{
  let resolve:(value:Response)=>void;vi.mocked(fetch).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const {unmount}=render(<EmbeddingModelTrials options={options} disabled={false}/>);
  fireEvent.click(screen.getByText('Try a search model'));const button=screen.getByRole('button',{name:'Try sample search'});fireEvent.click(button);fireEvent.click(button);
  expect(fetch).toHaveBeenCalledTimes(1);expect(screen.getByRole('button')).toBeDisabled();
  const signal=vi.mocked(fetch).mock.calls[0][1]!.signal;unmount();expect(signal?.aborted).toBe(true);
  await act(async()=>resolve!(new Response('{}')));
 });
 it('makes failures visible without reflecting server/provider bodies',async()=>{
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({error:'private secret'}),{status:503}));
  render(<EmbeddingModelTrials options={options} disabled={false}/>);fireEvent.click(screen.getByText('Try a search model'));fireEvent.click(screen.getByRole('button'));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('could not finish'));expect(screen.queryByText(/private secret/)).toBeNull();
 });
 it.each([true,false])('disables execution for busy chat or missing credentials (%s)',disabled=>{
  render(<EmbeddingModelTrials options={options.map(row=>({...row,configured:disabled}))} disabled={disabled}/>);
  fireEvent.click(screen.getByText('Try a search model'));expect(screen.getByRole('button')).toBeDisabled();fireEvent.click(screen.getByRole('button'));expect(fetch).not.toHaveBeenCalled();
 });
});
