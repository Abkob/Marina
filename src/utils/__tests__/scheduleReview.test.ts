import { describe, expect, it } from 'vitest';
import { checkInDirection, matchingSessions, uncoveredRanges, type ScheduleOccurrence } from '../../../shared/scheduleReview';
import { accountedTime } from '../timeHeatmap';
const occurrence:ScheduleOccurrence={id:'event:one:2026-10-18',source:'event',sourceId:'one',title:'Study',start:'2026-10-18T06:00:00Z',end:'2026-10-18T07:00:00Z',taskIds:[],goalId:null,routineId:null};
describe('schedule interval reconciliation',()=>{
 it('subtracts unions without inventing work in gaps or counting duplicates',()=>{expect(uncoveredRanges({start:0,end:120},[{start:20,end:40},{start:30,end:60},{start:80,end:90},{start:20,end:40}])).toEqual([{start:0,end:20},{start:60,end:80},{start:90,end:120}]);});
 it('matches explicitly linked late attendance outside planned times',()=>{expect(matchingSessions(occurrence,[{id:'timer',started_at:'2026-10-18T10:00:00Z',ended_at:'2026-10-18T10:20:00Z',minutes:20,source:'timer',task_id:null,routine_id:null,schedule_occurrence_id:occurrence.id}])).toHaveLength(1);});
 it('requires a deliberate directional release, leaving a neutral cancel zone',()=>{expect([checkInDirection(20,10),checkInDirection(60,5),checkInDirection(-60,5),checkInDirection(1,-60),checkInDirection(0,80)]).toEqual([null,'done','skip','times',null]);});
 it('caps overlapping work and duplicate session IDs at one person minute',()=>{
  const a={id:'a',started_at:'2026-10-18T06:00:00Z',ended_at:'2026-10-18T07:00:00Z',minutes:60};
  const b={...a,id:'b',started_at:'2026-10-18T06:30:00Z',ended_at:'2026-10-18T07:30:00Z'};
  const days=accountedTime({work:[a,a,b],calendar:[],tasks:{}},2026,'UTC',Date.parse('2026-10-18T08:00:00Z'));
  expect(days.get('2026-10-18')?.minutes).toBe(90);
 });
 it('does not regain corrected work from calendar fallback and excludes future time',()=>{
  const start=Date.parse('2026-10-18T06:00:00Z'),end=start+3600000;
  const days=accountedTime({work:[{id:'a',started_at:new Date(start).toISOString(),ended_at:new Date(end).toISOString(),minutes:30}],calendar:[{id:'event',title:'Study',start,end,allocations:[]}],tasks:{}},2026,'UTC',end);
  expect(days.get('2026-10-18')?.minutes).toBe(30);
 });
});
