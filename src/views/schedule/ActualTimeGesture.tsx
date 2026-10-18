import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check } from 'lucide-react';
import { calendarInstant } from '../../utils/calendarTime';

const minuteAt=(value:string,zone:string)=>{const text=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));const [h,m]=text.split(':').map(Number);return h*60+m;};
const clock=(minute:number)=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;

/** Hold to reveal the actual-time ruler, slide horizontally, release to save.
 * Drag down to cancel. Ordinary time entry is always available by tapping. */
export function ActualTimeGesture({label,initial,date,timezone,disabled,onChoose}:{label:'Started'|'Ended';initial:string;date:string;timezone:string;disabled?:boolean;onChoose:(instant:string)=>void}){
 const [value,setValue]=useState(()=>minuteAt(initial,timezone));
 const [held,setHeld]=useState(false),[canceling,setCanceling]=useState(false),[editing,setEditing]=useState(false);
 const gesture=useRef<{id:number;x:number;y:number;minute:number;width:number;active:boolean;canceled:boolean;timer:ReturnType<typeof setTimeout>}|null>(null);
 const suppress=useRef(false),chosen=useRef(value),cancelRef=useRef(false);
 useEffect(()=>{if(!gesture.current&&!editing)setValue(minuteAt(initial,timezone));},[initial,timezone,editing]);
 const reset=()=>{if(gesture.current)clearTimeout(gesture.current.timer);gesture.current=null;setHeld(false);setCanceling(false);cancelRef.current=false;};
 useEffect(()=>{
  const stop=()=>{suppress.current=true;reset();};const multi=(e:PointerEvent)=>{if(!e.isPrimary&&gesture.current)stop();};const visibility=()=>{if(document.hidden)stop();};
  window.addEventListener('blur',stop);window.addEventListener('pointerdown',multi);document.addEventListener('visibilitychange',visibility);
  return()=>{if(gesture.current)clearTimeout(gesture.current.timer);window.removeEventListener('blur',stop);window.removeEventListener('pointerdown',multi);document.removeEventListener('visibilitychange',visibility);};
 },[]);
 const save=(minute:number)=>{onChoose(new Date(calendarInstant(date,minute/60,timezone)).toISOString());};
 const down=(e:ReactPointerEvent<HTMLButtonElement>)=>{
  if(disabled||e.button!==0||!e.isPrimary)return;
  suppress.current=false;cancelRef.current=false;const minute=minuteAt(initial,timezone);chosen.current=minute;setValue(minute);
  e.currentTarget.setPointerCapture(e.pointerId);
  const g={id:e.pointerId,x:e.clientX,y:e.clientY,minute,width:e.currentTarget.getBoundingClientRect().width||240,active:false,canceled:false,timer:setTimeout(()=>{if(gesture.current===g&&!g.canceled){g.active=true;setHeld(true);}},360)};gesture.current=g;
 };
 return <div className="actual-time-gesture">
  <button type="button" className={`actual-time-hold ${held?'held':''}`} disabled={disabled} aria-label={`Set actual ${label==='Started'?'start':'end'}`}
   onContextMenu={e=>e.preventDefault()} onPointerDown={down}
   onPointerMove={e=>{const g=gesture.current;if(!g||g.id!==e.pointerId)return;const dx=e.clientX-g.x,dy=e.clientY-g.y;if(!g.active){if(Math.hypot(dx,dy)>10){clearTimeout(g.timer);g.canceled=true;suppress.current=true;}return;}cancelRef.current=dy>60;setCanceling(cancelRef.current);const next=Math.max(0,Math.min(1439,Math.round((g.minute+dx*180/g.width)/5)*5));chosen.current=next;setValue(next);}}
   onPointerUp={e=>{const g=gesture.current;if(!g||g.id!==e.pointerId)return;const commit=g.active&&!g.canceled&&!cancelRef.current;const minute=chosen.current;suppress.current=g.active||g.canceled;reset();if(commit)save(minute);}}
   onPointerCancel={()=>{suppress.current=true;reset();}} onLostPointerCapture={()=>{if(gesture.current){suppress.current=true;reset();}}}
   onKeyDown={e=>{if(e.key==='Escape'){suppress.current=true;reset();}}}
   onClick={e=>{if(suppress.current&&e.detail!==0){suppress.current=false;return;}setEditing(v=>!v);}}>
   <span>{label}<small>{held?'Slide to the time':'Hold & slide to the time'}</small></span><span className="actual-time-value">{clock(value)}</span>
  </button>
  {held&&<div className="actual-time-ruler" aria-live="polite"><span>{clock(Math.max(0,value-30))}</span><span>{canceling?'Cancel':clock(value)}</span><span>{clock(Math.min(1439,value+30))}</span><p>{canceling?'Release to cancel':'Release to save · drag down to cancel'}</p></div>}
  {editing&&<div className="actual-time-entry"><label>Actual {label==='Started'?'start':'end'}<input type="time" value={clock(value)} disabled={disabled} onChange={e=>{if(!e.target.value)return;const [h,m]=e.target.value.split(':').map(Number);setValue(h*60+m);}}/></label><button type="button" disabled={disabled} aria-label={`Save actual ${label==='Started'?'start':'end'}`} onClick={()=>save(value)}><Check size={18}/></button></div>}
 </div>;
}
