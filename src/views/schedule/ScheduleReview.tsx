import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, HelpCircle, Undo2, X } from 'lucide-react';
import { MobileSheet } from '../../components/MobileSheet';
import { apiFetch, apiPost } from '../../utils/apiFetch';
import { calendarInstant } from '../../utils/calendarTime';
import { addRoutineDays } from '../../utils/routines';
import { matchingSessions, type CheckInGesture, type ScheduleOccurrence, type ScheduleOutcome, type ScheduleReviewDay } from '../../../shared/scheduleReview';
import './scheduleReview.css';
import { CLOUD_TIMER_KEY, useCloudWorkTimer } from '../../hooks/useCloudWorkTimer';
import { ScheduleReminders } from './ScheduleReminders';
import { ActualTimeGesture } from './ActualTimeGesture';
import { ScheduleShortcuts } from './ScheduleShortcuts';

const wallTime=(instant:string,zone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(instant));
const clockHour=(value:string)=>{const [h,m]=value.split(':').map(Number);return h+m/60;};

export function ScheduleReview({date}:{date:string}) {
  const qc=useQueryClient();
  const cloud=useCloudWorkTimer();
  const [open,setOpen]=useState(()=>new URLSearchParams(window.location.search).get('checkin')==='1');
  const [mode,setMode]=useState<'proposed'|'actual'>('actual');
  const requestedOccurrence=useRef(new URLSearchParams(window.location.search).get('occurrence'));
  const [selected,setSelected]=useState<string|null>(null),[editing,setEditing]=useState(false);
  const [start,setStart]=useState(''),[end,setEnd]=useState(''),[overnight,setOvernight]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [help,setHelp]=useState(false);
  const [dismissedPrompt,setDismissedPrompt]=useState('');
  const [undo,setUndo]=useState<{previous:ScheduleOutcome|null;result:ScheduleOutcome}|null>(null);
  // Retain the same command on network failure, including a committed response
  // lost in transit. A changed payload gets a fresh command ID.
  const retry=useRef<{key:string;id:string}|null>(null);
  const startRequest=useRef<{occurrence:string;sessionId:string;expected:string|null;start:string}|null>(null);
  const [,tick]=useState(0);
  useEffect(()=>{const interval=window.setInterval(()=>tick(v=>v+1),15_000);const show=()=>setOpen(true);window.addEventListener('marina:open-checkin',show);return()=>{window.clearInterval(interval);window.removeEventListener('marina:open-checkin',show);};},[]);
  const data=useQuery<ScheduleReviewDay>({queryKey:['schedule-review',date],queryFn:()=>apiFetch(`/api/schedule-review/${date}`),refetchInterval:open?30_000:60_000,refetchOnWindowFocus:true});
  const day=data.data;
  useEffect(()=>{if(day&&requestedOccurrence.current){setSelected(requestedOccurrence.current);requestedOccurrence.current=null;}},[day]);
  useEffect(()=>{setSelected(null);setEditing(false);setError('');setMessage('');setUndo(null);retry.current=null;},[date]);
  useEffect(()=>{if(open){const url=new URL(window.location.href);if(url.searchParams.has('checkin')){url.searchParams.delete('checkin');window.history.replaceState(null,'',url.pathname+url.search+url.hash);}}},[open]);
  const occurrences=useMemo(()=>{const all=[...(day?.proposed?.occurrences??[]),...(day?.current??[]),...(day?.outcomes.map(o=>o.occurrence)??[])];return [...new Map(all.map(o=>[o.id,o])).values()].sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));},[day]);
  const outcomes=new Map(day?.outcomes.map(o=>[o.occurrence_id,o]));
  const pending=occurrences.filter(o=>(!outcomes.get(o.id)||outcomes.get(o.id)?.status==='unknown')&&Date.parse(o.start)<=Date.now());
  const occurrence=occurrences.find(o=>o.id===selected)??pending.find(o=>Date.parse(o.start)<=cloud.nowMs&&Date.parse(o.end)>cloud.nowMs)??occurrences.find(o=>o.id===cloud.timer?.scheduleOccurrenceId)??pending[0]??null;
  const outcome=occurrence?outcomes.get(occurrence.id):undefined;
  const sessions=occurrence&&day?matchingSessions(occurrence,day.sessions):[];
  const suggested=sessions.length===1?sessions[0]:null;
  const runningHere=Boolean(occurrence&&cloud.timer?.scheduleOccurrenceId===occurrence.id);
  const unfinished=day?.pendingTimers??[];
  const pendingHere=unfinished.find(t=>t.schedule_occurrence_id===occurrence?.id);
  const recordedTimer=runningHere?{id:cloud.timer!.sessionId,started_at:cloud.timer!.startedAt}:pendingHere;
  const currentNow=(day?.current??[]).filter(o=>Date.parse(o.start)<=cloud.nowMs&&Date.parse(o.end)>cloud.nowMs);
  const liveCandidate=currentNow.find(o=>!outcomes.get(o.id)||outcomes.get(o.id)?.status==='unknown');
  const livePending=unfinished.find(t=>t.schedule_occurrence_id===liveCandidate?.id)??(cloud.timer?.scheduleOccurrenceId===liveCandidate?.id&&cloud.timer?{id:cloud.timer.sessionId}:undefined);
  const overlappingNow=currentNow.length>1;
  const canStart=Boolean(occurrence&&day&&date<=day.today&&!recordedTimer&&(!outcome||outcome.status==='unknown'&&!outcome.actual_start));
  const startDefault=occurrence?new Date(Math.min(cloud.nowMs,Date.parse(occurrence.end)>cloud.nowMs?cloud.nowMs:Date.parse(occurrence.start))).toISOString():'';
  const endDefault=occurrence&&recordedTimer?new Date(runningHere?cloud.nowMs:Math.min(cloud.nowMs,Math.max(Date.parse(occurrence.end),Date.parse(recordedTimer.started_at)+60_000))).toISOString():'';
  const instantDate=(instant:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:day!.timezone}).format(new Date(instant));
  const promptId=liveCandidate?livePending?`end:${livePending.id}`:`start:${liveCandidate.id}`:'';
  const labelRange=(a:string,b:string)=>`${wallTime(a,day!.timezone)}–${wallTime(b,day!.timezone)}`;
  const refresh=async()=>{await Promise.all(['schedule-review','work-sessions','tasks','goal-tasks','schedule-preview','work-accounting'].map(key=>qc.invalidateQueries({queryKey:[key]})));};
  const startActivity=async(item:ScheduleOccurrence,actualStart=new Date(cloud.nowMs).toISOString())=>{
    if(busy||cloud.busy||!cloud.ready)return;
    if(startRequest.current?.occurrence!==item.id||startRequest.current.start!==actualStart)startRequest.current={occurrence:item.id,sessionId:crypto.randomUUID(),expected:cloud.timer?.sessionId??null,start:actualStart};
    setBusy(true);setError('');
    try{await apiPost(`/api/schedule-review/${date}/start`,{session_id:startRequest.current.sessionId,occurrence_id:item.id,expected_running_id:startRequest.current.expected,started_at:actualStart,attendance_only:true,track_live:date===day?.today&&(Date.parse(item.end)>cloud.nowMs||cloud.nowMs-Date.parse(actualStart)<5*60_000)});startRequest.current=null;setMessage('Event started · work timer stays independent');setUndo(null);await qc.invalidateQueries({queryKey:CLOUD_TIMER_KEY});await refresh();}
    catch(e){if((e as {status?:number}).status===409)startRequest.current=null;setError(e instanceof Error?e.message:'Start was not confirmed. Retry to check.');setOpen(true);}
    finally{setBusy(false);}
  };
  const endActivity=async(id=cloud.timer?.sessionId,endedAt?:string)=>{
    if(!id||busy||cloud.busy)return;setBusy(true);setError('');
    try{await cloud.stop(id,endedAt?{ended_at:endedAt}:{});setMessage('End saved · actual times recorded once');setUndo(null);setSelected(null);await refresh();}
    catch(e){setError(e instanceof Error?e.message:'End was not saved. Your timer is preserved.');setOpen(true);}
    finally{setBusy(false);}
  };
  const correctTimes=async(a:string,b?:string)=>{
    if(!occurrence||!outcome||busy)return;setBusy(true);setError('');
    try{await apiPost('/api/schedule-review/correct-time',{occurrence_id:occurrence.id,date,expected_revision:outcome.revision,actual_start:a,...(b?{actual_end:b}:{})});setEditing(false);setUndo(null);setMessage('Actual time corrected · no duplicate session');await qc.invalidateQueries({queryKey:CLOUD_TIMER_KEY});await refresh();}
    catch(e){setError(e instanceof Error?e.message:'The correction was not confirmed. Your chosen times are preserved.');}finally{setBusy(false);}
  };
  const choose=(item:ScheduleOccurrence)=>{setSelected(item.id);setEditing(false);setError('');retry.current=null;};
  const times=()=>{if(!occurrence||!day)return;setStart(wallTime(outcome?.actual_start??suggested?.started_at??occurrence.start,day.timezone));setEnd(wallTime(outcome?.actual_end??suggested?.ended_at??occurrence.end,day.timezone));setOvernight((outcome?.actual_end??suggested?.ended_at??occurrence.end).slice(0,10)>(outcome?.actual_start??suggested?.started_at??occurrence.start).slice(0,10));setEditing(true);setError('');};
  const commit=async(status:'confirmed'|'skipped'|'unknown',actual?:{start:string;end:string;session_id?:string},restore?:{previous:ScheduleOutcome|null;result:ScheduleOutcome})=>{
    if(!day||busy||(!occurrence&&!restore))return;
    const target=restore?.result.occurrence??occurrence!,previous=restore?restore.result:outcomes.get(target.id)??null;
    const body={date,occurrence_id:target.id,expected_revision:previous?.revision??0,status,actual_start:actual?.start??null,actual_end:actual?.end??null,session_id:actual?.session_id??null};
    const key=JSON.stringify(body);if(retry.current?.key!==key)retry.current={key,id:crypto.randomUUID()};
    setBusy(true);setError('');
    try{
      const result=await apiPost<ScheduleOutcome>('/api/schedule-review/check-in',{...body,command_id:retry.current.id});
      retry.current=null;setUndo(restore?null:{previous,result});setEditing(false);setSelected(null);
      setMessage(restore?'Change undone':status==='skipped'?'Marked skipped':actual?.session_id?'Saved · existing study time reused':'Saved');
      // Apply the acknowledged revision before refetch so a fast second tap
      // cannot use the stale previous revision.
      qc.setQueryData<ScheduleReviewDay>(['schedule-review',date],old=>old?{...old,outcomes:[...old.outcomes.filter(o=>o.occurrence_id!==result.occurrence_id),result]}:old);
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:'Could not save. Your times are still here; try again.');}
    finally{setBusy(false);}
  };
  const act=(action:Exclude<CheckInGesture,null>)=>{
    if(busy)return;if(action==='times'){times();return;}if(action==='skip'){void commit('skipped');return;}
    if(!occurrence)return;
    if(recordedTimer)return;
    if(canStart&&!suggested&&Date.parse(occurrence.end)>cloud.nowMs){void startActivity(occurrence);return;}
    if(suggested)void commit('confirmed',{start:suggested.started_at,end:suggested.ended_at!,session_id:suggested.id});
    else void commit('confirmed',{start:occurrence.start,end:occurrence.end});
  };
  const saveTimes=()=>{
    if(!day||!start||!end){setError('Choose both actual times.');return;}
    const a=calendarInstant(date,clockHour(start),day.timezone),b=calendarInstant(overnight?addRoutineDays(date,1):date,clockHour(end),day.timezone);
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b>Date.now()+1000){setError('Choose an end after the start, in the past.');return;}
    // A reported block is reconciled against every existing measured interval.
    // Editing block attendance never overwrites the original timer measurement.
    if(recordedTimer){void endActivity(recordedTimer.id,new Date(b).toISOString());return;}
    if(outcome?.session_id){void correctTimes(new Date(a).toISOString(),new Date(b).toISOString());return;}
    void commit('confirmed',{start:new Date(a).toISOString(),end:new Date(b).toISOString()});
  };
  const saveTomorrow=async()=>{
    if(!day||busy)return;setBusy(true);setError('');
    try{const result=await apiPost<{frozen:boolean;saved_at:string}>(`/api/schedule-review/${addRoutineDays(day.today,1)}/proposed`,{});setMessage(result.frozen?'Tomorrow’s proposed schedule is frozen':'Tomorrow’s proposal saved · finalizes at 21:00');await refresh();}
    catch(e){setError(e instanceof Error?e.message:'Could not save tomorrow’s proposal.');}finally{setBusy(false);}
  };
  return <div className="schedule-review-entry">
    <button type="button" className="schedule-review-launch" onClick={()=>setOpen(true)}><span>Proposed / Actual</span><span>{data.isPending?'Loading…':data.isError?'Retry':pending.length?`${pending.length} to check`:'Review day'}<ChevronRight size={14}/></span></button>
    {!open&&day&&date===day.today&&promptId&&dismissedPrompt!==promptId&&<aside className="schedule-bottom-checkin" aria-label="Quick event check-in">
      <div className="schedule-bottom-heading"><span>{liveCandidate?.title}<small>{overlappingNow?'Overlapping events · choose the one you attended':livePending?'Event end stays unconfirmed · work timer is separate':'Did you start?'}</small></span><button type="button" aria-label="Dismiss quick check-in" onClick={()=>setDismissedPrompt(promptId)}><X size={16}/></button></div>
      {!overlappingNow&&livePending?<ActualTimeGesture key={promptId} label="Ended" date={instantDate(new Date(cloud.nowMs).toISOString())} timezone={day.timezone} initial={new Date(cloud.nowMs).toISOString()} disabled={busy||cloud.busy} onChoose={instant=>void endActivity(livePending.id,instant)}/>:liveCandidate&&!overlappingNow?<ActualTimeGesture key={promptId} label="Started" date={date} timezone={day.timezone} initial={new Date(cloud.nowMs).toISOString()} disabled={busy||cloud.busy} onChoose={instant=>void startActivity(liveCandidate,instant)}/>:null}
      <button type="button" className="schedule-bottom-review" onClick={()=>{if(liveCandidate)choose(liveCandidate);setOpen(true);}}>Review day<ChevronRight size={14}/></button>
    </aside>}
    {!open&&error&&<p role="alert">{error}</p>}
    {open&&<MobileSheet title="Proposed / Actual" onClose={()=>{if(!busy)setOpen(false);}}>
      <div className="schedule-review" aria-busy={busy}>
        <div className="schedule-review-date"><span>{date}</span><span>{day?.timezone}</span></div>
        <div className="schedule-review-tabs" aria-label="Schedule record">{(['proposed','actual']as const).map(tab=><button type="button" key={tab} aria-pressed={mode===tab} onClick={()=>{setMode(tab);setEditing(false);}}>{tab==='proposed'?'Proposed':'Actual'}</button>)}</div>
        {data.isPending&&<p role="status">Loading this day…</p>}
        {data.isError&&<p role="alert">Could not load this day. <button type="button" onClick={()=>void data.refetch()}>Retry</button></p>}
        {day&&<>
          {mode==='proposed'?<>
            <p className="schedule-review-caption">{day.proposed?`Saved ${new Intl.DateTimeFormat('en-GB',{timeZone:day.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(day.proposed.saved_at))}${day.proposed.frozen?' · frozen':' · finalizes at 21:00'}`:'No proposal was saved the previous evening. Today’s edits cannot recreate it.'}</p>
            {day.proposed?.occurrences.map(item=><button type="button" className="schedule-review-row" key={item.id} onClick={()=>{choose(item);setMode('actual');}}><span>{item.title}</span><span>{labelRange(item.start,item.end)}</span></button>)}
            {day.proposed&&!day.proposed.occurrences.length&&<p className="schedule-review-caption">The saved proposal has no timed blocks.</p>}
          </>:<>
            {!occurrences.length&&<p className="schedule-review-caption">No timed calendar blocks to check. Recorded study sessions appear below.</p>}
            {occurrences.map(item=>{
              const o=outcomes.get(item.id),recorded=matchingSessions(item,day.sessions);
              const state=o?.status==='confirmed'?'Confirmed':o?.status==='skipped'?'Skipped':o?.actual_start?'End unconfirmed':recorded.length?'Timer recorded · to confirm':'Unconfirmed';
              const time=o?.actual_start&&o.actual_end?labelRange(o.actual_start,o.actual_end):o?.actual_start?`${wallTime(o.actual_start,day.timezone)}–?`:recorded.length===1?labelRange(recorded[0].started_at,recorded[0].ended_at!):'—';
              return <button type="button" className={`schedule-review-row ${occurrence?.id===item.id?'active':''}`} key={item.id} onClick={()=>choose(item)}><span>{item.title}<small>{state}{day.proposed&&!day.proposed.occurrences.some(p=>p.id===item.id)?' · added today':''}</small></span><span>{time}</span></button>;
            })}
            {unfinished.filter(t=>!occurrences.some(o=>o.id===t.schedule_occurrence_id)).map(t=><section className="schedule-checkin-card" key={t.id}><h3>{t.title}</h3><p className="schedule-review-caption">Started {wallTime(t.started_at,day.timezone)} · end unconfirmed</p><ActualTimeGesture label="Ended" initial={new Date(Math.min(cloud.nowMs,calendarInstant(date,23.99,day.timezone))).toISOString()} date={date} timezone={day.timezone} disabled={busy||cloud.busy} onChoose={instant=>void endActivity(t.id,instant)}/></section>)}
            {day.sessions.filter(s=>s.source!=='schedule_checkin'&&s.ended_at&&!occurrences.some(o=>matchingSessions(o,[s]).length)).map(s=><div key={s.id} className="schedule-review-row"><span>Unscheduled study<small>Recorded · {Math.round(Number(s.minutes))} min</small></span><span>{labelRange(s.started_at,s.ended_at!)}</span></div>)}
            {occurrence&&<section className="schedule-checkin-card" aria-label="Event check-in" key={occurrence.id}>
              <div className="schedule-checkin-heading"><div><p>{recordedTimer?'Start recorded · end unconfirmed':'When did it happen?'}</p><h3>{occurrence.title}</h3></div><button type="button" aria-label="Leave this event unconfirmed" disabled={busy} onClick={()=>{setSelected(null);setOpen(false);}}><X size={16}/></button></div>
              <p className="schedule-review-caption">Planned {labelRange(occurrence.start,occurrence.end)}</p>
              {suggested&&<p className="schedule-checkin-evidence">Study session found · {labelRange(suggested.started_at,suggested.ended_at!)} · {Math.round(Number(suggested.minutes))} work min</p>}
              {sessions.length>1&&<div className="schedule-checkin-evidence">{sessions.length} recorded sessions already count once.{sessions.map(s=><p key={s.id}>{labelRange(s.started_at,s.ended_at!)} · {Math.round(Number(s.minutes))} work min</p>)}</div>}
              {outcome&&outcome.status!=='unknown'&&<button type="button" className="schedule-clear-confirmation" disabled={busy||runningHere} onClick={()=>void commit('unknown')}>Clear confirmation</button>}
              {editing?<>
                <div className="schedule-actual-fields"><label>Start<input type="time" value={recordedTimer?wallTime(recordedTimer.started_at,day.timezone):start} onChange={e=>setStart(e.target.value)} disabled={busy||Boolean(recordedTimer)}/></label><label>End<input type="time" value={end} onChange={e=>setEnd(e.target.value)} disabled={busy}/></label></div>
                <label className="schedule-next-day"><input type="checkbox" checked={overnight} onChange={e=>setOvernight(e.target.checked)} disabled={busy}/>Ends the next day</label>
                {sessions.length>0&&<p className="schedule-review-caption">Recorded timer minutes are reused within these times. Timer measurements stay in session history.</p>}
                <div className="schedule-actual-save"><button type="button" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button><button type="button" disabled={busy} onClick={saveTimes} aria-label="Save actual times"><Check size={18}/></button></div>
              </>:<>
                {cloud.timer&&!runningHere&&canStart&&<p className="schedule-review-caption">Starting this event leaves “{cloud.timer.title}” with its end unconfirmed. It won’t fill in an end or saved duration.</p>}
                {recordedTimer?<><ActualTimeGesture key="recorded-start" label="Started" date={date} timezone={day.timezone} initial={recordedTimer.started_at} disabled={busy||cloud.busy} onChoose={instant=>void correctTimes(instant)}/><ActualTimeGesture key="end" label="Ended" date={instantDate(endDefault)} timezone={day.timezone} initial={endDefault} disabled={busy||cloud.busy} onChoose={instant=>void endActivity(recordedTimer.id,instant)}/></>:outcome?.status==='confirmed'&&outcome.actual_start&&outcome.actual_end?<><ActualTimeGesture key="finished-start" label="Started" date={date} timezone={day.timezone} initial={outcome.actual_start} disabled={busy} onChoose={instant=>{if(outcome.session_id)void correctTimes(instant,outcome.actual_end!);else void commit('confirmed',{start:instant,end:outcome.actual_end!});}}/><ActualTimeGesture key="finished-end" label="Ended" date={instantDate(outcome.actual_end)} timezone={day.timezone} initial={outcome.actual_end} disabled={busy} onChoose={instant=>{if(outcome.session_id)void correctTimes(outcome.actual_start!,instant);else void commit('confirmed',{start:outcome.actual_start!,end:instant});}}/></>:canStart?<ActualTimeGesture key="start" label="Started" date={date} timezone={day.timezone} initial={startDefault} disabled={busy||cloud.busy} onChoose={instant=>void startActivity(occurrence,instant)}/>:null}
                <div className="schedule-checkin-actions">{suggested&&!recordedTimer?<button type="button" disabled={busy} onClick={()=>act('done')}>Use timer</button>:<span/>}<button type="button" disabled={busy} onClick={times}>Times</button><button type="button" disabled={busy||Boolean(recordedTimer)} onClick={()=>act('skip')}>Skipped</button></div>
              </>}
            </section>}
          </>}
          {message&&<div role="status" className="schedule-review-message"><span>{message}</span>{undo&&<button type="button" disabled={busy} onClick={()=>void commit(undo.previous?.status??'unknown',undo.previous?.actual_start&&undo.previous.actual_end?{start:undo.previous.actual_start,end:undo.previous.actual_end,session_id:undo.previous.session_id??undefined}:undefined,undo)}><Undo2 size={14}/>Undo</button>}</div>}
          {error&&<p role="alert" className="schedule-review-error">{error}<button type="button" disabled={busy} onClick={()=>{retry.current=null;void data.refetch();}}>Refresh day</button></p>}
          <div className="schedule-review-secondary"><button type="button" disabled={busy} onClick={()=>void saveTomorrow()}>Save tomorrow’s proposal</button><button type="button" aria-label="iPhone widget and check-in help" onClick={()=>setHelp(v=>!v)}><HelpCircle size={16}/></button></div>
          <ScheduleReminders/>
          {help&&<div className="schedule-review-help"><p>Hold Started or Ended, slide to the real time, and release to save. Drag down to cancel, or tap for exact time entry. Passing an event’s end or moving to another event never fills in the missing end.</p><p>For a quick iPhone widget, create a shortcut with URL → Open URLs using the link below, then add Apple’s Shortcuts widget and choose it.</p><input aria-label="iPhone check-in shortcut URL" readOnly value={`${window.location.origin}/?view=schedule&checkin=1`} onFocus={e=>e.currentTarget.select()}/><ScheduleShortcuts/><p>The custom gesture works inside Marina. Shortcuts uses Apple’s own prompts. A live Marina widget requires a separate iOS app extension.</p></div>}
        </>}
      </div>
    </MobileSheet>}
  </div>;
}
