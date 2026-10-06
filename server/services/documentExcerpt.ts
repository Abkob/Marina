/** Exact bounded source slice. Selection is lexical, never a generated quotation. */
const STOP=new Set('what which when where why how this that with from into have does used uses before after during until while the and for are was were can its'.split(' '));
export function documentExcerpt(content:string,question:string,limit=2400){
 const size=Math.max(2,Math.trunc(limit));let start=0;
 if(content.length>size){
  const words:string[]=question.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
  const terms=[...new Set(words.filter(term=>term.length>=3&&!STOP.has(term)))];
  let best=0;
  for(let offset=0;offset<content.length;offset+=Math.floor(size/2)){
   const text=content.slice(offset,offset+size).toLowerCase();
   const score=terms.reduce((sum,term)=>sum+(text.includes(term)?1:0),0);
   if(score>best){best=score;start=offset;}
  }
 }
 // Preserve complete UTF-16 codepoints at both source boundaries.
 if(start>0&&/[\uDC00-\uDFFF]/.test(content[start]))start--;
 let end=Math.min(content.length,start+size);
 if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1]))end--;
 return {content:content.slice(start,end),passage_start_char:start,passage_end_char:end,source_content_chars:content.length,passage_coverage:content.length<=size?'complete' as const:'excerpt' as const};
}
