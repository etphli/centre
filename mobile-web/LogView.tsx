import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, Plus, Square } from 'lucide-react';
import { durationMs, sessionSegments, shiftStudyDate, weeklyStudy, weekStartAt, weeklyStudyGoalSchema, timerRemainingMs } from '../shared/study-log';
import { dateLabel, library, localDate, manualSession, timeLabel, type Subject } from './domain';
import type { MobileState } from './data/store';
import type { MobileModel } from './model';
import { AttemptHistory } from './AttemptHistory';
import { ErrorLine, useAction, Empty } from './ui';

export function LogView({state,model,subjects}:{state:MobileState;model:MobileModel;subjects:Subject[]}) {
  const data=library(state.entities),zone=data.preferences.timeZone;
  const [now,setNow]=useState(Date.now()),[week,setWeek]=useState(()=>weekStartAt(Date.now(),zone)),[adding,setAdding]=useState(false),[aim,setAim]=useState(false);
  const action=useAction();
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const summary=weeklyStudy(data.sessions,week,zone,now),goal=data.goals.find(item=>item.weekStart===week&&item.timeZone===zone);
  const maximum=Math.max(...summary.days.map(item=>item.durationMs),3_600_000);
  const timer=data.sessions.find(item=>item.source==='timer'&&item.state.kind!=='completed');
  const [timerTitle,setTimerTitle]=useState('Study session'),[targetMinutes,setTargetMinutes]=useState(30);
  return <>
    <div className="page-title"><div><p className="muted">Your time, accounted for</p><h1>Log</h1></div><button className="icon-button" aria-label="Log completed study" onClick={()=>setAdding(!adding)}><Plus/></button></div>
    <div className="week-nav"><button className="icon-button" aria-label="Previous week" onClick={()=>setWeek(shiftStudyDate(week,-7))}><ChevronLeft/></button><button className="text-button" onClick={()=>setWeek(weekStartAt(now,zone))}>{week===weekStartAt(now,zone)?'This week':`Week of ${dateLabel(week+'T12:00:00Z','UTC')}`}</button><button className="icon-button" aria-label="Next week" onClick={()=>setWeek(shiftStudyDate(week,7))}><ChevronRight/></button></div>
    <section className="study-summary" aria-label="Weekly study"><div className="study-total">{timeLabel(summary.durationMs)}</div><div className="chart">{summary.days.map(day=><div className="chart-day" key={day.date}><span className="chart-value">{day.durationMs?timeLabel(day.durationMs):''}</span><div className="chart-track">{day.durationMs>0?<span style={{height:`${Math.max(2,day.durationMs/maximum*100)}%`}}/>:null}</div><span>{new Intl.DateTimeFormat('en',{weekday:'narrow',timeZone:'UTC'}).format(new Date(day.date+'T12:00:00Z'))}</span><span className="sr-only">{day.date}: {timeLabel(day.durationMs)}</span></div>)}</div>
      <button className="goal-button" onClick={()=>setAim(!aim)}>{goal?`${timeLabel(summary.durationMs)} of ${timeLabel(goal.targetMinutes*60_000)} weekly aim`:'Set a weekly aim'}<span aria-hidden>↗</span></button>
      {goal?<progress max={goal.targetMinutes*60_000} value={summary.durationMs} aria-label="Weekly study aim"/>:null}
      {aim?<form className="inline-form" onSubmit={event=>{event.preventDefault();const input=new FormData(event.currentTarget);void action.run(async()=>{const stamp=new Date().toISOString();const next=weeklyStudyGoalSchema.parse({...goal,schemaVersion:1,id:goal?.id??crypto.randomUUID(),revision:(goal?.revision??0)+1,createdAt:goal?.createdAt??stamp,updatedAt:stamp,deletedAt:null,weekStart:week,timeZone:zone,targetMinutes:Number(input.get('minutes'))});await model.store.save('studyGoal',next.id,next);setAim(false);});}}><label>Aim in minutes<input name="minutes" type="number" min="1" max="10080" required defaultValue={goal?.targetMinutes??300}/></label><button className="button" disabled={action.busy}>Save aim</button></form>:null}
    </section>
    <section className="section timer"><div className="section-heading"><h2>Study timer</h2>{timer?<span className="chip">{timer.state.kind==='running'?'Running':timer.state.kind==='paused'&&timer.state.reason==='recovery'?'Recovered paused':'Paused'}</span>:null}</div>
      {timer?<><h3>{timer.title}</h3><div className="timer-time" aria-live="off">{timerRemainingMs(timer,now)===null?timeLabel(durationMs(sessionSegments(timer,now))):`${Math.ceil((timerRemainingMs(timer,now)??0)/60_000)} min left`}</div><div className="button-row">{timer.state.kind==='running'?<button className="button primary" disabled={action.busy} onClick={()=>void action.run(()=>model.timer('pause',timer.id))}><Pause size={16}/>Pause</button>:<button className="button primary" disabled={action.busy} onClick={()=>void action.run(()=>model.startTimer(timer.title,timer.subjectId,timer.timeZone,timer.id))}><Play size={16}/>Resume</button>}<button className="button" disabled={action.busy} onClick={()=>void action.run(()=>model.timer('finish',timer.id))}><Square size={14}/>Finish</button>{timer.state.kind==='running'?<button className="text-button" onClick={()=>void action.run(()=>model.timer('confirm',timer.id))}>Still studying</button>:null}</div></>:<form onSubmit={event=>{event.preventDefault();void action.run(()=>model.startTimer(timerTitle,null,zone,undefined,targetMinutes));}}><label className="sr-only" htmlFor="timer-title">What are you studying?</label><input id="timer-title" value={timerTitle} maxLength={200} required onChange={event=>setTimerTitle(event.target.value)}/><label className="timer-duration">Minutes<input type="number" min="5" max="1440" step="5" value={targetMinutes} onChange={event=>setTargetMinutes(Number(event.target.value))} required/></label><button className="button primary" disabled={action.busy}><Play size={16}/>Start timer</button></form>}
      <p className="detail">Keep Centre open while timing. Leaving the app pauses it. If iOS closes it, recovery stops at the last saved checkpoint.</p>
    </section>
    {adding?<ManualForm zone={zone} subjects={subjects} onCancel={()=>setAdding(false)} onSave={async input=>{await model.saveSession(manualSession(input,Date.now()));setAdding(false);}}/>:null}
    <ErrorLine error={action.error}/>
    <div className="section-heading"><h2>Study this week</h2><button className="text-button" onClick={()=>setAdding(true)}>Log study</button></div>
    {!summary.entries.length?<Empty title="A little progress adds up">Start a timer or log study you have already done. Your week will appear here.</Empty>:<div className="list">{summary.entries.slice().reverse().map(entry=><div className="list-row" key={entry.id}><div><h3>{entry.title}</h3><p>{dateLabel(entry.segments[0]?.start??entry.createdAt,zone)}{entry.subjectId?` · ${subjects.find(item=>item.id===entry.subjectId)?.name??'Saved subject'}`:''}</p></div><strong>{timeLabel(durationMs(sessionSegments(entry,now)))}</strong></div>)}</div>}
    <AttemptHistory attempts={data.attempts} resources={data.resources}/>
  </>;
}
function ManualForm({zone,subjects,onSave,onCancel}:{zone:string;subjects:Subject[];onSave:(input:{title:string;date:string;time:string;minutes:number;subjectId:string|null;timeZone:string})=>Promise<void>;onCancel:()=>void}) {
  const action=useAction();
  return <section className="section"><h2>Log completed study</h2><form className="form" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);void action.run(()=>onSave({title:String(form.get('title')),date:String(form.get('date')),time:String(form.get('time')),minutes:Number(form.get('minutes')),subjectId:String(form.get('subject'))||null,timeZone:zone}));}}>
    <label>What did you study?<input name="title" maxLength={200} required autoFocus/></label><div className="field-pair"><label>Date<input name="date" type="date" required defaultValue={localDate(Date.now(),zone)}/></label><label>Started at<input name="time" type="time" required defaultValue="09:00"/></label></div>
    <label>Duration in minutes<input name="minutes" type="number" required min="1" max="1440" defaultValue="30"/></label><label>Subject<select name="subject"><option value="">General study</option>{subjects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p className="detail">Times use {zone.replaceAll('_',' ')}.</p><ErrorLine error={action.error}/><div className="button-row"><button className="button" type="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={action.busy}>Save study</button></div>
  </form></section>;
}
