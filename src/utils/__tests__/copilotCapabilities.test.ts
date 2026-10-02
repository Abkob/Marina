import { describe, expect, it } from 'vitest';
import { createCopilotTools } from '../../../server/services/copilotTools';
import { conversationCapabilities } from '../../../server/services/copilotCapabilities';
const noop=async()=>({});
const tools=()=>createCopilotTools({workspace:noop,previewSchedule:noop,previewRoutine:noop,scheduleDay:noop,overdueTasks:noop});
describe('deferred domain instructions',()=>{
  it('loads document rules automatically after discovery, preserving approximate title and citation guidance',()=>{
    const caps=conversationCapabilities(tools());
    const initial=caps.prompt({});
    expect(initial).not.toContain('Document discovery and page questions:');
    caps.activateForTool('find_resources');
    const prompt=caps.prompt({});
    expect(prompt).toContain('Document discovery and page questions:');
    expect(prompt).toContain('Never conclude that a whole document lacks a topic');
    expect(prompt).toContain('inspect_document_page');
    expect(prompt).not.toContain('"check_in_routine":');
  });
  it('loads only requested domain proposal schemas and isolates capabilities between turns',async()=>{
    const caps=conversationCapabilities(tools());
    await caps.tools.load_capabilities.execute({names:['routines']});
    expect(caps.prompt({})).toContain('"check_in_routine":');
    expect(caps.prompt({})).not.toContain('"move_schedule_items":');
    expect(conversationCapabilities(tools()).prompt({})).not.toContain('"check_in_routine":');
  });
});
