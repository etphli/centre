import { Markdown } from './Markdown';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { BookOpen, ChevronRight, Search } from 'lucide-react';
import { library, dateLabel } from './domain';
import { type MobileState, MobileRequestError } from './data/store';
import type { MobileModel } from './model';
import type { Resource } from '../shared/schema';
import { attemptSchema, quizDraftSchema } from '../shared/practice';
import { Back, Empty, ErrorLine, useAction } from './ui';
import { AttemptHistory } from './AttemptHistory';
import { SafeDocument } from './SafeDocument';
const gradeInput=z.object({id:z.uuid(),resourceId:z.string(),draftId:z.uuid(),expectedDraftRevision:z.number().int().positive()});
const gradeJournal=gradeInput.extend({terminal:z.boolean().default(false)});
const gradeReply=z.object({status:z.string(),attempt:attemptSchema.optional()});
export function LibraryView({state,model,selected,onSelect}:{state:MobileState;model:MobileModel;selected:string|null;onSelect:(id:string|null)=>void}) {
  const data=useMemo(()=>library(state.entities),[state.entities]),[search,setSearch]=useState('');
  const resource=data.resources.find(item=>item.id===selected);
  if(resource)return <ResourceView key={resource.id} resource={resource} state={state} model={model} onBack={()=>onSelect(null)}/>;
  const results=data.resources.filter(item=>`${item.title} ${item.kind} ${item.kind==='diagram'?'':item.content}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  return <><div className="page-title"><div><p className="muted">Bring your materials along</p><h1>Resources</h1></div><BookOpen aria-hidden/></div><label className="search"><Search size={18}/><span className="sr-only">Search saved resources</span><input placeholder="Search your resources" value={search} onChange={event=>setSearch(event.target.value)}/></label>
    {!results.length?<Empty title={search?'No matching resources':'Your library, on your phone'}>{search?'Try another word.':'In Centre on your Mac, enable cloud sync and import your library. Synced resources will be available here and offline.'}</Empty>:<div className="list">{results.map(item=><button className="list-row" key={item.id} onClick={()=>onSelect(item.id)}><div><span className="detail kind">{item.kind}</span><h2>{item.title}</h2><p>{item.questions.length?`${item.questions.length} questions · `:''}{dateLabel(item.updatedAt)}</p></div><ChevronRight size={18}/></button>)}</div>}
  </>;
}
function ResourceView({resource,state,model,onBack}:{resource:Resource;state:MobileState;model:MobileModel;onBack:()=>void}) {
  const action=useAction(),data=useMemo(()=>library(state.entities),[state.entities]);
  return <><Back onClick={()=>void action.run(async()=>{await model.serial(async()=>undefined);onBack();})}>Resources</Back><div className="page-title"><div><p className="muted kind">{resource.kind}</p><h1>{resource.title}</h1></div></div>
    {resource.questions.length?<Quiz resource={resource} state={state} model={model}/>:resource.kind==='diagram'?<SafeDocument resource={resource} state={state} model={model}/>:<Markdown text={resource.content}/>}
    {!resource.questions.length&&resource.kind!=='diagram'?<button className="button" disabled={action.busy} onClick={()=>void action.run(()=>model.store.save('resource',resource.id,{...resource,connectedFile:undefined,completedAt:resource.completedAt?null:new Date().toISOString(),updatedAt:new Date().toISOString()}))}>{resource.completedAt?'Mark as unfinished':'Mark done'}</button>:null}
    <AttemptHistory attempts={data.attempts.filter(item=>item.resourceId===resource.id)} resources={data.resources}/>
    <ErrorLine error={action.error}/>
  </>;
}
function Quiz({resource,state,model}:{resource:Resource;state:MobileState;model:MobileModel}) {
  const data=useMemo(()=>library(state.entities),[state.entities]),draft=data.drafts.find(item=>item.resourceId===resource.id);
  const [answers,setAnswers]=useState<Record<string,string>>(()=>draft?.answers??{}),[saving,setSaving]=useState(0),[saveError,setSaveError]=useState<string|null>(null);
  const [journal,setJournal]=useState<z.infer<typeof gradeJournal>|null>(null),[journalLoaded,setJournalLoaded]=useState(false),[result,setResult]=useState<z.infer<typeof attemptSchema>|null>(null);
  const action=useAction();
  const key=`grade:${resource.id}`;
  useEffect(()=>{let live=true;void model.store.getLocal(key).then(value=>{if(live){const parsed=gradeJournal.safeParse(value);setJournal(parsed.success?parsed.data:null);setJournalLoaded(true);}}).catch(()=>{if(live)setJournalLoaded(true);});return()=>{live=false;};},[model,key]);
  useEffect(()=>{if(draft && !saving)setAnswers(draft.answers);},[draft?.updatedAt,saving]);
  function answer(id:string,value:string) {
    setAnswers(current=>({...current,[id]:value}));setSaving(count=>count+1);setSaveError(null);
    void model.answer(resource,id,value).catch(error=>setSaveError(error instanceof Error?error.message:'Answer could not be saved. Keep this page open and try again.')).finally(()=>setSaving(count=>count-1));
  }
  async function mark() {
    if(saving||saveError)throw new Error('Wait for your answers to finish saving.');
    await model.serial(async()=>undefined);
    await model.store.sync();
    const snapshot=model.store.getSnapshot();
    if(snapshot.pending||snapshot.conflicts.length)throw new Error('Finish syncing and resolve saved changes before marking. Your answers are safe here.');
    let input=journal;
    if(!input){const current=await model.draft(resource);await model.store.sync();if(model.store.getSnapshot().pending)throw new Error('Connect to the internet before marking.');input=gradeJournal.parse({id:crypto.randomUUID(),resourceId:resource.id,draftId:current.id,expectedDraftRevision:current.revision});await model.store.saveLocal(key,input);setJournal(input);}
    let reply:unknown;
    try {
      try{reply=await model.store.request(`/v1/ai/grades/${input.id}`);}catch(error){if(!(error instanceof MobileRequestError)||error.status!==404)throw error;reply=await model.store.request('/v1/ai/grades',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(gradeInput.parse(input))});}
    } catch(error) {
      if(error instanceof MobileRequestError && [400,409,413,415,422].includes(error.status)){const failed={...input,terminal:true};await model.store.saveLocal(key,failed);setJournal(failed);throw new Error('Marking could not finish. Start over to try a new draft. Your saved attempts will stay.');}
      throw error;
    }
    const grade=gradeReply.parse(reply);
    if(grade.status==='completed'&&grade.attempt){setResult(grade.attempt);setAnswers({});setJournal(null);await model.store.saveLocal(key,null);await model.store.sync();}
    else throw new Error('Marking is in progress. Tap Check result in a moment. The same request will be used.');
  }
  return <section className="quiz"><div className="quiz-status"><span>{saving?'Saving answers…':saveError?'Answers need saving':draft?'Answers saved on this device':'Your answers save as you type'}</span><span>{Object.values(answers).filter(value=>value.trim()).length} of {resource.questions.length} answered</span></div>
    <ErrorLine error={saveError}/>{saveError?<button className="button" onClick={()=>{for(const [id,value]of Object.entries(answers))answer(id,value);}}>Retry saving answers</button>:null}
    {journal&&!journal.terminal?<p className="notice">A marking request is saved. Check its result before changing your answers.</p>:null}
    {resource.questions.map((question,index)=><section className="question" key={question.id}><p className="detail">Question {index+1} · {question.marks} {question.marks===1?'mark':'marks'}</p><Markdown text={question.prompt}/>{question.responseType==='multiple_choice'?<fieldset disabled={!!journal||action.busy}><legend className="sr-only">Answer for question {index+1}</legend>{question.choices.map(choice=><label className="choice" key={choice}><input type="radio" name={question.id} checked={answers[question.id]===choice} onChange={()=>answer(question.id,choice)}/><span>{choice}</span></label>)}</fieldset>:<label><span className="sr-only">Answer for question {index+1}</span><textarea rows={question.responseType==='long_response'?6:3} maxLength={4000} disabled={!!journal||action.busy} value={answers[question.id]??''} onChange={event=>answer(question.id,event.target.value)} placeholder="Your answer"/></label>}</section>)}
    <p className="detail">Written answers use Centre Cloud AI when you choose Mark answers. Marking needs the internet and may have daily limits.</p>{!journal?.terminal?<button className="button primary" disabled={action.busy||saving>0||!journalLoaded||!!saveError} onClick={()=>void action.run(mark)}>{action.busy?'Checking…':journal?'Check result':'Mark answers'}</button>:null}<ErrorLine error={action.error??(journal?.terminal?'Marking could not finish. Start over to try a new draft. Your saved attempts will stay.':null)}/>
    {result?<div className="result" role="status"><h2>{result.result.score} of {result.result.total} marks</h2><p>Your attempt is saved. Review answers and feedback in Quiz history below.</p></div>:null}
    {((draft&&!journal)||journal?.terminal)?<button className="button danger" disabled={saving>0||action.busy} onClick={()=>{if(window.confirm('Start a new attempt? Your unfinished answers will be removed. Saved attempts stay.'))void action.run(async()=>{await model.serial(async()=>{const current=library(model.store.getSnapshot().entities).drafts.find(item=>item.id===draft?.id);if(current)await model.store.save('practice.draft',current.id,quizDraftSchema.parse({...current,revision:current.revision+1,deletedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));});await model.store.saveLocal(key,null);setJournal(null);setAnswers({});setResult(null);await model.draft(resource);});}}>Start over</button>:null}
  </section>;
}
