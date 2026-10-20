import { Check, ChevronDown, Target } from 'lucide-react';
import { useState } from 'react';
import { api } from '../data/client';
import type { StudyMemory } from '../../shared/schema';
import { useApp } from './context';
import { plural, relativeDay, timeAgo, todayKey } from './format';
import { SubjectBadge } from './Resources';

function MemoryCard({ memory }: { memory: StudyMemory }) {
  const { state, act, navigate, openGenerate } = useApp();
  const [busy, setBusy] = useState(false);
  const topic = state.topics.find((item) => item.id === memory.topicId);
  const resource = state.resources.find((item) => item.id === memory.resourceId);
  const due = memory.nextReviewAt.slice(0, 10) <= todayKey();

  return (
    <li className={`weak${due ? ' is-due' : ''}`}>
      <div className="weak__body">
        <p className="weak__where">
          {topic?.name ?? 'Unknown topic'}
          {resource ? <>, from <button type="button" className="link-button" onClick={() => navigate({ kind: 'resource', resourceId: resource.id })}>{resource.title}</button></> : null}
        </p>
        <p className="weak__question">{memory.question}</p>
        {memory.note ? <p className="weak__note">{memory.note}</p> : null}
        <p className="weak__when">{due ? 'Due for review' : `Review ${relativeDay(memory.nextReviewAt).toLowerCase()}`}</p>
      </div>
      <div className="weak__actions">
        <button
          type="button"
          className="button button--quiet button--small"
          onClick={() => openGenerate({ kind: 'quiz', subjectId: memory.subjectId, topicId: memory.topicId, instructions: `Help me practise this weak spot: ${memory.question}${memory.note ? `\nWhat went wrong last time: ${memory.note}` : ''}` })}
        >
          Practise
        </button>
        <button
          type="button"
          className="button button--small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await act(() => api.resolveMemory(memory.id), 'Marked as resolved');
            setBusy(false);
          }}
        >
          <Check size={14} /> {busy ? 'Saving' : 'Resolved'}
        </button>
      </div>
    </li>
  );
}

export function ReviewPage() {
  const { state,navigate,openGenerate } = useApp();
  const [showResolved, setShowResolved] = useState(false);
  const open = state.memories.filter((memory) => !memory.resolvedAt).sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt));
  const resolved = state.memories.filter((memory) => memory.resolvedAt).sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  const due = open.filter((memory) => memory.nextReviewAt.slice(0, 10) <= todayKey()).length;
  const subjects = state.subjects.filter((subject) => open.some((memory) => memory.subjectId === subject.id));
  const orphaned = open.filter((memory) => !state.subjects.some((subject) => subject.id === memory.subjectId));

  return (
    <div className={`page page--review${open.length === 0 ? ' page--review-empty' : ''}`}>
      <header className="page__header">
        <h1 className="page__title">Review</h1>
        {open.length ? <p className="page__lede">{plural(open.length, 'weak spot')} from your quizzes and reflections{due ? `, ${due} due now` : ''}. Practise one, then mark it resolved once it sticks.</p> : null}
      </header>
      {open.length === 0 ? <section className="review-empty">
        <Target size={26} strokeWidth={1.25} aria-hidden />
        <h2>{resolved.length ? 'All caught up' : 'A fresh start'}</h2>
        <p>{resolved.length ? 'You’ve worked through your flagged questions. Your next quiz or reflection will bring anything that needs another look here.' : 'Questions you miss in quizzes or flag after a test will appear here, ready for another look.'}</p>
        <div className="review-empty__actions"><button type="button" className="button button--small" onClick={() => openGenerate({kind:'quiz'})}>Take a quiz</button><button type="button" className="button button--quiet button--small" onClick={() => navigate({kind:'resources'})}>Browse resources</button></div>
      </section> : null}
      {subjects.map((subject) => (
        <section key={subject.id} className="review-group" aria-labelledby={`review-${subject.id}`}>
          <h2 className="review-group__title" id={`review-${subject.id}`}>
            <SubjectBadge subject={subject} size="sm" /> {subject.name}
          </h2>
          <ul className="weak-list">
            {open.filter((memory) => memory.subjectId === subject.id).map((memory) => <MemoryCard key={memory.id} memory={memory} />)}
          </ul>
        </section>
      ))}
      {orphaned.length ? (
        <section className="review-group" aria-labelledby="review-other">
          <h2 className="review-group__title" id="review-other">Other</h2>
          <ul className="weak-list">{orphaned.map((memory) => <MemoryCard key={memory.id} memory={memory} />)}</ul>
        </section>
      ) : null}
      {resolved.length ? (
        <section className="review-group review-resolved">
          <button type="button" className="link-button" aria-expanded={showResolved} onClick={() => setShowResolved((value) => !value)}>
            <ChevronDown size={13} className={showResolved ? 'is-open' : ''} /> {plural(resolved.length, 'resolved spot')}
          </button>
          {showResolved ? (
            <ul className="resolved-list">
              {resolved.map((memory) => (
                <li key={memory.id}>
                  <span>{memory.question}</span>
                  <span className="muted">Resolved {timeAgo(memory.resolvedAt ?? memory.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
