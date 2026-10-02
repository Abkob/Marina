// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
afterEach(()=>{useAppStore.getState().clearCopilotConversation();});
describe('chat resource context persistence',()=>{
  it('persists the chosen task boundary and descendant opt-in across navigation',()=>{
    const selection={id:'task',title:'Homework',kind:'task' as const,include_subtasks:false};
    useAppStore.getState().setCopilotResourceSelection(selection);
    useAppStore.getState().setCurrentTab('Resources');
    expect(useAppStore.getState().copilotResourceSelection).toEqual(selection);
    const persisted=JSON.parse(localStorage.getItem(useAppStore.persist.getOptions().name)!);
    expect(persisted.state.copilotResourceSelection).toEqual(selection);
  });
  it('clears the source boundary with a new conversation',()=>{
    useAppStore.getState().setCopilotResourceSelection({id:'goal',title:'Algebra',kind:'goal'});
    useAppStore.getState().clearCopilotConversation();
    expect(useAppStore.getState().copilotResourceSelection).toBeNull();
  });
});
