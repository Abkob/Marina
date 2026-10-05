import { describe, expect, it } from 'vitest';
import { createCopilotTools } from '../../../server/services/copilotTools';
import { conversationCapabilities } from '../../../server/services/copilotCapabilities';
const noop=async()=>({});
const tools=()=>createCopilotTools({workspace:noop,previewSchedule:noop,previewRoutine:noop,scheduleDay:noop,overdueTasks:noop});
describe('deferred domain instructions',()=>{
  it('advertises calendar creation before any domain load, with standalone and overlap support',()=>{
    const caps=conversationCapabilities(tools());
    const prompt=caps.prompt({});
    const schemas=JSON.parse(prompt.split('Read-only tools: ')[1].split('\nProposal parameter schemas: ')[0]);
    expect(schemas.preview_repeating_blocks.description).toContain('NEW named calendar blocks');
    expect(schemas.preview_repeating_blocks.description).toContain('No existing task is required');
    expect(schemas.preview_repeating_blocks.description).toContain('simultaneous/overlapping');
    expect(prompt).toContain('load the relevant domain before claiming you cannot fulfill a request');
    expect(prompt).toContain('never set needs_clarification or ask for additional permission solely because requested blocks overlap');
    caps.activateForTool('preview_repeating_blocks');
    expect(caps.prompt({})).toContain('preserving each weekday restriction');
    expect(caps.prompt({})).toContain('"move_schedule_items":');
  });
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
