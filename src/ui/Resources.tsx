import { ChevronRight, Link2, Plus, RefreshCw } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { api } from '../data/client';
import type { ResourceKind, Snapshot, Subject } from '../../shared/schema';
import { useApp } from './context';
import { addDays, formatTime, plural, relativeDay, timeAgo, todayKey } from './format';
import { kindIcons, kindLabels, resourceKinds, subjectIcon, subjectTint } from './icons';
import { ResourceCard, ResourcePreviewDialog } from './ResourcePreview';

export function SubjectBadge({ subject, size = 'md' }: { subject: Subject | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = subject ? subjectIcon(subject) : kindIcons.notes;
  return (
    <span className={`subject-badge subject-badge--${size}`} style={subjectTint(subject?.color)} aria-hidden>
      <Icon size={size === 'lg' ? 22 : size === 'md' ? 18 : 13} strokeWidth={1.8} />
    </span>
  );
}

export function OrganatoEmpty({ state }: { state: Snapshot }) {
  const { navigate, act } = useApp();
  const [syncing, setSyncing] = useState(false);
  const connected = state.settings.organatoConnected;
  return (
    <div className="invite">
      <span className="invite__icon" aria-hidden><Link2 size={20} /></span>
      <h2 className="invite__title">{connected ? 'Organato has no subjects yet' : 'Bring in your subjects from Organato'}</h2>
      <p className="invite__body">
        {connected
          ? 'Add subjects in Organato, then sync. Centre builds topics and resources inside them.'
          : 'Centre reads your subjects, assignments and due dates from Organato. Nothing shows up here until you connect it.'}
      </p>
      {state.syncError ? <p className="form__error" role="alert">Last sync failed: {state.syncError}</p> : null}
      {connected ? (
        <button
          type="button"
          className="button button--primary"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            await act(() => api.syncOrganato(), 'Synced with Organato');
            setSyncing(false);
          }}
        >
          <RefreshCw size={14} className={syncing ? 'spin' : undefined} /> {syncing ? 'Syncing' : 'Sync now'}
        </button>
      ) : (
        <button type="button" className="button button--primary" onClick={() => navigate({ kind: 'settings' })}>
          Connect Organato
        </button>
      )}
    </div>
  );
}

export function SubjectsPage() {
  const { state, navigate } = useApp();
  const [preview,setPreview] = useState<string|null>(null);
  const personal = state.resources.filter(resource => resource.subjectId === null);
  const previewing = state.resources.find(resource => resource.id === preview);
  return (
    <div className="page">
      <header className="page__header">
        <h1 className="page__title">Resources</h1>
        <p className="page__lede">Pick a subject to see its topics and everything you&rsquo;ve made for them.</p>
      </header>
      {state.subjects.length === 0 && personal.length === 0 ? (
        <OrganatoEmpty state={state} />
      ) : (
        <ul className="subject-grid">
          {state.subjects.map((subject) => {
            const topics = state.topics.filter((topic) => topic.subjectId === subject.id).length;
            const resources = state.resources.filter((resource) => resource.subjectId === subject.id).length;
            const due = state.assignments.filter((item) => item.subjectId === subject.id && item.dueDate && item.dueDate.slice(0, 10) >= todayKey() && item.dueDate.slice(0, 10) <= addDays(todayKey(), 7)).length;
            return (
              <li key={subject.id}>
                <button type="button" className="subject-tile" style={subjectTint(subject.color)} onClick={() => navigate({ kind: 'subject', subjectId: subject.id })}>
                  <SubjectBadge subject={subject} size="lg" />
                  <span className="subject-tile__text">
                    <span className="subject-tile__name">{subject.name}</span>
                    <span className="subject-tile__meta">
                      {plural(topics, 'topic')}, {plural(resources, 'resource')}
                    </span>
                    {due ? <span className="subject-tile__due">{plural(due, 'item')} due this week</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {personal.length ? <section className="personal-resources" aria-labelledby="personal-resources-heading"><h2 id="personal-resources-heading">Personal learning</h2><p className="muted">Resources outside your school subjects.</p><ul className="resource-grid">{personal.map(resource => <li key={resource.id}><ResourceCard resource={resource} onPreview={() => setPreview(resource.id)} /></li>)}</ul></section> : null}
      {previewing ? <ResourcePreviewDialog resource={previewing} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

function Upcoming({ subjectId }: { subjectId: string }) {
  const { state, navigate } = useApp();
  const today = todayKey();
  const items = [
    ...state.events
      .filter((event) => event.subjectId === subjectId && !event.completedAt && event.date >= today)
      .map((event) => ({ id: event.id, title: event.title, date: event.date, detail: [relativeDay(event.date), formatTime(event.time)].filter(Boolean).join(', '), source: 'Study' })),
    ...state.assignments
      .filter((item) => !state.events.some(event => event.organatoId === item.id) && item.subjectId === subjectId && item.dueDate && item.dueDate.slice(0, 10) >= today && !/done|complete/i.test(item.status))
      .map((item) => ({ id: item.id, title: item.title, date: item.dueDate!.slice(0, 10), detail: `Due ${relativeDay(item.dueDate!)}`, source: item.kind === 'todo' ? 'To do' : 'Assignment' })),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

  return (
    <section className="inspector__section" aria-labelledby="upcoming-heading">
      <div className="inspector__heading-row">
        <h2 className="inspector__heading" id="upcoming-heading">Coming up</h2>
        <button type="button" className="link-button" onClick={() => navigate({ kind: 'calendar' })}>Calendar</button>
      </div>
      {items.length === 0 ? (
        <p className="inspector__empty">Nothing scheduled for this subject.</p>
      ) : (
        <ul className="upcoming">
          {items.map((item) => (
            <li key={item.id} className="upcoming__item">
              <span className="upcoming__title">{item.title}</span>
              <span className="upcoming__detail">{item.source}, {item.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Inspector({ subjectId, topicId }: { subjectId: string; topicId?: string }) {
  const { state, openGenerate, openEventDialog, navigate } = useApp();
  const weak = state.memories.filter((memory) => !memory.resolvedAt && memory.subjectId === subjectId && (!topicId || memory.topicId === topicId));
  return (
    <aside className="inspector" aria-label="Create and upcoming">
      <section className="inspector__section" aria-labelledby="create-heading">
        <h2 className="inspector__heading" id="create-heading">Make</h2>
        <div className="create-list">
          {resourceKinds.map((kind) => {
            const Icon = kindIcons[kind];
            return (
              <button key={kind} type="button" className="create-list__item" onClick={() => openGenerate({ kind, subjectId, topicId })}>
                <Icon size={15} aria-hidden />
                <span>{kindLabels[kind]}</span>
                <kbd>/{kind}</kbd>
              </button>
            );
          })}
          <button type="button" className="create-list__item" onClick={() => openGenerate({ kind: 'plan', subjectId, topicId })}>
            <kindIcons.plan size={15} aria-hidden />
            <span>Study plan</span>
            <kbd>/plan</kbd>
          </button>
          <button type="button" className="create-list__item" onClick={() => openEventDialog()}>
            <Plus size={15} aria-hidden />
            <span>Calendar event</span>
          </button>
        </div>
      </section>
      <Upcoming subjectId={subjectId} />
      {weak.length > 0 ? (
        <section className="inspector__section" aria-labelledby="weak-heading">
          <div className="inspector__heading-row">
            <h2 className="inspector__heading" id="weak-heading">Weak spots</h2>
            <button type="button" className="link-button" onClick={() => navigate({ kind: 'review' })}>Review</button>
          </div>
          <ul className="upcoming">
            {weak.slice(0, 4).map((memory) => (
              <li key={memory.id} className="upcoming__item">
                <span className="upcoming__title">{memory.question}</span>
                <span className="upcoming__detail">Review {relativeDay(memory.nextReviewAt).toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

function NewTopicForm({ subjectId, onDone }: { subjectId: string; onDone: () => void }) {
  const { act, navigate } = useApp();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    const topic = await act(() => api.createTopic(subjectId, name.trim()));
    setBusy(false);
    if (topic) {
      onDone();
      navigate({ kind: 'topic', subjectId, topicId: topic.id });
    }
  }
  return (
    <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={inputId} className="visually-hidden">Topic name</label>
      <input id={inputId} autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Topic name, like Cell respiration" disabled={busy} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onDone(); } }} />
      <button type="submit" className="button button--primary" disabled={!name.trim() || busy}>{busy ? 'Adding' : 'Add topic'}</button>
      <button type="button" className="button button--quiet" onClick={onDone}>Cancel</button>
    </form>
  );
}

export function SubjectPage({ subjectId }: { subjectId: string }) {
  const { state, navigate } = useApp();
  const [adding, setAdding] = useState(false);
  const subject = state.subjects.find((item) => item.id === subjectId);
  const topics = state.topics.filter((topic) => topic.subjectId === subjectId);

  if (!subject) return <Missing what="subject" />;

  return (
    <div className="split">
      <div className="page">
        <header className="page__header page__header--with-icon">
          <SubjectBadge subject={subject} size="lg" />
          <div>
            <h1 className="page__title">{subject.name}</h1>
            <p className="page__lede">{plural(topics.length, 'topic')}. Open one to see its resources, or ask about {subject.shortName ?? subject.name} below.</p>
          </div>
        </header>
        <div className="section-bar">
          <h2 className="section-bar__title">Topics</h2>
          {!adding ? (
            <button type="button" className="button button--quiet button--small" onClick={() => setAdding(true)}>
              <Plus size={14} /> New topic
            </button>
          ) : null}
        </div>
        {adding ? <NewTopicForm subjectId={subjectId} onDone={() => setAdding(false)} /> : null}
        {topics.length === 0 && !adding ? (
          <p className="empty-line">No topics yet. Add the one you&rsquo;re working on, or ask Centre to suggest some.</p>
        ) : (
          <ul className="topic-list">
            {topics.map((topic) => {
              const resources = state.resources.filter((resource) => resource.topicId === topic.id);
              const latest = resources.reduce<string | null>((max, resource) => (!max || resource.updatedAt > max ? resource.updatedAt : max), null);
              const done = resources.filter((resource) => resource.completedAt).length;
              return (
                <li key={topic.id}>
                  <button type="button" className="topic-row" onClick={() => navigate({ kind: 'topic', subjectId, topicId: topic.id })}>
                    <span className="topic-row__text">
                      <span className="topic-row__name">{topic.name}</span>
                      {topic.description ? <span className="topic-row__description">{topic.description}</span> : null}
                    </span>
                    <span className="topic-row__meta">
                      {resources.length ? `${done}/${resources.length} done` : 'Empty'}
                      {latest ? <span className="topic-row__time">{timeAgo(latest)}</span> : null}
                    </span>
                    <ChevronRight size={15} className="topic-row__chevron" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Inspector subjectId={subjectId} />
    </div>
  );
}

export function TopicPage({ subjectId, topicId }: { subjectId: string; topicId: string }) {
  const { state, navigate, generating } = useApp();
  const [filter, setFilter] = useState<ResourceKind | 'all'>('all');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const topic = state.topics.find((item) => item.id === topicId);
  const all = useMemo(() => state.resources.filter((resource) => resource.topicId === topicId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.resources, topicId]);
  const kinds = resourceKinds.filter((kind) => all.some((resource) => resource.kind === kind));
  const shown = filter === 'all' ? all : all.filter((resource) => resource.kind === filter);
  const previewing = previewId ? all.find((resource) => resource.id === previewId) : undefined;

  if (!topic) return <Missing what="topic" />;

  return (
    <div className="split">
      <div className="page">
        <header className="page__header">
          <h1 className="page__title">{topic.name}</h1>
          {topic.description ? <p className="page__lede">{topic.description}</p> : null}
        </header>
        {kinds.length > 1 ? (
          <div className="filter-row" role="group" aria-label="Filter by kind">
            {(['all', ...kinds] as const).map((kind) => (
              <button key={kind} type="button" className={`chip${filter === kind ? ' is-selected' : ''}`} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>
                {kind === 'all' ? `All ${all.length}` : kindLabels[kind]}
              </button>
            ))}
          </div>
        ) : null}
        {generating.length > 0 ? (
          <p className="generating-line" role="status"><span className="spinner spinner--small" aria-hidden /> Making {generating.map((job) => job.label).join(', ')}</p>
        ) : null}
        {all.length === 0 ? (
          <p className="empty-line">Nothing here yet. Make a quiz or some flashcards from the panel on the right, or type <kbd>/quiz</kbd> below.</p>
        ) : (
          <ul className="resource-grid">
            {shown.map((resource) => (
              <li key={resource.id}>
                <ResourceCard resource={resource} onPreview={() => setPreviewId(resource.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Inspector subjectId={subjectId} topicId={topicId} />
      {previewing ? <ResourcePreviewDialog resource={previewing} onClose={() => setPreviewId(null)} /> : null}
    </div>
  );
}

export function Missing({ what }: { what: string }) {
  const { navigate } = useApp();
  return (
    <div className="empty-page">
      <h1>This {what} isn&rsquo;t here anymore</h1>
      <p className="muted">It may have been removed in Organato or by a sync.</p>
      <button type="button" className="button" onClick={() => navigate({ kind: 'resources' })}>Back to resources</button>
    </div>
  );
}
