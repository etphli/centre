import { useState } from 'react';
import { attemptQuestions, attemptSummary, chronologicalAttempts, compareAttempts } from '../shared/attempt-comparison';
import type { QuizAttempt } from '../shared/practice';
import type { Resource } from '../shared/schema';
import { dateLabel } from './domain';
export function AttemptHistory({attempts,resources}:{attempts:QuizAttempt[];resources:Resource[]}) {
  const ids=[...new Set(chronologicalAttempts(attempts).reverse().map(item=>item.resourceId))];
  const [chosen,setChosen]=useState(''),[beforeId,setBeforeId]=useState(''),[afterId,setAfterId]=useState('');
  const resourceId=ids.includes(chosen)?chosen:ids[0];
  const history=chronologicalAttempts(attempts.filter(item=>item.resourceId===resourceId));
  const before=history.find(item=>item.id===beforeId)??history.at(-2),after=history.find(item=>item.id===afterId)??history.at(-1);
  const comparison=before&&after?compareAttempts(before,after):null;
  if(!attempts.length)return null;
  const label=(item:QuizAttempt)=>`${dateLabel(item.createdAt)} · ${item.result.score}/${item.result.total} marks · ${item.id.slice(-4)}`;
  return <section className="section history"><h2>Quiz history</h2>{ids.length>1?<label>Resource<select aria-label="Resource" value={resourceId} onChange={event=>{setChosen(event.target.value);setBeforeId('');setAfterId('');}}>{ids.map(id=><option value={id} key={id}>{resources.find(item=>item.id===id)?.title??`Unavailable resource ${id.slice(-6)}`}</option>)}</select></label>:null}
    <p className="detail">{resources.find(item=>item.id===resourceId)?.title??'This resource is no longer available. Its saved attempts can still be reviewed.'}</p>
    {history.length>1?<><div className="field-pair"><label>First attempt<select aria-label="First attempt" value={before?.id??''} onChange={event=>setBeforeId(event.target.value)}>{history.map(item=><option value={item.id} key={item.id}>{label(item)}</option>)}</select></label><label>Second attempt<select aria-label="Second attempt" value={after?.id??''} onChange={event=>setAfterId(event.target.value)}>{history.map(item=><option value={item.id} key={item.id}>{label(item)}</option>)}</select></label></div>{comparison?<div className="notice"><h3>{comparison.percentagePointChange===null?'No comparable total':`${comparison.percentagePointChange>0?'+':''}${comparison.percentagePointChange.toFixed(1)} percentage points`}</h3><p className="detail">{comparison.sharedQuestions} shared saved question IDs.{!comparison.sameQuestionSet?' The saved question sets differ.':''}{comparison.differentTotal?' The total marks differ.':''}{!comparison.sameMarking?' Mark allocations are not confirmed equal.':''}</p><p className="detail">V1 attempts do not retain the original question text or grader model. Shared IDs alone do not prove the questions or grading were identical.</p>{comparison.questions.map(item=><p key={item.id} className="detail">{item.id}: {item.change.replaceAll('-',' ')}{item.repeatedMistake&&item.change!=='repeated-mistake'?' · still needs work':''}</p>)}</div>:<p className="detail">Choose two different attempts.</p>}</>:null}
    {[...history].reverse().map(item=>{const summary=attemptSummary(item);return <details key={item.id}><summary>{label(item)}</summary><p className="detail">{summary.percent===null?'Percentage unavailable':`${summary.percent.toFixed(1)}%`} · {summary.answered} of {summary.questions} saved IDs answered · {summary.unanswered} unanswered</p>{attemptQuestions(item).map((question,index)=><div className="feedback" key={question.id}><h3>Saved question {index+1}</h3><p className="detail">{question.outcome}{question.marking?` · ${question.marking.score} of ${question.marking.maxScore} marks`:''}</p><p>{question.answer.trim()||'Unanswered'}</p>{question.marking?<p className="detail">{question.marking.feedback}</p>:null}</div>)}</details>;})}
  </section>;
}
