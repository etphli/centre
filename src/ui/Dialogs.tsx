import { Select } from './Select';
import { useId, useState, type FormEvent } from 'react';
import { api } from '../data/client';
import { getTestSections } from '../../shared/test-paper';
import type { Resource } from '../../shared/schema';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { todayKey } from './format';

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
      'Marked done',
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
          <button type="submit" form="feedback-form" className="button button--primary" disabled={busy}>{busy ? 'Saving' : 'Save and mark done'}</button>
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

export function EventDialog({ initialDate, onClose }: { initialDate?: string; onClose: () => void }) {
  const { state, act, route } = useApp();
  const routeSubject = route.kind === 'subject' || route.kind === 'topic' ? route.subjectId : '';
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(initialDate ?? todayKey());
  const [time, setTime] = useState('');
  const [subjectId, setSubjectId] = useState(routeSubject);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError('Give the event a title.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Pick a date.');
    setBusy(true);
    setError(null);
    const created = await act(
      () => api.createEvent({ title: title.trim(), date, ...(time ? { time } : {}), ...(subjectId ? { subjectId } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) }),
      'Added to your calendar',
    );
    setBusy(false);
    if (created) onClose();
    else setError('The event wasn’t saved. Check the details and try again.');
  }

  return (
    <Dialog
      title="New event"
      size="sm"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="event-form" className="button button--primary" disabled={busy}>{busy ? 'Adding' : 'Add event'}</button>
        </>
      }
    >
      <form id="event-form" className="form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field__label">Title</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Revise organic chemistry" />
        </label>
        <div className="form__row">
          <label className="field">
            <span className="field__label">Date</span>
            <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Time <span className="field__optional">optional</span></span>
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span className="field__label">Subject <span className="field__optional">optional</span></span>
          <Select value={subjectId} onChange={setSubjectId} label="Subject" options={[{ value:'',label:'No subject' },...state.subjects.map(subject => ({ value:subject.id,label:subject.name }))]} />
        </label>
        <label className="field">
          <span className="field__label">Notes <span className="field__optional">optional</span></span>
          <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {error ? <p className="form__error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}
