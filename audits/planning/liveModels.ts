import fs from 'node:fs/promises';
import { z } from 'zod';
if(process.env.RUN_LIVE_PLANNING_MODELS!=='1')throw new Error('Set RUN_LIVE_PLANNING_MODELS=1 and supply NVIDIA keys to run real provider calls.');
await fs.mkdir('tmp/planning-baseline',{recursive:true});
const {runCopilotConversation}=await import('../../server/services/copilotConversation.js');
const {buildWorkHierarchy}=await import('../../shared/workHierarchy.js');
const report:any[]=[];
for(const model of (process.argv.slice(2).length ? process.argv.slice(2) : ['nvidia/nemotron-3.5-lightning-30b-a3b'])) {
 for(const scenario of ['greeting','inclusive','shortfall']) {
  const tasks=scenario==='inclusive' ? [
    {id:'synthetic-parent',title:'Report',estimated_minutes:120},
    {id:'synthetic-a',title:'Read brief',parent_task_id:'synthetic-parent',time_rollup_mode:'inclusive',estimated_minutes:60,completed:true},
    {id:'synthetic-b',title:'Draft report',parent_task_id:'synthetic-parent',time_rollup_mode:'inclusive',estimated_minutes:60},
  ] : [
    {id:'synthetic-parent',title:'Report',estimated_minutes:30},
    {id:'synthetic-a',title:'Background reading',parent_task_id:'synthetic-parent',time_rollup_mode:'additive',estimated_minutes:60},
    {id:'synthetic-b',title:'Draft report',parent_task_id:'synthetic-parent',time_rollup_mode:'additive',estimated_minutes:60},
  ];
  const hierarchy=buildWorkHierarchy(tasks);
  const facts=tasks.map(task=>({...task,work_accounting:hierarchy.summaries.get(task.id)!.own,
    hierarchy:{remaining_minutes:hierarchy.summaries.get(task.id)!.remaining_minutes,known_remaining_minutes:hierarchy.summaries.get(task.id)!.known_remaining_minutes,unknown_count:0}}));
  const tools={
    find_tasks:{description:'Find the user’s current tasks.',parameters:z.object({search:z.string().optional()}).passthrough(),execute:async()=>({data:{tasks:tasks.map(({id,title,parent_task_id})=>({id,title,parent_task_id})),coverage:{has_more:false}}})},
    task_details:{description:'Read current task work and subtree totals.',parameters:z.object({task_ids:z.array(z.string())}).strict(),execute:async()=>({data:{tasks:facts,children_has_more:false}})},
    workspace_context:{description:'Read the current time budget and tasks.',parameters:z.object({}).passthrough(),execute:async()=>({data:{available_minutes:90,tasks:facts,coverage:'complete for these three synthetic tasks',resources:[{title:'Assignment brief',role:'required',contents_not_read:true},{title:'Background reading',role:'optional',contents_not_read:true}]}})},
  };
  const prompt=scenario==='greeting'?'hi':scenario==='inclusive'?'How much work remains on Report and its subtasks? Check my current task details.':'Help me decide how to finish Report. I have only 90 minutes before the deadline. Check my task context, discuss distinct options and their tradeoffs, and leave the choice with me. Do not apply changes.';
  const row:any={model,scenario,started_at:new Date().toISOString(),traces:[],tools:[]};const started=Date.now();
  try{const result=await runCopilotConversation({model,turns:[{role:'user',content:prompt}],clock:{today:'2026-10-03',time:'18:30',timezone:'UTC'},tools,
    maxToolRounds:3,onTrace:trace=>row.traces.push(trace),onTool:(name,status)=>{row.tools.push({name,status});}});
    row.transport_and_protocol_success=true;row.semantic_review='required';row.result=result;
  }catch(error:any){row.transport_and_protocol_success=false;row.semantic_review='unavailable';row.error=String(error.message).replace(/nvapi-[\w-]+/g,'[redacted]');row.status=error.status;}
  row.elapsed_ms=Date.now()-started;report.push(row);await fs.writeFile('tmp/planning-baseline/live-model-planning.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({model,scenario,transport_and_protocol_success:row.transport_and_protocol_success,elapsed_ms:row.elapsed_ms,status:row.status,error:row.error,tools:row.tools}));
 }
}
