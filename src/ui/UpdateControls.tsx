import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { openExternal, updates, type UpdateStatus } from '../data/client';
import { errorMessage } from './format';
import './updates.css';
export function UpdateControls({compact=false}:{compact?:boolean}) {
  const [status,setStatus]=useState<UpdateStatus|null>(null);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let live=true;
    const refresh=()=>{void updates.status().then(value=>{if(live)setStatus(value);}).catch(error=>{if(live)setStatus({state:'error',message:errorMessage(error)});});};
    refresh();const interval=setInterval(refresh,2000);
    return()=>{live=false;clearInterval(interval);};
  },[]);
  const working=busy || status?.state==='checking' || status?.state==='downloading';
  const ready=status?.state==='ready' && status.downloaded;
  const available=status?.state==='available';
  const label=ready?'Install and restart':available?'Download update':status?.state==='downloading'?'Downloading…':working?'Checking…':'Check for updates';
  async function activate() {
    setBusy(true);
    try {
      if(ready) setStatus(await updates.install());
      else if(available) await openExternal(status.downloadUrl ?? status.releaseUrl ?? 'https://github.com/etphli/centre/releases');
      else setStatus(await updates.check());
    } catch(error) {setStatus(current=>({...current,state:'error',message:errorMessage(error)}));}
    finally {setBusy(false);}
  }
  if(compact && !available && !ready && status?.state!=='downloading') return null;
  return <div className={`app-updates${compact?' app-updates--compact':''}`}>
    {!compact?<p className="app-updates__version">{status?.currentVersion?`Installed version ${status.currentVersion}`:'Centre desktop'}{status?.version?` · Latest release ${status.version}`:''}</p>:null}
    <button type="button" className={`button ${ready||available?'button--primary':''}`} disabled={Boolean(working)||status?.state==='unavailable'} onClick={()=>void activate()}>
      {working?<RefreshCw size={15} className="spin" aria-hidden/>:<Download size={15} aria-hidden/>}{label}
    </button>
    <p className="app-updates__status" role="status">{compact && (status?.state==='idle'||status?.state==='current')?`Centre ${status.currentVersion ?? ''}`:status?.message ?? 'Loading update status…'}</p>
    {!compact?<button type="button" className="link-button" onClick={()=>void openExternal('https://github.com/etphli/centre/releases').catch(error=>setStatus({state:'error',message:errorMessage(error)}))}>View public releases</button>:null}
  </div>;
}
