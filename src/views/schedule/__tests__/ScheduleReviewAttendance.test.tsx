// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor,within} from '@testing-library/react';
import {ScheduleReview} from '../ScheduleReview';
const state=vi.hoisted(()=>({day:null as any,timer:null as any,post:vi.fn(),stop:vi.fn(),invalidate:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>({data:state.day,isPending:false,isError:false}),useQueryClient:()=>({invalidateQueries:state.invalidate,setQueryData:vi.fn()})}));
vi.mock('../../../hooks/useCloudWorkTimer',()=>({CLOUD_TIMER_KEY:['work-timer'],useCloudWorkTimer:()=>({timer:state.timer,nowMs:Date.parse('2026-10-19T09:30:00Z'),ready:true,busy:false,stop:state.stop})}));
vi.mock('../../../utils/apiFetch',()=>({apiPost:(...args:unknown[])=>state.post(...args),apiFetch:vi.fn()}));
vi.mock('../../../components/MobileSheet',()=>({MobileSheet:({children}:any)=><div>{children}</div>}));
vi.mock('../ScheduleReminders',()=>({ScheduleReminders:()=>null}));
vi.mock('../ScheduleShortcuts',()=>({ScheduleShortcuts:()=>null}));
vi.mock('../ActualTimeGesture',()=>({ActualTimeGesture:({label,onChoose}:any)=><button onClick={()=>onChoose('2026-10-19T09:30:00.000Z')}>{label}</button>}));
const event=(id='e',start='09:00',end='10:00')=>({id,source:'event',sourceId:id,title:id==='e'?'Current event':'Next event',start:`2026-10-19T${start}:00Z`,end:`2026-10-19T${end}:00Z`,taskIds:['a'],goalId:null,routineId:null});
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-19T09:30:00Z'));window.history.replaceState(null,'','/');
 state.post.mockReset().mockResolvedValue({});state.stop.mockReset().mockResolvedValue({});state.invalidate.mockReset().mockResolvedValue(undefined);
 state.day={date:'2026-10-19',today:'2026-10-19',timezone:'UTC',proposed:null,current:[event()],outcomes:[],sessions:[],pendingTimers:[]};
 state.timer={sessionId:'focus-a',taskId:'a',title:'Focused task',startedAt:'2026-10-19T09:00:00Z'};
});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('starts independent attendance without stopping or parking the task timer',async()=>{
 render(<ScheduleReview date="2026-10-19"/>);fireEvent.click(screen.getByRole('button',{name:'Started'}));
 await waitFor(()=>expect(state.post).toHaveBeenCalledWith('/api/schedule-review/2026-10-19/start',expect.objectContaining({attendance_only:true,expected_running_id:'focus-a'})));
 expect(state.stop).not.toHaveBeenCalled();
});
it('ends the attendance ID rather than the concurrently running task ID',async()=>{
 state.day.pendingTimers=[{id:'attendance-e',schedule_occurrence_id:'e',started_at:'2026-10-19T09:00:00Z'}];
 render(<ScheduleReview date="2026-10-19"/>);fireEvent.click(screen.getByRole('button',{name:'Ended'}));
 await waitFor(()=>expect(state.stop).toHaveBeenCalledExactlyOnceWith('attendance-e',{ended_at:'2026-10-19T09:30:00.000Z'}));
});
it('follows the next current event while an older event and timer remain unresolved',()=>{
 state.day.current=[event('e','08:00','09:00'),event('next')];
 state.day.pendingTimers=[{id:'old-attendance',schedule_occurrence_id:'e',started_at:'2026-10-19T08:00:00Z'}];
 state.timer={sessionId:'old-attendance',scheduleOccurrenceId:'e',title:'Current event',startedAt:'2026-10-19T08:00:00Z'};
 render(<ScheduleReview date="2026-10-19"/>);const card=screen.getByLabelText('Quick event check-in');
 expect(within(card).getByText('Next event')).toBeInTheDocument();expect(within(card).getByRole('button',{name:'Started'})).toBeInTheDocument();expect(within(card).queryByRole('button',{name:'Ended'})).not.toBeInTheDocument();
});
it('requires choosing overlapping events and never surfaces an unapplied proposal as current attendance',()=>{
 state.day.current=[event(),event('next')];const first=render(<ScheduleReview date="2026-10-19"/>);
 expect(screen.queryByRole('button',{name:'Started'})).not.toBeInTheDocument();expect(state.post).not.toHaveBeenCalled();first.unmount();
 state.day.current=[];state.day.proposed={occurrences:[event()],saved_at:'2026-10-18T20:00:00Z',frozen:true};
 render(<ScheduleReview date="2026-10-19"/>);expect(screen.queryByLabelText('Quick event check-in')).not.toBeInTheDocument();
});
