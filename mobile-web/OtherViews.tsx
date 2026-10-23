import { useState } from 'react';
import { CalendarDays, Check, ClipboardCheck, RefreshCw } from 'lucide-react';
import { library, dateLabel, type Subject } from './domain';
import type { MobileState } from './data/store';
import type { MobileModel } from './model';
import { Empty, ErrorLine, Markdown, useAction } from './ui';
export function ReviewView({state,model}:{state:MobileState;model:MobileModel}) {
  const data=library(state.entities),action=useAction(),[showAll,setShowAll]=useState(false);
  const pending=data.reviews.filter(item=>!item.resolvedAt&&(showAll||Date.parse(item.nextReviewAt)<=Date.now())).sort((a,b)=>a.nextReviewAt.localeCompare(b.nextReviewAt));
  return <><div className="page-title"><div><p className="muted">Make the learning stick</p><h1>Review</h1></div><ClipboardCheck aria-hidden/></div><div className="button-row"><button className={`button ${!showAll?'selected':''}`} onClick={()=>setShowAll(false)}>Due now</button><button className={`button ${showAll?'selected':''}`} onClick={()=>setShowAll(true)}>All unresolved</button></div><ErrorLine error={action.error}/>
    {!pending.length?<Empty title="You're up to date">Saved review items from your quizzes and study sessions will appear here when they are due.</Empty>:pending.map(item=><section className="section" key={item.id}><Markdown text={item.question}/><p>{item.note}</p><p className="detail">{data.resources.find(resource=>resource.id===item.resourceId)?.title??'Saved resource'} · Due {dateLabel(item.nextReviewAt)}</p><button className="button" disabled={action.busy} onClick={()=>void action.run(()=>model.store.save('reviewMemory',item.id,{...item,resolvedAt:new Date().toISOString()}))}><Check size={16}/>I understand this</button></section>)}
    <p className="detail">Reviews work offline. Your progress updates Centre's learning memory when it syncs.</p>
  </>;
}
export function CalendarView({state,subjects,onRefresh}:{state:MobileState;subjects:Subject[];onRefresh:()=>Promise<void>}) {
  const data=library(state.entities),action=useAction();
  const events=data.events.slice().sort((a,b)=>Date.parse(a.startAt??a.date+'T12:00:00Z')-Date.parse(b.startAt??b.date+'T12:00:00Z'));
  return <><div className="page-title"><div><p className="muted">See the week ahead</p><h1>Calendar</h1></div><button className="icon-button" aria-label="Refresh calendar and subjects" disabled={action.busy} onClick={()=>void action.run(onRefresh)}><RefreshCw size={20}/></button></div><p className="detail">Saved Centre plans. Plan changes and imported assignments are managed on your Mac. Planned time is separate from actual study in Log.</p><ErrorLine error={action.error}/>
    {!events.length?<Empty title="Room for a plan">Create study sessions in Centre on your Mac and sync them. Saved plans are available here offline.</Empty>:<div className="list">{events.map(item=><div className="list-row" key={item.id}><CalendarDays size={19}/><div><h2>{item.title}</h2><p>{dateLabel(item.startAt??item.date+'T12:00:00Z',item.startAt?item.timeZone:'UTC')} · {item.startAt?new Intl.DateTimeFormat('en',{hour:'numeric',minute:'2-digit',timeZone:item.timeZone}).format(new Date(item.startAt)):'All day'}</p><p>{item.plannedDurationMinutes} min{item.subjectId?` · ${subjects.find(subject=>subject.id===item.subjectId)?.name??'Saved subject'}`:''}{item.completedAt?' · Completed':''}</p>{item.notes?<p>{item.notes}</p>:null}</div></div>)}</div>}
  </>;
}
