import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { BookOpen, CalendarDays, ClipboardCheck, Clock3, MessageSquare, Settings, RefreshCw, WifiOff } from 'lucide-react';
import { MobileStore } from './data/store';
import { MobileModel } from './model';
import { library, organatoSnapshotSchema, type OrganatoSnapshot } from './domain';
import { LogView } from './LogView';
import { LibraryView } from './LibraryView';
import { ChatView } from './ChatView';
import { ReviewView, CalendarView } from './OtherViews';
import { InstallGuide, PairForm, SettingsView } from './SettingsView';
import { friendlyError } from './ui';
type Page='log'|'resources'|'review'|'chat'|'calendar'|'settings';
const tabs=[{id:'log',label:'Log',icon:Clock3},{id:'resources',label:'Resources',icon:BookOpen},{id:'review',label:'Review',icon:ClipboardCheck},{id:'chat',label:'Chat',icon:MessageSquare},{id:'calendar',label:'Calendar',icon:CalendarDays}] as const;
export function App({store}:{store:MobileStore}) {
  const state=useSyncExternalStore(listener=>store.subscribe(listener),()=>store.getSnapshot());
  const model=useMemo(()=>new MobileModel(store),[store,state.workspaceId]);
  const [page,setPage]=useState<Page>('log'),[opened,setOpened]=useState(false),[error,setError]=useState<string|null>(null),[organato,setOrganato]=useState<OrganatoSnapshot|null>(null),[offlineShell,setOfflineShell]=useState(true);
  const preferences=useMemo(()=>library(state.entities).preferences,[state.entities]);
  useEffect(()=>{let live=true;void store.open().then(()=>{if(live){setOpened(true);void store.sync().catch(failure=>setError(friendlyError(failure)));}}).catch(failure=>{if(live)setError(friendlyError(failure));});return()=>{live=false;};},[store]);
  useEffect(()=>{
    const media=matchMedia('(prefers-color-scheme: dark)');
    const apply=()=>{const theme=preferences.theme==='system'?(media.matches?'dark':'light'):preferences.theme;document.documentElement.dataset.theme=theme;document.documentElement.dataset.textSize=preferences.textSize;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='light'?'#f9f9f7':theme==='midnight'?'#101114':'#1b1b1a');};
    apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);
  },[preferences.theme,preferences.textSize]);
  useEffect(()=>{
    const update=()=>{if(document.visibilityState==='hidden'){void model.background().catch(failure=>setError(friendlyError(failure)));}else{void store.sync().catch(()=>undefined);}};
    const activity=()=>model.activity();
    const heartbeat=setInterval(()=>{if(document.visibilityState==='visible')void model.timer('heartbeat').catch(failure=>setError(friendlyError(failure)));},15_000);
    const sync=setInterval(()=>{if(document.visibilityState==='visible'&&store.getSnapshot().session)void store.sync().catch(()=>undefined);},60_000);
    const unavailable=()=>setOfflineShell(false);
    document.addEventListener('visibilitychange',update);window.addEventListener('online',update);window.addEventListener('centre-offline-unavailable',unavailable);document.addEventListener('pointerdown',activity);document.addEventListener('keydown',activity);
    return()=>{model.dispose();clearInterval(heartbeat);clearInterval(sync);document.removeEventListener('visibilitychange',update);window.removeEventListener('online',update);window.removeEventListener('centre-offline-unavailable',unavailable);document.removeEventListener('pointerdown',activity);document.removeEventListener('keydown',activity);};
  },[model,store]);
  useEffect(()=>{let live=true;setOrganato(null);if(state.phase==='unpaired')return;void model.store.getLocal('organato-snapshot').then(value=>{const parsed=organatoSnapshotSchema.safeParse(value);if(live&&parsed.success)setOrganato(parsed.data);}).catch(()=>undefined);return()=>{live=false;};},[state.workspaceId,state.phase==='unpaired',store]);
  async function refreshSubjects(){const value=organatoSnapshotSchema.parse(await model.store.request('/v1/organato/snapshot'));await model.store.saveLocal('organato-snapshot',value);setOrganato(value);}
  const subjects=organato?.subjects??[];
  const guest=state.phase==='unpaired';
  const status=state.phase==='offline'?'Offline':state.phase==='auth-required'?'Reconnect':state.phase==='syncing'?'Syncing':state.phase==='error'?'Sync paused':state.conflicts.length?'Needs review':state.pending?'Saved on device':'Synced';
  return <div className="app"><header className="app-header"><a href="/iphone/" aria-label="Centre home" onClick={event=>{event.preventDefault();setPage('log');}}><img src="/iphone/icons/icon-180.png" alt="" width={28} height={28}/><span>Centre</span></a>{!guest?<button className="icon-button" aria-label="Open settings" aria-current={page==='settings'?'page':undefined} onClick={()=>setPage('settings')}><Settings size={21}/></button>:<span className="detail">For iPhone</span>}</header>
    {!offlineShell?<div className="status-banner" role="status">Offline app files could not be saved. Stay online to reopen Centre.</div>:null}
    {!guest?<button className="sync-status" onClick={()=>setPage('settings')}>{state.phase==='offline'?<WifiOff size={13}/>:<span className={`status-dot ${state.phase==='ready'&&!state.pending?'ready':''}`}/>}<span>{status}{state.pending?` · ${state.pending} waiting`:''}</span>{state.phase==='syncing'?<RefreshCw size={12}/>:null}</button>:null}
    <main className={guest?'guest':'content'} key={guest?'guest':state.session?.workspaceId??'cached'}>
      {error?<div className="notice" role="alert"><p>{error}</p><button className="button" onClick={()=>{setError(null);void store.open().then(()=>{setOpened(true);return store.sync();}).catch(failure=>setError(friendlyError(failure)));}}>Try again</button></div>:null}
      {!opened?<p className="loading" role="status">Opening your study space…</p>:guest?<><InstallGuide/><PairForm store={store} onPaired={()=>setPage('log')}/></>:<>{page==='log'?<LogView state={state} model={model} subjects={subjects}/>:page==='resources'?<LibraryView state={state} model={model}/>:page==='review'?<ReviewView state={state} model={model}/>:page==='chat'?<ChatView state={state} model={model}/>:page==='calendar'?<CalendarView state={state} snapshot={organato} subjects={subjects} onRefresh={refreshSubjects}/>:<SettingsView state={state} model={model} onPaired={()=>setPage('log')}/>}</>}
    </main>
    {!guest?<nav className="tab-bar" aria-label="Study pages">{tabs.map(tab=><button key={tab.id} aria-current={page===tab.id?'page':undefined} onClick={()=>{setPage(tab.id);window.scrollTo({top:0});}}><tab.icon size={21} strokeWidth={page===tab.id?2:1.65}/><span>{tab.label}</span></button>)}</nav>:null}
  </div>;
}
