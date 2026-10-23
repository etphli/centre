import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PendingQuestion } from '../../shared/schema';
import { api } from '../data/client';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { errorMessage } from './format';
import './questions.css';

export function QuestionDialog({ request }: { request:PendingQuestion }) {
  const { state,refresh,cancel } = useApp();
  const [index,setIndex] = useState(0);
  const [answers,setAnswers] = useState<Record<string,string>>({});
  const [custom,setCustom] = useState<Record<string,boolean>>({});
  const [drafts,setDrafts] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const question = request.questions[index];
  useEffect(() => {
    const frame = requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('input,textarea')?.focus());
    return () => cancelAnimationFrame(frame);
  },[index]);
  if (!question) return null;
  const textOnly = question.options.length === 0;
  const final = index === request.questions.length - 1;
  const title = state.chats.find(chat => chat.id === request.chatId)?.title ?? 'Your chat';

  async function stop() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { await cancel(request.chatId); await refresh(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (submitting.current || !question || !answers[question.id]?.trim()) return;
    if (!final) { setIndex(value => value + 1); return; }
    submitting.current = true; setBusy(true); setError('');
    try { await api.answerQuestion(request.id,answers); await refresh(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <Dialog title="A quick question" description={title} onClose={() => void stop()} dismissible={false} className="question-dialog">
    <form ref={form} onSubmit={event => void submit(event)}>
      <div className="question-dialog__progress" aria-label={`Question ${index + 1} of ${request.questions.length}`}>
        <span>{question.header}</span><span>{index + 1} of {request.questions.length}</span>
      </div>
      <fieldset disabled={busy} className="question-dialog__choices">
        <legend>{question.question}</legend>
        {question.options.map((option,optionIndex) => <label key={option.label} className="question-choice">
          <input data-autofocus={optionIndex === 0 ? true : undefined} type="radio" name={question.id} checked={!custom[question.id] && answers[question.id] === option.label} onChange={() => { setCustom(values => ({...values,[question.id]:false})); setAnswers(values => ({...values,[question.id]:option.label})); }} />
          <span><span className="question-choice__label">{option.label}</span>{option.description ? <span className="question-choice__description">{option.description}</span> : null}</span>
        </label>)}
        <label className={textOnly ? 'question-dialog__custom-label' : 'question-choice'}>
          {!textOnly ? <input type="radio" name={question.id} checked={custom[question.id] ?? false} onChange={() => { setCustom(values => ({...values,[question.id]:true})); setAnswers(values => ({...values,[question.id]:drafts[question.id] ?? ''})); }} /> : null}
          <span>{textOnly ? 'Your answer' : 'Something else'}</span>
        </label>
        {textOnly || custom[question.id] ? <textarea key={question.id} autoFocus={!textOnly} aria-label="Your answer" placeholder="Type your answer…" maxLength={4000} rows={3} value={drafts[question.id] ?? ''} onChange={event => { const value = event.target.value; setDrafts(values => ({...values,[question.id]:value})); setAnswers(values => ({...values,[question.id]:value})); }} /> : null}
      </fieldset>
      {error ? <p className="form__error" role="alert">{error}</p> : null}
      <div className="question-dialog__footer">
        <button type="button" className="button button--quiet" disabled={busy} onClick={() => void stop()}>Stop response</button>
        <div>{index > 0 ? <button type="button" className="button button--quiet" disabled={busy} onClick={() => setIndex(value => value - 1)}>Back</button> : null}<button type="submit" className="button button--primary" disabled={busy || !answers[question.id]?.trim()}>{busy ? 'Saving…' : final ? 'Send answer' : 'Next'}</button></div>
      </div>
    </form>
  </Dialog>;
}
