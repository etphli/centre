import { ConnectedFileView } from './ConnectedFileView';
import { connectorCatalog } from '../../shared/connectors';
import { DeleteResource } from './DeleteResource';
import { Check, ChevronLeft, ChevronRight, Download, FolderInput, Printer, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { api, downloadFile, printPaper } from '../data/client';
import type { GradeResult, Resource } from '../../shared/schema';
import { useApp } from './context';
import { errorMessage, plural, timeAgo } from './format';
import { kindIcons, kindLabels } from './icons';
import { Markdown } from './Markdown';
import { Missing, SubjectBadge } from './Resources';
import './quiz.css';
import { MoveResource } from './MoveResource';
import { PaperPreview } from './PaperPreview';
import { DiagramFrame,OpenDiagramButton } from './DiagramFrame';

type Card = { id: string; front: string; back: string };

const cardListSchema = z.array(
  z.union([
    z.object({ id: z.string().optional(), front: z.string(), back: z.string() }),
    z.object({ id: z.string().optional(), prompt: z.string(), answer: z.string() }),
    z.object({ id: z.string().optional(), question: z.string(), answer: z.string() }),
  ]),
);

type CardParse = { ok: true; cards: Card[] } | { ok: false; reason: string };

function readCards(resource: Resource): CardParse {
  if (resource.questions.length) return { ok: true, cards: resource.questions.map((q) => ({ id: q.id, front: q.prompt, back: q.answer })) };
  let raw: unknown;
  try {
    raw = JSON.parse(resource.content);
  } catch {
    return { ok: false, reason: 'The card content is not valid JSON.' };
  }
  const list = z.object({ cards: z.unknown() }).safeParse(raw);
  const parsed = cardListSchema.safeParse(list.success ? list.data.cards : raw);
  if (!parsed.success) return { ok: false, reason: 'The cards are missing a front or back.' };
  if (parsed.data.length === 0) return { ok: false, reason: 'The deck is empty.' };
  return {
    ok: true,
    cards: parsed.data.map((card, index) => {
      const front = 'front' in card ? card.front : 'prompt' in card ? card.prompt : card.question;
      const back = 'back' in card ? card.back : card.answer;
      return { id: card.id ?? String(index), front, back };
    }),
  };
}

function ParseProblem({ resource, reason }: { resource: Resource; reason: string }) {
  return (
    <div className="parse-problem" role="alert">
      <p><strong>Centre couldn&rsquo;t read this {kindLabels[resource.kind].toLowerCase()}.</strong> {reason} Try making it again.</p>
      {resource.content ? (
        <details>
          <summary>Show what the generator returned</summary>
          <pre className="source">{resource.content}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** Some generated prompts are bare LaTeX, like `\\text{Solve } x + 5 = 12`. Wrap those as inline math so KaTeX renders them, matching ResourcePreview. */
function mathText(text: string) {
  return /\\[a-zA-Z]+/.test(text) && !/\$|\\\(|\\\[/.test(text) ? `$${text.trim()}$` : text;
}

type Mark = GradeResult['feedback'][number];

function markTone(mark: Mark | undefined) {
  if (!mark) return '';
  return mark.score >= mark.maxScore ? 'is-right' : mark.score > 0 ? 'is-partial' : 'is-wrong';
}

function Quiz({ resource }: { resource: Resource }) {
  const { state, act, notify } = useApp();
  const latest = state.attempts
    .filter((attempt) => attempt.resourceId === resource.id)
    .reduce<(typeof state.attempts)[number] | undefined>((best, attempt) => (!best || attempt.createdAt > best.createdAt ? attempt : best), undefined);
  const [answers, setAnswers] = useState<Record<string, string>>(() => latest?.answers ?? {});
  const [result, setResult] = useState<GradeResult | null>(() => latest?.result ?? null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusTarget = useRef<HTMLElement | null>(null);
  const moved = useRef(false);
  const questions = resource.questions;
  const question = questions[Math.min(index, questions.length - 1)];

  useEffect(() => {
    // Only move focus after the student navigates, never on first load.
    if (moved.current) focusTarget.current?.focus();
  }, [index, result]);

  if (!question) return <ParseProblem resource={resource} reason="It has no questions." />;

  const isAnswered = (id: string) => Boolean(answers[id]?.trim());
  const missing = questions.map((q, i) => ({ q, i })).filter(({ q }) => !isAnswered(q.id));
  const answered = questions.length - missing.length;
  const last = index === questions.length - 1;
  const feedback = new Map(result?.feedback.map((item) => [item.questionId, item]));
  const mark = feedback.get(question.id);
  const flagged = result?.feedback.filter((item) => item.needsReview).length ?? 0;

  function go(next: number) {
    moved.current = true;
    setIndex(Math.min(questions.length - 1, Math.max(0, next)));
  }

  async function grade() {
    setBusy(true);
    setError(null);
    try {
      const graded = await act(() => api.gradeQuiz(resource.id, answers));
      if (graded) {
        moved.current = true;
        setResult(graded);
        setIndex(0);
        notify({ tone: 'success', message: `Marked: ${graded.score} out of ${graded.total}` });
        document.querySelector('.main__content')?.scrollTo({ top: 0 });
      } else setError('Grading didn’t finish. Your answers are still here, so you can try again.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function tryAgain() {
    moved.current = true;
    setResult(null);
    setAnswers({});
    setError(null);
    setIndex(0);
  }

  const promptId = `prompt-${question.id}`;
  const answerId = `answer-${question.id}`;

  return (
    <div className={`quiz${result ? ' quiz--marked' : ''}`}>
      {result ? (
        <div className="score" role="status">
          <span className="score__number">{result.score}<span className="score__total">/{result.total}</span></span>
          <span className="score__text">{flagged ? `${plural(flagged, 'question')} added to Review.` : 'Nothing flagged for review.'}</span>
          <button type="button" className="button button--quiet button--small" onClick={tryAgain}>
            <RotateCcw size={14} /> Try again
          </button>
        </div>
      ) : null}

      <nav className="quiz__progress" aria-label="Questions">
        <p className="quiz__count" aria-live="polite">
          Question {index + 1} of {questions.length}
          {!result ? <span className="quiz__answered">, {answered} answered</span> : null}
        </p>
        <ol className="quiz__dots">
          {questions.map((q, i) => {
            const qMark = feedback.get(q.id);
            const status = result
              ? qMark ? `${qMark.score} of ${qMark.maxScore} marks` : 'not marked'
              : isAnswered(q.id) ? 'answered' : 'not answered';
            const tone = result ? markTone(qMark) : isAnswered(q.id) ? 'is-answered' : '';
            return (
              <li key={q.id}>
                <button
                  type="button"
                  className={`quiz__dot ${tone}`}
                  aria-label={`Question ${i + 1}, ${status}`}
                  aria-current={i === index ? 'step' : undefined}
                  onClick={() => go(i)}
                />
              </li>
            );
          })}
        </ol>
      </nav>

      <section className={`question question--single ${markTone(mark)}`} aria-labelledby={promptId}>
        <div className="question__head">
          <div id={promptId} className="question__prompt"><Markdown>{mathText(question.prompt)}</Markdown></div>
          <span className="question__marks">{plural(question.marks, 'mark')}</span>
        </div>
        {result ? (
          <>
            <div className="quiz__your-answer" tabIndex={-1} ref={(node) => { focusTarget.current = node; }}>
              <span className="quiz__label">Your answer</span>
              {answers[question.id]?.trim() ? <p>{answers[question.id]}</p> : <p className="muted">No answer given</p>}
            </div>
            {mark ? (
              <div className="question__feedback">
                <p className="question__score">{mark.score}/{mark.maxScore}{mark.needsReview ? ', saved to Review' : ''}</p>
                <Markdown>{mark.feedback}</Markdown>
              </div>
            ) : null}
            <details className="quiz__model">
              <summary>Model answer</summary>
              <Markdown>{mathText(question.answer) + (question.explanation ? `\n\n${question.explanation}` : '')}</Markdown>
            </details>
          </>
        ) : question.responseType === 'multiple_choice' ? (
          <div className="quiz-choices" role="radiogroup" aria-labelledby={promptId}>{question.choices.map((choice,choiceIndex) => <label className={`quiz-choice${answers[question.id] === choice ? ' is-selected' : ''}`} key={choice}><input type="radio" name={`question-${question.id}`} value={choice} checked={answers[question.id] === choice} disabled={busy} onChange={() => setAnswers(current => ({ ...current,[question.id]:choice }))} ref={choiceIndex === 0 ? node => { focusTarget.current = node; } : undefined} /><span className="quiz-choice__letter">{String.fromCharCode(65+choiceIndex)}</span><Markdown>{mathText(choice)}</Markdown></label>)}</div>
        ) : (
          <textarea
            key={question.id}
            id={answerId}
            ref={(node) => { focusTarget.current = node; }}
            aria-labelledby={promptId}
            className="question__answer"
            rows={question.responseType === 'long_response' ? 7 : 4}
            value={answers[question.id] ?? ''}
            onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
            placeholder="Your answer"
            readOnly={busy}
          />
        )}
      </section>

      {!result && last && missing.length ? (
        <div className="quiz__missing">
          <span>{missing.length === questions.length ? 'No questions answered yet.' : `${plural(missing.length, 'question')} still blank:`}</span>
          {missing.length < questions.length ? missing.map(({ q, i }) => (
            <button key={q.id} type="button" className="link-button" onClick={() => go(i)}>Question {i + 1}</button>
          )) : null}
        </div>
      ) : null}

      <div className="quiz__nav">
        {error ? <p className="form__error" role="alert">{error}</p> : null}
        <button type="button" className="button button--quiet" onClick={() => go(index - 1)} disabled={index === 0 || busy}>
          <ChevronLeft size={16} aria-hidden /> Back
        </button>
        {!last ? (
          <button type="button" className="button" onClick={() => go(index + 1)} disabled={busy}>
            Next <ChevronRight size={16} aria-hidden />
          </button>
        ) : !result ? (
          <button type="button" className="button button--primary" disabled={busy || answered === 0} onClick={() => void grade()}>
            {busy ? <><span className="spinner spinner--small" aria-hidden /> Marking</> : 'Submit for marking'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TestPaper({ resource }: { resource: Resource }) {
  const [showSource, setShowSource] = useState(resource.questions.length === 0);
  const [source,setSource] = useState(resource.content);
  useEffect(() => {
    if (!showSource) return;
    let live = true;
    api.exportResource(resource.id).then(file => { if (live) setSource(file.content); }).catch(() => undefined);
    return () => { live = false; };
  },[showSource,resource.id,resource.updatedAt]);
  return (
    <div className="paper-wrap">
      {resource.questions.length ? (
        <PaperPreview resource={resource} />
      ) : null}
      <button type="button" className="link-button" aria-expanded={showSource} onClick={() => setShowSource((value) => !value)}>
        {showSource ? 'Hide LaTeX' : 'Show LaTeX'}
      </button>
      {showSource ? <pre className="source" tabIndex={0} aria-label="LaTeX source">{source || 'No LaTeX was returned for this test.'}</pre> : null}
    </div>
  );
}

function Flashcards({ resource }: { resource: Resource }) {
  const { openFeedback } = useApp();
  const parsed = useMemo(() => readCards(resource), [resource]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [again, setAgain] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const cards = parsed.ok ? parsed.cards : [];
  const card = cards[index];

  const move = useCallback((step: number) => {
    setIndex((current) => Math.min(cards.length - 1, Math.max(0, current + step)));
    setFlipped(false);
  }, [cards.length]);

  function sort(knewIt: boolean) {
    if (!card) return;
    setAgain((current) => {
      const next = new Set(current);
      if (knewIt) next.delete(card.id);
      else next.add(card.id);
      return next;
    });
    setSeen((current) => new Set(current).add(card.id));
    move(1);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (event.key === 'ArrowRight') move(1);
      else if (event.key === 'ArrowLeft') move(-1);
      else if (event.key === ' ') {
        event.preventDefault();
        setFlipped((value) => !value);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  if (!parsed.ok) return <ParseProblem resource={resource} reason={parsed.reason} />;
  if (!card) return null;
  const finished = seen.size === cards.length;
  const questionIds = resource.questions.length ? [...again] : [];

  return (
    <div className="cards">
      <p className="cards__progress" aria-live="polite">Card {index + 1} of {cards.length}{again.size ? `, ${again.size} to go over again` : ''}</p>
      <button type="button" className={`flashcard${flipped ? ' is-flipped' : ''}`} onClick={() => setFlipped((value) => !value)} aria-label={flipped ? 'Answer side. Press to show the question.' : 'Question side. Press to show the answer.'}>
        <span className="flashcard__inner">
          <span className="flashcard__face flashcard__face--front" aria-hidden={flipped}>
            <Markdown>{card.front}</Markdown>
          </span>
          <span className="flashcard__face flashcard__face--back" aria-hidden={!flipped}>
            <Markdown>{card.back}</Markdown>
          </span>
        </span>
      </button>
      <div className="cards__controls">
        <button type="button" className="icon-button" aria-label="Previous card" onClick={() => move(-1)} disabled={index === 0}><ChevronLeft size={18} /></button>
        <button type="button" className="button button--quiet" onClick={() => sort(false)}>Again</button>
        <button type="button" className="button" onClick={() => sort(true)}>Got it</button>
        <button type="button" className="icon-button" aria-label="Next card" onClick={() => move(1)} disabled={index === cards.length - 1}><ChevronRight size={18} /></button>
      </div>
      <p className="cards__hint">Space flips, arrow keys move.</p>
      {finished && !resource.completedAt ? (
        <div className="cards__finish">
          <span>You&rsquo;ve been through every card.</span>
          <button type="button" className="button button--primary button--small" onClick={() => openFeedback(resource, questionIds)}>Mark done</button>
        </div>
      ) : null}
    </div>
  );
}

export function ResourceView({ resourceId }: { resourceId: string }) {
  const { state, navigate, notify, openFeedback } = useApp();
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [moving,setMoving] = useState(false);
  const resource = state.resources.find((item) => item.id === resourceId);
  if (!resource) return <Missing what="resource" />;
  const subject = state.subjects.find((item) => item.id === resource.subjectId);
  const topic = state.topics.find((item) => item.id === resource.topicId);
  const Icon = kindIcons[resource.kind];
  const exportLabel = resource.kind === 'test' ? 'Export .tex' : resource.kind === 'diagram' ? 'Export .html' : resource.kind === 'notes' ? 'Export .md' : 'Export';

  async function exportFile() {
    if (!resource) return;
    setExporting(true);
    try {
      const file = await api.exportResource(resource.id);
      await downloadFile(file);
      notify({ tone: 'success', message: `Exported ${file.filename}` });
    } catch (failure) {
      notify({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setExporting(false);
    }
  }

  async function print() {
    if (!resource) return;
    setPrinting(true);
    try {
      await printPaper(resource);
    } catch (failure) {
      notify({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className={`page page--resource page--${resource.kind}`}>
      {moving ? <MoveResource resource={resource} onClose={() => setMoving(false)} /> : null}
      <header className="resource-header">
        <div className="resource-header__crumbs">
          <SubjectBadge subject={subject} size="sm" />
          {!subject ? <span>Personal learning</span> : null}
          {subject ? <button type="button" className="link-button" onClick={() => navigate({ kind: 'subject', subjectId: subject.id })}>{subject.name}</button> : null}
          {topic ? <><span aria-hidden>/</span><button type="button" className="link-button" onClick={() => navigate({ kind: 'topic', subjectId: topic.subjectId, topicId: topic.id })}>{topic.name}</button></> : null}
        </div>
        <h1 className="page__title">{resource.title}</h1>
        <div className="resource-header__row">
          <span className="resource-header__meta">
            <Icon size={14} aria-hidden /> {resource.connectedFile ? connectorCatalog.find(item => item.id === resource.connectedFile?.connector)?.name : kindLabels[resource.kind]}, made {timeAgo(resource.createdAt)}
            {resource.completedAt ? <span className="done-pill"><Check size={12} aria-hidden /> Done {timeAgo(resource.completedAt)}</span> : null}
          </span>
          <div className="resource-header__actions">
            <DeleteResource resource={resource} onDeleted={() => navigate({kind:'resources'})} />
            <button type="button" className="button button--quiet button--small" onClick={() => setMoving(true)}><FolderInput size={14} />Move</button>
            {resource.kind === 'diagram' ? <OpenDiagramButton resource={resource} /> : null}
            {resource.kind === 'test' ? (
              <button type="button" className="button button--quiet button--small" onClick={() => void print()} disabled={printing}>
                <Printer size={14} /> {printing ? 'Preparing' : 'Print paper'}
              </button>
            ) : null}
            <button type="button" className="button button--quiet button--small" onClick={() => void exportFile()} disabled={exporting}>
              <Download size={14} /> {exporting ? 'Exporting' : exportLabel}
            </button>
            {resource.kind !== 'quiz' ? (
              <button type="button" className="button button--small" onClick={() => openFeedback(resource)}>
                <Check size={14} /> {resource.completedAt ? 'Add reflection' : 'Mark done'}
              </button>
            ) : null}
          </div>
        </div>
      </header>
      {resource.kind === 'quiz' ? <Quiz key={resource.id} resource={resource} /> : null}
      {resource.kind === 'test' ? <TestPaper resource={resource} /> : null}
      {resource.kind === 'flashcards' ? <Flashcards key={resource.id} resource={resource} /> : null}
      {resource.kind === 'diagram' ? <div className="diagram"><DiagramFrame resource={resource} /></div> : null}
      {resource.connectedFile ? <ConnectedFileView key={resource.id} resource={resource} /> : null}
      {resource.kind === 'notes' && !resource.connectedFile ? (resource.content.trim() ? <article className="notes"><Markdown>{resource.content}</Markdown></article> : <ParseProblem resource={resource} reason="The notes are empty." />) : null}
    </div>
  );
}
