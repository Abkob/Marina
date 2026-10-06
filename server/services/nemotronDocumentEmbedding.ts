import {nemotronEmbeddings, EmbeddingTrialError} from './nemotronEmbeddings.js';
const MAX_BYTES = 3000;
/** Bound hosted inputs without silently truncating source text or breaking Unicode. */
export function embeddingWindows(text: string): string[] {
  if (!text.trim() || Buffer.byteLength(text,'utf8') > MAX_BYTES * 16) throw new EmbeddingTrialError('Document exceeds the bounded search-index input limit.',400);
  const windows: string[] = []; let current = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char,'utf8');
    if (bytes + size > MAX_BYTES) { windows.push(current); current = ''; bytes = 0; }
    current += char; bytes += size;
  }
  if (current) windows.push(current);
  return windows;
}
export async function embedNemotronDocument(text: string): Promise<number[]> {
  const windows = embeddingWindows(text), vectors: number[][] = [], deadlineMs = Date.now() + 45_000;
  for (let i=0; i<windows.length; i+=8) vectors.push(...await nemotronEmbeddings(windows.slice(i,i+8),'passage',{deadlineMs}));
  if (vectors.length === 1) return vectors[0];
  // Preserve every window in a byte-weighted centroid. This strategy has its own index generation.
  const total = windows.reduce((sum,window)=>sum+Buffer.byteLength(window,'utf8'),0), result=Array(2048).fill(0) as number[];
  vectors.forEach((vector,i)=>{
    const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));
    const weight=Buffer.byteLength(windows[i],'utf8')/total;
    vector.forEach((value,j)=>result[j]+=value/norm*weight);
  });
  const norm=Math.sqrt(result.reduce((sum,value)=>sum+value*value,0));
  if (!Number.isFinite(norm)||norm<1e-12) throw new EmbeddingTrialError('Document windows returned an unusable search vector.');
  return result.map(value=>value/norm);
}
