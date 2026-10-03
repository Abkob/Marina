// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanPanel } from '../planning/PlanPanel';
import { ScenarioStatus } from '../planning/ScenarioStatus';
import { emptyPlanContent, type PlanningContextResponse } from '../../../shared/planningState';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('../../utils/apiFetch',async original=>({...await original<typeof import('../../utils/apiFetch')>(),apiFetch:mocks.get,apiPost:mocks.post}));
const root={kind:'task' as const,id:'task-a'};
const response=(version=0,outcome='Saved objective'):PlanningContextResponse=>({schema_version:1,scope:{root,from:'2026-10-06',to:'2026-10-08',include_subtasks:false},root:{...root,title:'Synthetic report'},plan:{id:'plan',version,state:'current',content:{...emptyPlanContent(),outcome},origin:'user',forgotten:false,redacted_items:0},evidence:{resources:[],omitted:0},calendar_context:{scope:'workspace',from:'2026-10-06',to:'2026-10-08',busy:[],omitted:0},proposed_write_set:[{kind:'plan',id:'plan'}],snapshot_token:'token',next_cursor:null,evaluations:[]});
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();mocks.get.mockResolvedValue(response());});afterEach(cleanup);
describe('P02 plan editor',()=>{
  it('P02.2-F03 decisions retain Enter while typing and save separate lines',async()=>{
    render(<PlanPanel root={root}/>);await userEvent.click(screen.getByRole('button',{name:'Plan'}));
    await screen.findByRole('textbox',{name:'Plan outcome'});await userEvent.click(screen.getByText('Decisions and open questions'));
    const field=screen.getByRole('textbox',{name:'Plan decisions'});await userEvent.type(field,'First decision{Enter}Second decision');
    expect(field).toHaveValue('First decision\nSecond decision');mocks.post.mockResolvedValue({version:1});
    await userEvent.click(screen.getByRole('button',{name:'Save plan'}));
    expect(mocks.post).toHaveBeenCalledWith('/api/planning/plans/plan/revisions',expect.objectContaining({revision:expect.objectContaining({content:expect.objectContaining({decisions:['First decision','Second decision']})})}));
  });
  it('P02.2-F04 a lost save response preserves the same retry key and draft',async()=>{
    render(<PlanPanel root={root}/>);await userEvent.click(screen.getByRole('button',{name:'Plan'}));
    await userEvent.type(await screen.findByRole('textbox',{name:'Plan outcome'}),' revised');
    mocks.post.mockRejectedValue(new Error('Network unavailable'));
    await userEvent.click(screen.getByRole('button',{name:'Save plan'}));await screen.findByText('Network unavailable');
    const first=mocks.post.mock.calls[0][1];await userEvent.click(screen.getByRole('button',{name:'Save plan'}));
    expect(mocks.post.mock.calls[1][1]).toEqual(first);expect(screen.getByRole('textbox',{name:'Plan outcome'})).toHaveValue('Saved objective revised');
  });
  it('P02.1-F01 navigation does not fetch/create plans until opened; creation is explicit',async()=>{
    mocks.get.mockResolvedValue({...response(),plan:null});render(<PlanPanel root={root}/>);
    expect(mocks.get).not.toHaveBeenCalled();expect(mocks.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'Plan'}));
    await screen.findByRole('button',{name:'Start planning'});expect(mocks.post).not.toHaveBeenCalled();
    mocks.post.mockResolvedValue({id:'plan'});mocks.get.mockResolvedValue(response());
    await userEvent.click(screen.getByRole('button',{name:'Start planning'}));
    await screen.findByRole('textbox',{name:'Plan outcome'});expect(mocks.post).toHaveBeenCalledWith('/api/planning/plans',{root});
  });
  it('P02.2-F01 unsaved manual edits survive remount and remain distinct from saved state',async()=>{
    const view=render(<PlanPanel root={root}/>);await userEvent.click(screen.getByRole('button',{name:'Plan'}));
    const field=await screen.findByRole('textbox',{name:'Plan outcome'});await userEvent.clear(field);await userEvent.type(field,'My local draft');
    await waitFor(()=>expect(localStorage.getItem('marina-plan-draft-v1:task:task-a')).toContain('My local draft'));
    view.unmount();render(<PlanPanel root={root}/>);await userEvent.click(screen.getByRole('button',{name:'Plan, unsaved draft'}));
    expect(await screen.findByRole('textbox',{name:'Plan outcome'})).toHaveValue('My local draft');expect(mocks.post).not.toHaveBeenCalled();
  });
  it('P02.2-F02 a conflict preserves text and requires reviewing the newer revision',async()=>{
    const {ApiError}=await import('../../utils/apiFetch');
    render(<PlanPanel root={root}/>);await userEvent.click(screen.getByRole('button',{name:'Plan'}));
    const field=await screen.findByRole('textbox',{name:'Plan outcome'});await userEvent.type(field,' with my changes');
    mocks.post.mockRejectedValue(new ApiError(409,'A newer revision exists.'));mocks.get.mockResolvedValue(response(1,'Other tab edit'));
    await userEvent.click(screen.getByRole('button',{name:'Save plan'}));
    await screen.findByText(/Your draft from revision 0 is preserved/);
    expect(field).toHaveValue('Saved objective with my changes');expect(screen.getByRole('button',{name:'Save plan'})).toBeDisabled();
    await userEvent.click(screen.getByText('Review the saved version'));expect(screen.getByText('Other tab edit')).toBeVisible();
    await userEvent.click(screen.getByRole('button',{name:'Use my draft as the next revision'}));expect(screen.getByRole('button',{name:'Save plan'})).toBeEnabled();
  });
  it('P01.3-F01 late context from another root never renders under the new root',async()=>{
    let resolve!:(value:unknown)=>void;mocks.get.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const view=render(<PlanPanel root={root}/>);await userEvent.click(screen.getByRole('button',{name:'Plan'}));
    const other={kind:'task' as const,id:'task-b'};view.rerender(<PlanPanel root={other}/>);
    mocks.get.mockResolvedValue({...response(),root:{...other,title:'Other report'}});
    await userEvent.click(screen.getByRole('button',{name:'Plan'}));await screen.findByText('task: Other report');
    resolve(response());await waitFor(()=>expect(screen.queryByText('task: Synthetic report')).not.toBeInTheDocument());
  });
  it('P02.3-F01 derived source text is excluded from local drafts and disappears after revocation',async()=>{
    const value=response();value.plan!.content.work_items=[{reference:{kind:'work_item',id:'item'},title:'Private source passage',task:null,effort:{state:'unknown',minutes:null},evidence:[]}];mocks.get.mockResolvedValue(value);
    render(<PlanPanel root={root}/>);await userEvent.click(screen.getByRole('button',{name:'Plan'}));await screen.findByText('Private source passage');
    await userEvent.type(screen.getByRole('textbox',{name:'Plan outcome'}),' changed');
    expect(localStorage.getItem('marina-plan-draft-v1:task:task-a')).not.toContain('Private source passage');
    mocks.get.mockResolvedValue(response());await userEvent.click(screen.getByRole('button',{name:'Refresh plan'}));
    await waitFor(()=>expect(screen.queryByText('Private source passage')).not.toBeInTheDocument());
  });
  it.each(['partial','conflicted','failed','canceled','superseded'] as const)('P01.2-F01 %s has an explicit outcome instead of generic ready',state=>{
    render(<ScenarioStatus state={state} onRefresh={vi.fn()}/>);expect(screen.getByRole('status')).not.toHaveTextContent('Ready to review');
    if(state!=='canceled')expect(screen.getByRole('button',{name:'Refresh context'})).toBeEnabled();
  });
});
