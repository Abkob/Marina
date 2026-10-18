import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiFetch, apiPost } from '../../utils/apiFetch';

type Key={id:string;label:string;expires_at:string};
export function ScheduleShortcuts() {
  const qc=useQueryClient();
  const keys=useQuery<Key[]>({queryKey:['schedule-shortcut-keys'],queryFn:()=>apiFetch('/api/schedule-review/shortcuts/keys')});
  const [token,setToken]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const create=async()=>{
    setBusy(true);setMessage('');
    try{const result=await apiPost<{token:string}>('/api/schedule-review/shortcuts/keys',{label:'My iPhone'});setToken(result.token);await qc.invalidateQueries({queryKey:['schedule-shortcut-keys']});}
    catch(e){setMessage(e instanceof Error?e.message:'Connection was not created.');}finally{setBusy(false);}
  };
  const revoke=async(id:string)=>{
    setBusy(true);setMessage('');
    try{await apiDelete(`/api/schedule-review/shortcuts/keys/${id}`);setToken('');await qc.invalidateQueries({queryKey:['schedule-shortcut-keys']});setMessage('Connection revoked.');}
    catch(e){setMessage(e instanceof Error?e.message:'Revocation was not confirmed.');}finally{setBusy(false);}
  };
  return <div className="schedule-shortcuts">
    <p>A shortcut can save Started / Ended directly without opening Marina. Connect it once below. Connections expire after 90 days and can be revoked here.</p>
    <button type="button" disabled={busy} onClick={()=>void create()}>Connect Shortcuts</button>
    {token&&<><p>Copy this private connection key now; it is shown only here. Keep it inside your own shortcut.</p><input type="password" aria-label="Private Shortcuts connection key" readOnly value={token} onFocus={e=>e.currentTarget.select()}/><button type="button" onClick={()=>void navigator.clipboard.writeText(token).then(()=>setMessage('Connection key copied.'),()=>setMessage('Select the connection key and copy it.'))}>Copy connection key</button></>}
    {keys.isError&&<p role="alert">Connections could not load. <button type="button" onClick={()=>void keys.refetch()}>Retry</button></p>}
    {keys.data?.map(key=><div className="schedule-shortcut-key" key={key.id}><span>{key.label}<small>Expires {new Date(key.expires_at).toLocaleDateString()}</small></span><button type="button" disabled={busy} aria-label={`Revoke ${key.label} connection`} onClick={()=>void revoke(key.id)}>Revoke</button></div>)}
    {message&&<p role="status">{message}</p>}
    <a href="/schedule-shortcuts.html" target="_blank" rel="noreferrer">Set up the iPhone shortcut</a>
  </div>;
}
