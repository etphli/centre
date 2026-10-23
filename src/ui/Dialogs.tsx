import { Select } from './Select';
import { Temporal } from '@js-temporal/polyfill';
import { useId, useState, type FormEvent } from 'react';
import { api } from '../data/client';
import { getTestSections } from '../../shared/test-paper';
import type { Resource, StudyEvent } from '../../shared/schema';
import { calendarTimeKey, calendarTodayKey } from '../../shared/calendar-time';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { DateField, DurationField, TimeField } from './DateTimeField';

export function FeedbackDialog({ resource, initialQuestionIds = [], onClose }: { resource: Resource; initialQuestionIds?: string[]; onClose: () => void }) {
  const { act } = useApp();
  const [notes, setNotes] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(initialQuestionIds));
  const [confident, setConfident] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notesId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confident && !notes.trim()) {
      setError('Write a sentence about how it went. Centre uses it to plan what to review.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await act(
      () => (confident ? api.saveFeedback(resource.id, '', [], true) : api.saveFeedback(resource.id, notes.trim(), [...selected])),
      resource.completedAt ? 'Reflection saved' : 'Marked done',
    );
    setBusy(false);
    if (result) onClose();
    else setError('Saving didn’t work. Your reflection is still here.');
  }

  return (
    <Dialog
      title={resource.completedAt ? 'Add a reflection' : 'Mark as done'}
      description={resource.title}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="feedback-form" className="button button--primary" disabled={busy}>{busy ? 'Saving' : resource.completedAt ? 'Save reflection' : 'Save and mark done'}</button>
        </>
      }
    >
      <form id="feedback-form" className="form" onSubmit={(event) => void submit(event)}>
        <label className="check check--confident">
          <input type="checkbox" checked={confident} onChange={(event) => setConfident(event.target.checked)} />
          <span className="check__text">Nothing to review. I&rsquo;m confident with all of it.</span>
        </label>
        <label className="field" htmlFor={notesId}>
          <span className="field__label">How did it go?</span>
        </label>
        <textarea id={notesId} data-autofocus rows={4} value={notes} disabled={confident} onChange={(event) => setNotes(event.target.value)} placeholder="Ran out of time on the long answers. Integration by parts still feels shaky." />
        {resource.questions.length && !confident ? (
          <fieldset className="field">
            <legend className="field__label">Which questions gave you trouble?</legend>
            <ul className="check-list">
              {(resource.kind === 'test' ? getTestSections(resource.questions).flatMap(section => section.questions) : resource.questions).map((question, index) => (
                <li key={question.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.has(question.id)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(question.id);
                          else next.delete(question.id);
                          return next;
                        })
                      }
                    />
                    <span className="check__text"><span className="check__number">{index + 1}.</span> {question.prompt}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null}
        {error ? <p className="form__error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

export function EventDialog({ initialDate, initialEvent, onClose }: { initialDate?: string; initialEvent?: StudyEvent; onClose: () => void }) {
  const { state, refresh, notify, route } = useApp();
  const routeSubject = route.kind === 'subject' || route.kind === 'topic' ? route.subjectId : '';
  const localStart = initialEvent?.startAt ? Temporal.Instant.from(initialEvent.startAt).toZonedDateTimeISO(state.settings.timeZone) : null;
  const [title, setTitle] = useState(initialEvent?.title ?? '');
  const [date, setDate] = useState(localStart?.toPlainDate().toString() ?? initialEvent?.date ?? initialDate ?? calendarTodayKey(state.settings.timeZone));
  const initialLocalDate = localStart?.toPlainDate().toString() ?? initialEvent?.date;
  const initialLocalTime = localStart ? calendarTimeKey(localStart.toPlainTime()) : initialEvent?.time;
  const [time, setTime] = useState(initialLocalTime ?? '16:00');
  const [duration, setDuration] = useState(initialEvent?.plannedDurationMinutes ?? 45);
  const [allDay,setAllDay] = useState(initialEvent?.kind === 'deadline');
  const [subjectId, setSubjectId] = useState(initialEvent?.subjectId ?? routeSubject);
  const [notes, setNotes] = useState(initialEvent?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError('Give the event a title.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Pick a date.');
    setBusy(true);
    setError(null);
    try {
      const input = {title:title.trim(),date,time:allDay ? null : time,plannedDurationMinutes:allDay ? null : duration,subjectId:subjectId || null,notes:notes.trim()};
      if (initialEvent) {
        const {date:nextDate,time:nextTime,...fields} = input;
        await api.updateEvent(initialEvent.id,{...fields,...(nextDate === initialLocalDate && nextTime === initialLocalTime ? {} : {date:nextDate,time:nextTime}),expectedRevision:initialEvent.revision});
      }
      else await api.createEvent(input);
      await refresh().catch(() => undefined);
      notify({tone:'success',message:initialEvent ? 'Updated your calendar' : 'Added to your calendar'});
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The event could not be saved.'); }
    finally { setBusy(false); }
  }

  return (
    <Dialog
      title={initialEvent ? 'Edit study session' : 'New event'}
      description={`Times use ${state.settings.timeZone}. Planned study time does not add Log hours.`}
      size="sm"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="event-form" className="button button--primary" disabled={busy}>{busy ? 'Saving' : initialEvent ? 'Save changes' : 'Add event'}</button>
        </>
      }
    >
      <form id="event-form" className="form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className="calendar-editor-fields">
        <label className="field">
          <span className="field__label">Title</span>
          <input autoFocus required maxLength={200} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Revise organic chemistry" />
        </label>
        {!initialEvent || initialEvent.kind === 'deadline' ? <label className="check"><input type="checkbox" checked={allDay} onChange={event => setAllDay(event.target.checked)} /><span>All-day deadline</span></label> : null}
        <div className="form__row">
          <div className="field">
            <span className="field__label">Date</span>
            <DateField label="Date" value={date} onChange={setDate} />
          </div>
          {!allDay ? <div className="field">
            <span className="field__label">Start time</span>
            <TimeField label="Start time" value={time} onChange={minute => setTime(current => minute === current.slice(0,5) ? current : minute)} />
          </div> : null}
        </div>
        {!allDay ? <DurationField label="Planned duration" value={duration} onChange={setDuration} min={5} max={720} /> : null}
        <label className="field">
          <span className="field__label">Subject <span className="field__optional">optional</span></span>
          <Select value={subjectId} onChange={setSubjectId} label="Subject" options={[{ value:'',label:'No subject' },...state.subjects.map(subject => ({ value:subject.id,label:subject.name }))]} />
        </label>
        <label className="field">
          <span className="field__label">Notes <span className="field__optional">optional</span></span>
          <textarea rows={2} maxLength={20000} disabled={busy} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        </fieldset>
        {error ? <p className="form__error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

export const sessionRemovalDescription = 'Remove archives this session in Organato. Your Log and other assignments stay unchanged.';

export function RemoveEventDialog({event,onClose}:{event:StudyEvent;onClose:()=>void}) {
  const {refresh,notify} = useApp();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  async function remove() {
    setBusy(true); setError(null);
    try {
      await api.archiveEvent(event.id,event.revision);
      await refresh().catch(() => undefined);
      notify({tone:'success',message:'Removed the planned study session'}); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The session could not be removed.'); }
    finally { setBusy(false); }
  }
  return <Dialog title="Remove study session?" description={event.title} size="sm" onClose={onClose} dismissible={!busy} footer={<><button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>Keep session</button><button type="button" className="button calendar-remove-confirm" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing' : 'Remove session'}</button></>}>
    <p>{sessionRemovalDescription}</p>
    {error ? <p className="form__error" role="alert">{error}</p> : null}
  </Dialog>;
}
