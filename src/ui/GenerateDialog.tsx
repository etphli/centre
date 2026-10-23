import { Select } from './Select';
import { QuestionTypes, responseTypes } from './QuestionTypes';
import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../data/client';
import type { CreateResource, ResponseType } from '../../shared/schema';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { addDays, errorMessage, todayKey } from './format';
import { kindIcons, kindLabels } from './icons';
import { routeContext, type GenerateRequest } from './types';
import './generate.css';

type Difficulty = CreateResource['difficulty'];
const difficulties: { value: Difficulty; label: string }[] = [
  { value: 'gentle', label: 'Gentle' },
  { value: 'standard', label: 'Standard' },
  { value: 'challenging', label: 'Challenging' },
];
const NEW_TOPIC = '__new__';
const PERSONAL = '__personal__';

const prompts: Record<GenerateRequest['kind'], { label: string; example: string }> = {
  quiz: { label: 'What should the quiz cover?', example: 'Factorising, exam-style wording' },
  test: { label: 'What should the test cover?', example: 'Last two weeks of class, one long question' },
  flashcards: { label: 'What should the cards cover?', example: 'Key terms and their definitions' },
  diagram: { label: 'What should the diagram show?', example: 'How the graph moves as the gradient changes' },
  notes: { label: 'What should the notes cover?', example: 'A one-page summary with a worked example' },
  plan: { label: 'Anything to plan around?', example: 'Evenings only, skip Fridays' },
};

interface GenerateDialogProps {
  request: GenerateRequest;
  onClose: () => void;
}

export function GenerateDialog({ request, onClose }: GenerateDialogProps) {
  const { state, route, askHere, navigate } = useApp();
  const mounted = useRef(true);
  const settled = useRef(false);
  function restoreAttachments() {
    if (settled.current) return;
    settled.current = true;
    if (request.attachmentIds?.length) window.dispatchEvent(new CustomEvent('centre:restore-attachments',{detail:request.attachmentIds}));
  }
  function dismiss() {
    if (settled.current) return;
    restoreAttachments();
    onClose();
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Strict Mode reconnects effects immediately. A real unmount returns the files.
      queueMicrotask(() => { if (!mounted.current) restoreAttachments(); });
    };
  }, []);
  const kind = request.kind;
  const isPlan = kind === 'plan';
  const countable = kind === 'quiz' || kind === 'flashcards';
  const assessment = kind === 'quiz' || kind === 'test';
  const context = routeContext(route, state);
  const fallbackSubject = request.subjectId === null ? PERSONAL : request.subjectId ?? context.subjectId ?? state.subjects[0]?.id ?? (isPlan ? '' : PERSONAL);
  const [subjectId, setSubjectId] = useState(fallbackSubject);
  const personal = subjectId === PERSONAL;
  const topics = useMemo(() => state.topics.filter((topic) => topic.subjectId === subjectId), [state.topics, subjectId]);
  const preferredTopic = request.topicId ?? (fallbackSubject === context.subjectId ? context.topicId : undefined);
  const initialTopic = preferredTopic && topics.some((topic) => topic.id === preferredTopic) ? preferredTopic : topics[0]?.id ?? (isPlan ? '' : NEW_TOPIC);
  const [topicId, setTopicId] = useState(initialTopic);
  const [newTopic, setNewTopic] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>(state.settings.defaultDifficulty);
  const [count, setCount] = useState(kind === 'test' ? state.settings.defaultTestQuestions : isPlan ? 4 : kind === 'flashcards' ? state.settings.defaultFlashcardCount : state.settings.defaultQuizQuestions);
  const [automaticCards, setAutomaticCards] = useState(state.settings.defaultFlashcardCountMode === 'auto');
  const autoCount = kind === 'flashcards' && automaticCards;
  const [testMode,setTestMode] = useState<'time'|'questions'>(state.settings.defaultTestLengthMode);
  const [duration,setDuration] = useState(state.settings.defaultTestMinutes);
  const [questionTypes,setQuestionTypes] = useState<ResponseType[]>(kind === 'test' ? state.settings.defaultTestQuestionTypes : state.settings.defaultQuizQuestionTypes);
  const [finishBy, setFinishBy] = useState(addDays(todayKey(), 7));
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState(request.instructions ?? '');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { count: useId(), title: useId(), finish: useId(), difficulty: useId(), error: useId() };
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const newTopicRef = useRef<HTMLInputElement>(null);
  const Icon = kindIcons[kind];
  const subject = state.subjects.find((item) => item.id === subjectId);
  const noun = kindLabels[kind].toLowerCase();
  const maxCount = isPlan ? 14 : 30;
  const unit = isPlan ? 'sessions' : kind === 'flashcards' ? 'cards' : 'questions';
  const prompt = prompts[kind];
  const optionsSummary = [
    kind === 'test' ? testMode === 'time' ? `${duration} minutes` : `${count} questions` : autoCount ? 'automatic card count' : countable ? `${Number.isNaN(count) ? '?' : count} ${unit}` : null,
    `${difficulties.find((option) => option.value === difficulty)?.label.toLowerCase()} ${isPlan ? 'pace' : assessment || countable ? 'difficulty' : 'depth'}`,
    !isPlan && title.trim() ? 'custom title' : null,
  ].filter(Boolean).join(', ');

  // Dialog focuses the first field (the subject picker); start where typing happens instead.
  useEffect(() => {
    const frame = requestAnimationFrame(() => (newTopicRef.current ?? promptRef.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  function changeSubject(next: string) {
    setSubjectId(next);
    const first = state.topics.find((topic) => topic.subjectId === next);
    setTopicId(first?.id ?? (isPlan ? '' : NEW_TOPIC));
  }

  async function resolveTopic(): Promise<string | null> {
    if (personal) return null;
    if (topicId !== NEW_TOPIC) return topicId;
    const name = newTopic.trim();
    if (!name) {
      setError('Name the new topic first.');
      return null;
    }
    const topic = await api.createTopic(subjectId, name);
    if (!mounted.current || settled.current) return null;
    setTopicId(topic.id);
    return topic.id;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !mounted.current || settled.current) return;
    setError(null);
    if (!subjectId) {
      setError('Pick a subject.');
      return;
    }
    if (((countable && !autoCount) || isPlan || (kind === 'test' && testMode === 'questions')) && (!Number.isInteger(count) || count < 1 || count > maxCount)) {
      if (countable) setOptionsOpen(true);
      setError(`Choose between 1 and ${maxCount} ${unit}.`);
      return;
    }
    if (kind === 'test' && testMode === 'time' && (!Number.isInteger(duration) || duration < 5 || duration > 180)) { setError('Choose a duration between 5 and 180 minutes.'); return; }
    if (assessment && !questionTypes.length) { setError('Choose at least one question type.'); return; }
    setBusy(true);
    let resolvedTopic: string | null;
    try {
      resolvedTopic = await resolveTopic();
    } catch (failure) {
      if (mounted.current && !settled.current) setError(errorMessage(failure));
      return;
    } finally {
      if (mounted.current && !settled.current) setBusy(false);
    }
    if (!mounted.current || settled.current || (resolvedTopic === null && !personal)) return;
    const topic = state.topics.find((item) => item.id === resolvedTopic);
    const topicName = topic?.name ?? (topicId === NEW_TOPIC ? newTopic.trim() : undefined);
    const subjectName = subject?.name ?? 'this subject';
    const notes = instructions.trim();
    const message = isPlan
      ? [
          `Make me a study plan for ${topicName ? `${subjectName}, topic "${topicName}"` : subjectName}.`,
          `Schedule ${count} study sessions between today and ${finishBy}, at a ${difficulty} pace, and add each session to my calendar as an event.`,
          'Take my upcoming assignments and weak spots into account.',
          notes ? `Notes: ${notes}` : '',
        ].filter(Boolean).join('\n')
      : [
          `Make me a ${noun} ${personal ? "for personal learning outside my subjects. Save without a subject or topic" : `for ${subjectName}, topic "${topicName ?? 'this topic'}"`}.`,
          [
            autoCount ? 'Cards: automatic. Choose how many cards are needed to cover the distinct key concepts in the topic and supplied material, from 1 to 30, without repetition or padding.' : countable ? `${kind === 'flashcards' ? 'Cards' : 'Questions'}: ${count}` : null,
            kind === 'test' ? testMode === 'time' ? `Duration: ${duration} minutes. Choose enough questions to fit this time.` : `Questions: exactly ${count}.` : null,
            assessment ? `Include ${questionTypes.map(type => responseTypes.find(option => option.value === type)?.label.toLowerCase()).join(', ')}. Include each selected type where the question count allows.` : null,
            `${assessment || countable ? 'Difficulty' : 'Depth'}: ${difficulty}`,
            title.trim() ? `Title: ${title.trim()}` : 'Title: choose a short, clear one',
          ].filter(Boolean).map((line) => `- ${line}`).join('\n'),
          notes ? `Focus: ${notes}` : '',
          `Create and save the full ${noun}.`,
        ].filter(Boolean).join('\n\n');
    const chatContext = personal ? {page:'personal-learning'} : { ...routeContext(route, state), subjectId, ...(resolvedTopic ? { topicId: resolvedTopic } : {}) };
    const base = { subjectId:personal ? null : subjectId,topicId:resolvedTopic,instructions:notes,difficulty,...(title.trim() ? {title:title.trim()} : {}) };
    const resourceRequest:CreateResource|undefined = kind === 'plan' ? undefined
      : kind === 'quiz' ? {...base,kind,questionCount:count,questionTypes}
      : kind === 'test' ? {...base,kind,testLength:testMode === 'time' ? {mode:'time',minutes:duration} : {mode:'questions',questionCount:count},questionTypes}
      : kind === 'flashcards' ? {...base,kind,questionCount:autoCount ? 'auto' : count}
      : {...base,kind};
    settled.current = true;
    onClose();
    // Stays on the current page: the request goes to the open chat, the side chat, or a new chat from home.
    askHere(message, chatContext,request.attachmentIds,resourceRequest);
  }

  if (isPlan && state.subjects.length === 0) {
    return (
      <Dialog title={`New ${noun}`} onClose={dismiss} size="sm" className="gen-dialog">
        <p className="muted">Centre makes resources inside your subjects, and your subjects come from Organato. Connect Organato to bring them in.</p>
        <div className="dialog__footer dialog__footer--inline">
          <button type="button" className="button button--quiet button--small" onClick={dismiss}>Not now</button>
          <button type="button" className="button button--primary button--small" onClick={() => { dismiss(); navigate({ kind: 'settings' }); }}>Connect Organato</button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={isPlan ? 'Plan study sessions' : `New ${noun}`}
      onClose={dismiss}
      className="gen-dialog"
      footer={
        <>
          <button type="button" className="button button--quiet button--small" onClick={dismiss}>Cancel</button>
          <button type="submit" form="generate-form" className="button button--primary button--small" disabled={busy}>
            {isPlan ? 'Make plan' : `Make ${noun}`}
          </button>
        </>
      }
    >
      <form id="generate-form" className="gen" onSubmit={(event) => void onSubmit(event)}>
        <fieldset className="gen__fields" disabled={busy}>
          <div className="gen__context">
            <Icon size={15} aria-hidden className="gen__icon" />
            <Select compact value={subjectId} onChange={changeSubject} label="Subject" options={[...state.subjects.map(item => ({ value:item.id,label:item.name })),...(!isPlan ? [{value:PERSONAL,label:'Personal learning'}] : [])]} />
            {!personal ? <><span className="gen__sep" aria-hidden>/</span>
            <Select compact value={topicId} onChange={setTopicId} label="Topic" options={[...(isPlan ? [{ value:'',label:'Whole subject' }] : []),...topics.map(topic => ({ value:topic.id,label:topic.name })),{ value:NEW_TOPIC,label:'New topic…' }]} /></> : null}
          </div>
          {!personal && topicId === NEW_TOPIC ? (
            <input
              ref={newTopicRef}
              className="gen__new-topic"
              value={newTopic}
              onChange={(event) => setNewTopic(event.target.value)}
              placeholder="New topic name, for example Quadratic equations"
              aria-label="New topic name"
              autoFocus
            />
          ) : null}

          {isPlan ? (
            <div className="gen__plan">
              <label className="gen__inline">
                <span id={ids.count}>Sessions</span>
                <input type="number" min={1} max={maxCount} value={Number.isNaN(count) ? '' : count} onChange={(event) => setCount(event.target.valueAsNumber)} aria-labelledby={ids.count} />
              </label>
              <label className="gen__inline">
                <span id={ids.finish}>Finish by</span>
                <input type="date" value={finishBy} min={todayKey()} onChange={(event) => setFinishBy(event.target.value)} aria-labelledby={ids.finish} />
              </label>
            </div>
          ) : null}

          {assessment ? <div className="gen__assessment">
            {kind === 'test' ? <div className="gen__test-mode" role="group" aria-label="Size test by"><button type="button" aria-pressed={testMode === 'time'} onClick={() => setTestMode('time')}>Time</button><button type="button" aria-pressed={testMode === 'questions'} onClick={() => setTestMode('questions')}>Questions</button></div> : null}
            <label className="gen__inline"><span>{kind === 'test' && testMode === 'time' ? 'Duration' : 'Questions'}</span>{kind === 'test' && testMode === 'time' ? <><input type="number" aria-label="Test duration in minutes" min={5} max={180} step={5} value={Number.isNaN(duration) ? '' : duration} onChange={event => setDuration(event.target.valueAsNumber)} /><span className="gen__unit">minutes</span></> : <input type="number" aria-label={kind === 'test' ? 'Test questions' : 'Quiz questions'} min={1} max={30} value={Number.isNaN(count) ? '' : count} onChange={event => setCount(event.target.valueAsNumber)} />}</label>
            <div className="gen__types"><span>Question types</span><QuestionTypes label="Question types to include" value={questionTypes} onChange={setQuestionTypes} /></div>
          </div> : null}

          {kind === 'flashcards' ? <div className="gen__assessment">
            <div className="gen__test-mode" role="group" aria-label="Number of cards">
              <button type="button" aria-pressed={automaticCards} onClick={() => setAutomaticCards(true)}>Automatic</button>
              <button type="button" aria-pressed={!automaticCards} onClick={() => setAutomaticCards(false)}>Choose count</button>
            </div>
            {automaticCards ? <p className="gen__hint">Centre chooses how many cards the material needs.</p> : <label className="gen__inline">
              <span id={ids.count}>Cards</span>
              <input type="number" min={1} max={maxCount} value={Number.isNaN(count) ? '' : count} onChange={(event) => setCount(event.target.valueAsNumber)} aria-labelledby={ids.count} />
            </label>}
          </div> : null}

          {request.attachmentIds?.length ? <p className="gen__attachments">{request.attachmentIds.length} {request.attachmentIds.length === 1 ? 'file attached' : 'files attached'}</p> : null}
          <textarea
            ref={promptRef}
            className="gen__prompt"
            rows={isPlan ? 2 : 3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={`${prompt.label}\n${prompt.example}`}
            aria-label={`${prompt.label} Optional.`}
            aria-describedby={error ? ids.error : undefined}
          />

          <details className="gen__options" open={optionsOpen} onToggle={(event) => setOptionsOpen(event.currentTarget.open)}>
            <summary>
              <ChevronRight size={13} aria-hidden className="gen__caret" />
              Options
              <span className="gen__summary">{optionsSummary}</span>
            </summary>
            <div className="gen__options-body">
              <div className="gen__inline">
                <span id={ids.difficulty}>{isPlan ? 'Pace' : assessment || countable ? 'Difficulty' : 'Depth'}</span>
                <div className="segmented gen__segmented" role="radiogroup" aria-labelledby={ids.difficulty}>
                  {difficulties.map((option) => (
                    <label key={option.value} className={`segmented__option${difficulty === option.value ? ' is-selected' : ''}`}>
                      <input type="radio" name="difficulty" value={option.value} checked={difficulty === option.value} onChange={() => setDifficulty(option.value)} />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>
              {isPlan ? null : (
                <label className="gen__inline">
                  <span id={ids.title}>Title</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Named automatically" aria-labelledby={ids.title} />
                </label>
              )}
            </div>
          </details>
        </fieldset>
        {error ? <p className="form__error" id={ids.error} role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}
