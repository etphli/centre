import { useMemo, useState } from 'react';
import { attemptQuestions, attemptSummary, chronologicalAttempts, compareAttempts, type AttemptQuestion, type AttemptRecord, type QuestionChange } from '../../shared/attempt-comparison';
import { useApp } from './context';
import { Markdown } from './Markdown';
import { Select } from './Select';
import './attempt-history.css';

const number = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const percent = (value: number | null) => value === null ? 'Score unavailable' : `${number.format(value)}%`;
const outcomes = { unanswered: 'Unanswered', incorrect: 'Incorrect', partial: 'Partial credit', correct: 'Correct', ungraded: 'Marking unavailable' };
const changes: Record<QuestionChange, string> = { improved: 'Higher saved score', lower: 'Lower saved score', 'repeated-mistake': 'Needs work again', same: 'Same saved score', unanswered: 'Unanswered', 'answered-now': 'Answered this time', 'changed-marking': 'Mark allocation changed', 'not-shared': 'Only in one attempt', ungraded: 'Marking unavailable' };

function SavedAnswer({ question, label }: { question: AttemptQuestion | undefined; label: string }) {
  return <div className="attempt-answer"><h4>{label}</h4>{question ? <>
    <p className="attempt-answer__outcome">{outcomes[question.outcome]}{question.marking ? ` · ${number.format(question.marking.score)} / ${number.format(question.marking.maxScore)} marks` : ''}</p>
    <div className="attempt-answer__text">{question.answer.trim() ? <Markdown>{question.answer}</Markdown> : <span className="muted">No answer submitted</span>}</div>
    {question.marking?.feedback ? <div className="attempt-answer__feedback"><span>Saved feedback</span><Markdown>{question.marking.feedback}</Markdown></div> : null}
    {question.marking?.needsReview ? <p className="muted">Flagged for review when graded</p> : null}
  </> : <p className="muted">Question absent from this saved attempt.</p>}</div>;
}

export function AttemptHistory({ initialResourceId }: { initialResourceId?: string }) {
  const { state, navigate } = useApp();
  const [subject, setSubject] = useState('all');
  const [resourceId, setResourceId] = useState(initialResourceId ?? '');
  const [selectedId, setSelectedId] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const resources = useMemo(() => new Map(state.resources.map(resource => [resource.id, resource])), [state.resources]);
  const groups = useMemo(() => {
    const grouped = new Map<string, AttemptRecord[]>();
    for (const attempt of state.attempts) {
      const group = grouped.get(attempt.resourceId) ?? [];
      group.push(attempt); grouped.set(attempt.resourceId, group);
    }
    return [...grouped].map(([id, attempts]) => ({ id, resource: resources.get(id), attempts: chronologicalAttempts(attempts) }))
      .sort((a, b) => (a.resource?.title ?? a.id).localeCompare(b.resource?.title ?? b.id));
  }, [state.attempts, resources]);
  const filtered = groups.filter(group => subject === 'all' || (subject === 'unavailable' ? !group.resource : subject === 'personal' ? group.resource?.subjectId === null : group.resource?.subjectId === subject));
  const group = filtered.find(group => group.id === resourceId) ?? filtered[0];
  const attempts = group?.attempts ?? [];
  const current = attempts.find(attempt => attempt.id === selectedId) ?? attempts.at(-1);
  const index = attempts.findIndex(attempt => attempt.id === current?.id);
  const earlier = attempts.slice(0, Math.max(0, index));
  const baseline = earlier.find(attempt => attempt.id === baselineId) ?? earlier.at(-1);
  const comparison = current && baseline ? compareAttempts(baseline, current) : null;
  const summary = current ? attemptSummary(current) : null;
  const resource = group?.resource;
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-AU', { timeZone: state.settings.timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Date unavailable';
  const label = (attempt: AttemptRecord) => `Attempt ${attempts.findIndex(item => item.id === attempt.id) + 1} · ${date(attempt.createdAt)} · ${percent(attemptSummary(attempt).percent)}`;
  const chooseAttempt = (id: string) => { setSelectedId(id); setBaselineId(''); };
  const questions = comparison?.questions ?? (current ? attemptQuestions(current).map(question => ({ id: question.id, previous: undefined, current: question, change: undefined, repeatedMistake: false })) : []);
  return <div className="attempt-history">
    <div className="attempt-history__heading"><h2>Previous attempts</h2><p className="muted">Revisit saved answers and see where your scores changed.</p></div>
    <div className="attempt-filters">
      <div><span>Subject</span><Select label="Attempt subject" value={subject} onChange={value => { setSubject(value); setResourceId(''); setSelectedId(''); setBaselineId(''); }} options={[{ value: 'all', label: 'All subjects' }, { value: 'personal', label: 'Personal learning' }, ...state.subjects.map(item => ({ value: item.id, label: item.name })), { value: 'unavailable', label: 'Unavailable resources' }]} /></div>
      <div><span>Quiz</span><Select label="Attempt resource" value={group?.id ?? ''} disabled={!filtered.length} onChange={value => { setResourceId(value); setSelectedId(''); setBaselineId(''); }} options={filtered.map(group => ({ value: group.id, label: `${group.resource?.title ?? `Unavailable resource (${group.id})`} · ${group.attempts.length} ${group.attempts.length === 1 ? 'attempt' : 'attempts'}` }))} /></div>
    </div>
    {!current || !summary ? <div className="study-empty"><h3>{state.attempts.length ? 'No attempts match this subject' : 'Your quiz history starts here'}</h3><p>Complete a quiz to save its score, answers and feedback. Each new attempt keeps the previous one.</p><button type="button" className="button button--small" onClick={() => navigate({ kind: 'resources' })}>Open resources</button></div> : <>
      <div className="attempt-links">{resource ? <button type="button" className="link-button" onClick={() => navigate({ kind: 'resource', resourceId: resource.id })}>Open {resource.title}</button> : <span className="muted">Resource unavailable. Saved answers and feedback are retained.</span>}{resource?.subjectId && state.subjects.some(subject => subject.id === resource.subjectId) ? <button type="button" className="link-button" onClick={() => { if (resource.subjectId) navigate({ kind: 'subject', subjectId: resource.subjectId }); }}>Open subject</button> : null}<button type="button" className="link-button" onClick={() => navigate({ kind: 'review' })}>Open Review</button></div>
      <section aria-labelledby="attempt-trend-title"><div className="study-section-heading"><h2 id="attempt-trend-title">Score history</h2><span className="muted">Oldest first · {state.settings.timeZone}</span></div>
        <div className="attempt-trend" role="region" aria-label="Chronological score history" tabIndex={0}><table><thead><tr><th scope="col">Attempt</th><th scope="col">Saved marks</th><th scope="col">Score</th><th scope="col">Answered</th></tr></thead><tbody>{attempts.map((attempt, i) => { const value = attemptSummary(attempt); return <tr key={attempt.id} className={attempt.id === current.id ? 'is-selected' : ''}><th scope="row"><button type="button" aria-pressed={attempt.id === current.id} onClick={() => chooseAttempt(attempt.id)}><strong>{i + 1}</strong><span>{date(attempt.createdAt)}</span></button></th><td>{number.format(attempt.result.score)} / {number.format(attempt.result.total)}</td><td><div className="attempt-trend__score"><span>{percent(value.percent)}</span>{value.percent !== null ? <progress max={100} value={value.percent} aria-label={`Attempt ${i + 1} normalized score`} /> : null}</div></td><td>{value.answered} / {value.questions}</td></tr>; })}</tbody></table></div>
        <p className="study-caption">Percentages divide saved marks by the saved total. Counts cover saved question IDs. Equal timestamps are ordered by saved ID. Different questions or mark totals can change difficulty; scores alone do not prove improvement.</p>
      </section>
      <section aria-labelledby="attempt-compare-title"><h2 id="attempt-compare-title">Answers and feedback</h2><div className="attempt-filters">
        <div><span>Attempt to review</span><Select label="Attempt to review" value={current.id} onChange={chooseAttempt} options={attempts.map(attempt => ({ value: attempt.id, label: label(attempt) }))} /></div>
        <div><span>Compare with earlier attempt</span><Select label="Earlier attempt" disabled={!earlier.length} value={baseline?.id ?? ''} onChange={setBaselineId} options={earlier.length ? earlier.map(attempt => ({ value: attempt.id, label: label(attempt) })) : [{ value: '', label: 'No earlier attempt' }]} /></div>
      </div>
        <p className="attempt-summary" role="status">{percent(summary.percent)} · {current.result.score} / {current.result.total} marks · {summary.correct} correct · {summary.partial} partial · {summary.incorrect} incorrect · {summary.unanswered} unanswered{summary.ungraded ? ` · ${summary.ungraded} ungraded` : ''}</p>
        {comparison ? <p className="attempt-delta">{comparison.percentagePointChange === null ? 'Score change unavailable.' : Math.abs(comparison.percentagePointChange) < 0.000001 ? 'Same normalized score.' : `${number.format(Math.abs(comparison.percentagePointChange))} percentage points ${comparison.percentagePointChange > 0 ? 'higher' : 'lower'}.`} {comparison.sharedQuestions} shared question IDs.{!comparison.sameQuestionSet || comparison.differentTotal || !comparison.sameMarking ? ' Question sets or mark allocations differ. Compare shared answers individually.' : ''}</p> : <p className="muted">{attempts.length === 1 ? 'One saved attempt so far. Try the quiz again to compare your answers.' : 'This is the earliest saved attempt. Choose a later attempt to compare.'}</p>}
        <p className="attempt-caveat">These records do not include historical question text or grading model details. Desktop and iPhone may use different graders. A shared question ID does not confirm identical wording or marking guidance. Any prompt below is from the current resource.</p>
        <div className="attempt-questions">{questions.length ? questions.map((question, i) => {
          const prompt = resource?.questions.find(item => item.id === question.id)?.prompt;
          const review = state.memories.find(memory => memory.resourceId === current.resourceId && memory.question === prompt && !memory.resolvedAt);
          return <details className="attempt-question" key={`${current.id}:${baseline?.id ?? ''}:${question.id}`} open={i === 0}><summary><span>Question {i + 1}<small>{question.id}</small></span>{question.change ? <span className="attempt-change">{changes[question.change]}{question.repeatedMistake && question.change !== 'repeated-mistake' ? ' · Needs work again' : ''}</span> : <span className="attempt-change">{question.current ? outcomes[question.current.outcome] : ''}</span>}</summary>
            {prompt ? <div className="attempt-prompt"><span>Current prompt</span><Markdown>{prompt}</Markdown></div> : <p className="muted">Historical prompt unavailable. Saved question ID: {question.id}</p>}
            <div className={`attempt-answer-pair${baseline ? '' : ' attempt-answer-pair--single'}`}>{baseline ? <SavedAnswer question={question.previous} label={`Earlier · Attempt ${attempts.findIndex(item => item.id === baseline.id) + 1}`} /> : null}<SavedAnswer question={question.current} label={`Reviewing · Attempt ${index + 1}`} /></div>
            {review ? <button type="button" className="link-button" onClick={() => navigate({ kind: 'review' })}>Review this question</button> : null}
          </details>;
        }) : <p className="muted">This saved attempt has no question-level answers or feedback.</p>}</div>
      </section>
    </>}
  </div>;
}
