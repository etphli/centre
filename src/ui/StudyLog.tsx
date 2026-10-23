import { Temporal } from '@js-temporal/polyfill';
import { ChevronLeft, ChevronRight, Clock3, Pause, Play, Plus, Square, Timer } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../data/client';
import { useStudyClock, useStudyLog } from '../data/useStudyLog';
import { DEFAULT_TIMER_MINUTES, MAX_TIMER_MINUTES, TIMER_STEP_MINUTES, timerRemainingMs, clipSegments, durationMs, localStudyInstant, sessionSegments, shiftStudyDate, studyDayBounds, weekStartAt, weeklyStudy, type StudySession, type StudySegment } from '../../shared/study-log';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { Select } from './Select';
import { DateTimeField, DurationField } from './DateTimeField';
import { formatDurationMinutes } from '../../shared/date-time-fields';
import './study-log.css';

export function studyHours(ms: number): string { return formatDurationMinutes(ms / 60000); }
function chartHours(ms: number): string { return ms >= 3600000 ? `${new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 }).format(ms / 3600000)} h` : studyHours(ms); }
function stopwatch(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function localInput(instant: string, timeZone: string) { return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDateTime().toString(); }
function dateLabel(date: string) { return Temporal.PlainDate.from(date).toLocaleString('en-AU', { day: 'numeric', month: 'short' }); }
const pauseReasons = { user: 'Paused', idle: 'Paused after 10 minutes without interaction', recovery: 'Recovered paused at the last saved checkpoint', 'check-in': 'Paused after 60 minutes. Check in to continue', clock: 'Paused because the computer clock moved backwards' };

export function StudyEntryDialog({ mode, session, onClose }: { mode: 'timer' | 'manual' | 'edit'; session?: StudySession; onClose: () => void }) {
  const { state } = useApp();
  const { run, busy, error } = useStudyLog();
  const [id] = useState(() => crypto.randomUUID());
  const timeZone = session?.timeZone ?? state.settings.timeZone;
  const [subjectId, setSubject] = useState(session?.subjectId ?? '');
  const [taskId, setTask] = useState(session?.taskId ?? '');
  const [title, setTitle] = useState(session?.title ?? '');
  const [notes, setNotes] = useState(session?.notes ?? '');
  const [minutes, setMinutes] = useState(DEFAULT_TIMER_MINUTES);
  const [problem, setProblem] = useState('');
  const [intervals, setIntervals] = useState(() => {
    const end = Math.floor(Date.now() / 60000) * 60000;
    return (session?.segments.length ? session.segments : [{ start: new Date(end - 3600000).toISOString(), end: new Date(end).toISOString() }]).map(segment => ({ start: localInput(segment.start, timeZone), end: localInput(segment.end, timeZone), original: segment }));
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setProblem('');
    try {
      const tags = { subjectId: subjectId || null, taskId: taskId || null, title: mode === 'timer' ? title.trim() || 'Study session' : title, notes, timeZone };
      let segments: StudySegment[] = [];
      if (mode !== 'timer') segments = intervals.map(interval => {
        const convert = (value: string, original: string) => Temporal.PlainDateTime.from(value).equals(Temporal.PlainDateTime.from(localInput(original, timeZone))) ? original : localStudyInstant(value.slice(0, 10), value.slice(11), timeZone);
        return { start: convert(interval.start, interval.original.start), end: convert(interval.end, interval.original.end) };
      });
      const saved = await run(() => mode === 'timer' ? api.startStudy({ id, ...tags, targetMinutes: minutes }) : mode === 'edit' && session ? api.editStudy(session.id, { ...tags, segments, expectedRevision: session.revision }) : api.createStudy({ id, ...tags, segments }));
      if (saved) onClose();
    } catch (failure) { setProblem(failure instanceof RangeError ? 'This local time is ambiguous or does not exist because of a clock change. Choose another time.' : failure instanceof Error ? failure.message : 'Check the study times.'); }
  };
  const fields = <>
      <label>{mode === 'timer' ? 'What are you studying?' : 'What did you study?'}<input required={mode !== 'timer'} autoFocus={mode !== 'timer'} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder={mode === 'timer' ? 'Study session' : 'e.g. Quadratic equations'} /></label>
      <div className="study-form__pair">
        <div className="study-form__field"><span>Subject</span><Select label="Subject" value={subjectId} onChange={value => { setSubject(value); setTask(''); }} options={[{ value: '', label: 'Personal study' }, ...state.subjects.map(subject => ({ value: subject.id, label: subject.name })), ...(subjectId && !state.subjects.some(subject => subject.id === subjectId) ? [{ value: subjectId, label: 'Unavailable subject' }] : [])]} /></div>
        <div className="study-form__field"><span>Task <span className="muted">optional</span></span><Select label="Task" value={taskId} onChange={setTask} options={[{ value: '', label: 'No linked task' }, ...state.assignments.filter(task => !subjectId || task.subjectId === subjectId).map(task => ({ value: task.id, label: task.title })), ...(taskId && !state.assignments.some(task => task.id === taskId) ? [{ value: taskId, label: 'Unavailable task' }] : [])]} /></div>
      </div>
      {mode !== 'timer' ? <fieldset><legend>Actual study intervals</legend>{intervals.map((interval, index) => <div className="study-form__interval" key={index}>
        <DateTimeField label={`Start${intervals.length > 1 ? ` ${index + 1}` : ''}`} value={interval.start} onChange={start => setIntervals(values => values.map((value, i) => i === index ? { ...value, start } : value))} />
        <DateTimeField label={`End${intervals.length > 1 ? ` ${index + 1}` : ''}`} value={interval.end} onChange={end => setIntervals(values => values.map((value, i) => i === index ? { ...value, end } : value))} />
        {intervals.length > 1 ? <button type="button" className="link-button" aria-label={`Remove interval ${index + 1}`} onClick={() => setIntervals(values => values.filter((_, i) => i !== index))}>Remove</button> : null}
      </div>)}<p className="muted">Only these intervals count. Gaps between them stay excluded.</p></fieldset> : null}
      <label>Notes <span className="muted">optional</span><textarea rows={3} maxLength={10000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
  </>;
  return <Dialog title={mode === 'timer' ? 'Start timer' : mode === 'edit' ? 'Edit study entry' : 'Add study time'} description={mode === 'timer' ? 'Choose your study time. The countdown stays in the top bar.' : `Record actual study in ${timeZone}. For overnight study, choose the following day as the end date.`} onClose={onClose} dismissible={!busy}>
    <form className="study-form" onSubmit={submit}>
      {mode === 'timer' ? <>
        <div className="study-countdown" role="group" aria-label="Timer duration">
          <button type="button" className="button" aria-label="Decrease timer by 5 minutes" disabled={busy || minutes <= TIMER_STEP_MINUTES} onClick={() => setMinutes(value => value - TIMER_STEP_MINUTES)}>−5 min</button>
          <output aria-live="polite" aria-label="Timer duration">{minutes}<span>minutes</span></output>
          <button type="button" className="button" aria-label="Increase timer by 5 minutes" disabled={busy || minutes >= MAX_TIMER_MINUTES} onClick={() => setMinutes(value => value + TIMER_STEP_MINUTES)}>+5 min</button>
        </div>
        <details className="study-form__details"><summary>Study details <span className="muted">optional</span></summary><div className="study-form">{fields}</div></details>
        <p className="study-form__help">Pauses are excluded. Centre pauses after 10 minutes without interaction. After closing or sleep, resume to continue.</p>
      </> : fields}
      {problem || error ? <p role="alert" className="study-error">{problem || error}</p> : null}
      <div className="study-form__actions"><button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>Cancel</button><button className="button button--primary" disabled={busy}>{busy ? 'Saving…' : mode === 'timer' ? 'Start timer' : 'Save study time'}</button></div>
    </form>
  </Dialog>;
}

export function StudyLogActionNavigation() {
  const { actionRequest } = useStudyLog();
  const { navigate } = useApp();
  useEffect(() => {
    if (actionRequest && actionRequest.mode !== 'timer') navigate({ kind: 'log' });
  }, [actionRequest, navigate]);
  return null;
}

export function StudyTimer() {
  const { log, busy, ready, error, command, actionRequest, acknowledgeAction } = useStudyLog();
  const { navigate } = useApp();
  const now = useStudyClock();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(false);
  const active = log.sessions.find(session => !session.deletedAt && session.state.kind !== 'completed');
  const running = active?.state.kind === 'running';
  const remaining = active ? timerRemainingMs(active, now) : null;
  const readout = active ? remaining ?? durationMs(sessionSegments(active, now)) : 0;
  const control = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (actionRequest?.mode !== 'timer' || !ready || busy) return;
    setOpen(Boolean(active)); control.current?.focus(); acknowledgeAction(actionRequest.id);
  }, [actionRequest, ready, busy, active, acknowledgeAction]);
  return <div className="study-timer">
    {active ? <>
      <button ref={control} type="button" className={`study-timer__readout${running ? ' is-running' : ''}`} aria-expanded={open} aria-label={`Study timer: ${running ? 'running' : 'paused'}, ${studyHours(readout)}${remaining === null ? ' elapsed' : ' remaining'}, ${active.title}`} onClick={() => setOpen(value => !value)}><Timer size={15} aria-hidden /><span>{stopwatch(remaining === null ? readout : Math.ceil(readout / 1000) * 1000)}</span>{!running ? <span>Paused</span> : null}</button>
      <button type="button" className="icon-button" aria-label={running ? 'Pause study timer' : 'Resume study timer'} disabled={busy} onClick={() => void command(running ? 'pause' : 'resume')}>{running ? <Pause size={14} /> : <Play size={14} />}</button>
      <button type="button" className="icon-button" aria-label="Stop and save study timer" disabled={busy} onClick={() => void command('stop')}><Square size={13} /></button>
      {open ? <div className="study-timer__panel">
        <strong>{active.title}</strong><p role="status">{active.state.kind === 'paused' ? pauseReasons[active.state.reason] : 'Studying. Pauses and closed-app time are excluded.'}</p>
        {running ? <button type="button" className="button button--small" disabled={busy} onClick={() => void command('confirm')}>Still studying</button> : null}
        <button type="button" className="link-button" onClick={() => { navigate({ kind: 'log' }); setOpen(false); }}>Open Log</button><button type="button" className="link-button" onClick={() => setOpen(false)}>Close timer details</button>
      </div> : null}
    </> : <button ref={control} type="button" className="button button--quiet button--small" disabled={!ready || busy} onClick={() => setStart(true)}><Timer size={15} aria-hidden />Start timer</button>}
    {error ? <button type="button" className="study-timer__error" aria-label={`Study timer error: ${error}`} onClick={() => { navigate({ kind: 'log' }); setOpen(false); }}>Time not saved</button> : null}
    {start ? <StudyEntryDialog mode="timer" onClose={() => setStart(false)} /> : null}
  </div>;
}

export function StudyLogPage() {
  const { state, navigate } = useApp();
  const { log, ready, busy, error, run, command, actionRequest, acknowledgeAction } = useStudyLog();
  const now = useStudyClock();
  const timeZone = state.settings.timeZone;
  const currentWeek = weekStartAt(now, timeZone);
  const [selected, setSelected] = useState<string | null>(null);
  const week = selected ?? currentWeek;
  const summary = useRef<HTMLHeadingElement>(null);
  const [dialog, setDialog] = useState<'manual' | 'timer' | StudySession | null>(null);
  const [deleting, setDeleting] = useState<StudySession | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalMinutes, setGoalMinutes] = useState(600);
  useEffect(() => {
    if (!actionRequest || actionRequest.mode === 'timer' || !ready) return;
    setSelected(null);
    if (actionRequest.mode === 'manual') setDialog('manual');
    else summary.current?.focus();
    acknowledgeAction(actionRequest.id);
  }, [actionRequest, ready, acknowledgeAction]);
  const [goalId, setGoalId] = useState<string>(() => crypto.randomUUID());
  const result = weeklyStudy(log.sessions, week, timeZone, now);
  const active = log.sessions.find(session => !session.deletedAt && session.state.kind !== 'completed');
  const goal = log.goals.find(goal => !goal.deletedAt && goal.weekStart === week && goal.timeZone === timeZone);
  const targetMs = (goal?.targetMinutes ?? 0) * 60000;
  const weeks = Array.from({ length: 8 }, (_, index) => {
    const start = shiftStudyDate(currentWeek, (index - 7) * 7);
    return { start, total: weeklyStudy(log.sessions, start, timeZone, now).durationMs };
  });
  const max = Math.max(3600000, ...weeks.map(value => value.total));
  const maxDay = Math.max(3600000, ...result.days.map(day => day.durationMs));
  const subjectName = (id: string | null) => id ? state.subjects.find(subject => subject.id === id)?.name ?? 'Unavailable subject' : 'Personal study';
  const openAim = () => { setGoalMinutes(goal?.targetMinutes ?? 600); setGoalId(goal?.id ?? crypto.randomUUID()); setGoalOpen(true); };
  const inWeek = (session: StudySession) => {
    const start = studyDayBounds(week, timeZone).start, end = studyDayBounds(shiftStudyDate(week, 7), timeZone).start;
    return result.entries.some(entry => entry.id === session.id) || (session.segments.length === 0 && Date.parse(session.createdAt) >= start && Date.parse(session.createdAt) < end);
  };
  const entryTime = (session: StudySession) => durationMs(clipSegments(sessionSegments(session, now), studyDayBounds(week, timeZone).start, studyDayBounds(shiftStudyDate(week, 7), timeZone).start));
  const entries = log.sessions.filter(session => !session.deletedAt && inWeek(session)).sort((a, b) => (b.segments[0]?.start ?? b.createdAt).localeCompare(a.segments[0]?.start ?? a.createdAt));
  return <div className="page page--log">
    <header className="page__header study-heading"><div><h1 className="page__title">Log</h1><p className="page__lede">The time you actually spent studying.</p></div><button type="button" className="button" disabled={!ready || busy} onClick={() => setDialog('manual')}><Plus size={14} aria-hidden />Add study time</button></header>
    {error ? <p role="alert" className="study-error">{error}</p> : null}
    {!ready ? <div><p role="status">{error ? 'Study log could not load.' : 'Loading your study log…'}</p>{error ? <button type="button" className="button" disabled={busy} onClick={() => void run(api.studyLog)}>Retry study log</button> : null}</div> : <>
      {active ? <section className="study-active" aria-label="Current study session"><div><strong>{active.title}</strong><p role="status">{active.state.kind === 'paused' ? pauseReasons[active.state.reason] : 'Timer running'} · {studyHours(durationMs(sessionSegments(active, now)))}</p></div><div className="study-actions"><button type="button" className="button button--small" disabled={busy} onClick={() => void command(active.state.kind === 'running' ? 'pause' : 'resume')}>{active.state.kind === 'running' ? 'Pause' : 'Resume'}</button><button type="button" className="button button--small" disabled={busy} onClick={() => void command('stop')}>Stop and save</button></div></section> : null}
      <section className="study-history" aria-labelledby="study-history-title"><div className="study-section-heading"><h2 id="study-history-title">Weekly study hours</h2><span className="muted">Last 8 weeks</span></div><div className="study-week-chart">{weeks.map(value => <button key={value.start} type="button" className={`study-week-chart__column${week === value.start ? ' is-selected' : ''}`} aria-pressed={week === value.start} aria-label={`Week of ${dateLabel(value.start)}: ${studyHours(value.total)}`} onClick={() => setSelected(value.start)}><span className="study-week-chart__value" aria-hidden>{value.total ? chartHours(value.total) : ''}</span><span className="study-week-chart__track"><span style={{ height: `${value.total / max * 100}%` }} /></span><span>{dateLabel(value.start)}</span></button>)}</div><p className="study-caption">Actual time only. Planned Calendar sessions do not count. Select a week for its details.</p></section>
      <section aria-labelledby="study-week-title"><div className="study-section-heading"><div className="study-week-nav"><button type="button" className="icon-button" aria-label="Previous week" onClick={() => setSelected(shiftStudyDate(week, -7))}><ChevronLeft size={16} /></button><h2 ref={summary} tabIndex={-1} id="study-week-title">{week === currentWeek ? 'This week' : 'Week'} <span className="muted">{dateLabel(week)} – {dateLabel(shiftStudyDate(week, 6))}</span></h2><button type="button" className="icon-button" aria-label="Next week" onClick={() => setSelected(shiftStudyDate(week, 7))}><ChevronRight size={16} /></button>{week !== currentWeek ? <button type="button" className="link-button" onClick={() => setSelected(null)}>This week</button> : null}</div><span className="study-zone">{timeZone} · Monday start</span></div>
        <div className="study-overview"><div className="study-aim"><div className="study-aim__total">{studyHours(result.durationMs)} <span>studied</span></div>{goal ? <><p>{Math.round(result.durationMs / targetMs * 100)}% of your {studyHours(targetMs)} weekly aim</p><progress max={targetMs} value={Math.min(result.durationMs, targetMs)} aria-label="Weekly study aim progress" /><p className="muted">{result.durationMs >= targetMs ? 'Weekly aim reached.' : `${studyHours(targetMs - result.durationMs)} to reach your aim.`}</p></> : <p className="muted">Set a weekly aim to see your progress.</p>}<button type="button" className="button button--small" onClick={openAim}>{goal ? 'Edit weekly aim' : 'Set weekly aim'}</button></div>
        <div className="study-days" role="group" aria-label={`Daily actual study, total ${studyHours(result.durationMs)}`}>{result.days.map(day => <div className="study-days__day" key={day.date} role="img" aria-label={`${Temporal.PlainDate.from(day.date).toLocaleString('en-AU', { weekday: 'long' })}: ${studyHours(day.durationMs)}`}><span className="study-days__value" aria-hidden>{day.durationMs ? chartHours(day.durationMs) : ''}</span><div className="study-days__track" aria-hidden><span style={{ height: `${day.durationMs / maxDay * 100}%` }} /></div><span>{Temporal.PlainDate.from(day.date).toLocaleString('en-AU', { weekday: 'short' })}</span></div>)}</div></div>
      </section>
      <section className="study-subjects" aria-labelledby="study-subject-title"><h2 id="study-subject-title">By subject</h2>{result.subjects.length ? <ul>{result.subjects.sort((a, b) => b.durationMs - a.durationMs).map(subject => <li key={subject.subjectId ?? 'personal'}><span>{subjectName(subject.subjectId)}</span><div className="study-subjects__track" aria-hidden><span style={{ width: `${result.durationMs ? subject.durationMs / result.durationMs * 100 : 0}%` }} /></div><span>{studyHours(subject.durationMs)}</span></li>)}</ul> : <p className="muted">Your subject breakdown will appear after you log study time.</p>}</section>
      <section className="study-entries" aria-labelledby="study-entry-title"><div className="study-section-heading"><h2 id="study-entry-title">Study entries <span className="muted">{entries.length}</span></h2>{!active ? <button type="button" className="link-button" onClick={() => setDialog('timer')}><Play size={13} aria-hidden />Start timer</button> : null}</div>
        {entries.length ? <ul>{entries.map(session => <li key={session.id}><div className="study-entry__body"><strong>{session.title}</strong><p>{subjectName(session.subjectId)}{session.taskId ? ` · ${state.assignments.find(task => task.id === session.taskId)?.title ?? 'Linked task'}` : ''}</p><p className="muted">{Temporal.Instant.from(session.segments[0]?.start ?? session.createdAt).toZonedDateTimeISO(timeZone).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {session.source === 'manual' ? 'Manual entry' : 'Timer'}{session.state.kind !== 'completed' ? ` · ${session.state.kind}` : ''}</p>{session.notes ? <p className="study-entry__notes">{session.notes}</p> : null}</div><div className="study-entry__end"><span>{studyHours(entryTime(session))}{entryTime(session) !== durationMs(sessionSegments(session, now)) ? ' this week' : ''}</span>{session.state.kind === 'completed' ? <div className="study-actions"><button type="button" className="button button--quiet button--small" aria-label={`Edit ${session.title}`} onClick={() => setDialog(session)}>Edit</button><button type="button" className="button button--quiet button--small" aria-label={`Delete ${session.title}`} onClick={() => setDeleting(session)}>Delete</button></div> : null}</div></li>)}</ul> : <div className="study-empty"><Clock3 size={24} strokeWidth={1.3} aria-hidden /><h3>No study logged for this week</h3><p>Start the timer while you study, or add time spent away from your computer.</p><button type="button" className="button button--small" onClick={() => setDialog('manual')}>Add study time</button><button type="button" className="link-button" onClick={() => navigate({ kind: 'calendar' })}>Plan study in Calendar</button></div>}
      </section>
    </>}
    {dialog ? <StudyEntryDialog mode={typeof dialog === 'string' ? dialog : 'edit'} session={typeof dialog === 'string' ? undefined : dialog} onClose={() => setDialog(null)} /> : null}
    {deleting ? <Dialog title="Delete study entry?" description={`Remove “${deleting.title}” and its time from your totals?`} onClose={() => setDeleting(null)}><div className="study-form__actions"><button type="button" className="button button--quiet" onClick={() => setDeleting(null)}>Cancel</button><button type="button" className="button" disabled={busy} onClick={async () => { if (await run(() => api.deleteStudy(deleting.id, deleting.revision))) setDeleting(null); }}>Delete study entry</button></div>{error ? <p role="alert" className="study-error">{error}</p> : null}</Dialog> : null}
    {goalOpen ? <Dialog title="Weekly study aim" description={`For ${dateLabel(week)} to ${dateLabel(shiftStudyDate(week, 6))} in ${timeZone}. Each week has its own aim.`} onClose={() => setGoalOpen(false)}><form className="study-form" onSubmit={async event => { event.preventDefault(); if (await run(() => api.saveStudyGoal({ id: goalId, weekStart: week, timeZone, targetMinutes: goalMinutes, ...(goal ? { expectedRevision: goal.revision } : {}) }))) setGoalOpen(false); }}><DurationField label="Study this week" value={goalMinutes} onChange={setGoalMinutes} /><div className="study-form__actions"><button type="button" className="button button--quiet" onClick={() => setGoalOpen(false)}>Cancel</button><button className="button button--primary" disabled={busy}>Save weekly aim</button></div>{error ? <p role="alert" className="study-error">{error}</p> : null}</form></Dialog> : null}
  </div>;
}
