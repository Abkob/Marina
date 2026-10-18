import { useEffect, useState } from 'react';
import { apiFetch, apiPost } from '../../utils/apiFetch';

export function ScheduleReminders(){
  const [config,setConfig]=useState<{configured:boolean;public_key:string|null;last_error:string|null}|null>(null);
  const [enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const supported=typeof Notification!=='undefined'&&'serviceWorker'in navigator&&'PushManager'in window;
  useEffect(()=>{let alive=true;apiFetch<typeof config>('/api/schedule-review/reminders/status').then(value=>{if(alive)setConfig(value);}).catch(()=>{if(alive)setError('Could not check reminder setup. Reopen this panel to retry.');});if(supported)navigator.serviceWorker.getRegistration('/').then(reg=>reg?.pushManager.getSubscription()).then(value=>{if(alive)setEnabled(Boolean(value));}).catch(()=>{});return()=>{alive=false;};},[]);
  const enable=async()=>{
    if(!supported||!config?.public_key)return;
    // Permission is requested immediately from the user's tap, before awaiting
    // registration/network work (required by Safari).
    const permission=Notification.requestPermission();setBusy(true);setError('');
    try{
      if(await permission!=='granted')throw new Error('Reminders weren’t allowed. Schedule check-in still works; you can enable notifications in iPhone Settings.');
      await navigator.serviceWorker.register('/schedule-worker.js',{scope:'/'});
      const registration=await navigator.serviceWorker.ready;
      const bytes=Uint8Array.from(atob(config.public_key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
      const subscription=await registration.pushManager.getSubscription()??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes.buffer});
      await apiPost('/api/schedule-review/reminders/subscribe',subscription.toJSON());setEnabled(true);
    }catch(e){setError(e instanceof Error?e.message:'Could not enable reminders. Try again.');}finally{setBusy(false);}
  };
  const disable=async()=>{setBusy(true);setError('');try{const registration=await navigator.serviceWorker.getRegistration('/');const sub=await registration?.pushManager.getSubscription();if(sub){await apiPost('/api/schedule-review/reminders/unsubscribe',{endpoint:sub.endpoint});await sub.unsubscribe();}setEnabled(false);}catch{setError('Could not disable reminders. Try again.');}finally{setBusy(false);}};
  return <div className="schedule-reminders"><button type="button" disabled={busy||!supported||!config?.configured} onClick={()=>void(enabled?disable():enable())}>{enabled?'Disable start/end reminders':'Enable start/end reminders'}</button><p className="schedule-review-caption">{!supported?'On iPhone, open Marina from its Home Screen icon to enable web notifications.':config&&!config.configured?'Reminder delivery is waiting for server configuration.':'Optional notifications open this check-in. Delivery can be a few minutes after the planned time; Focus may delay it.'}</p>{(error||config?.last_error)&&<p role="alert" className="schedule-review-error">{error||config?.last_error}</p>}</div>;
}
