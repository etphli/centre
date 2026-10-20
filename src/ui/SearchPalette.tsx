import { CalendarDays, Library, MessageSquare, Plus, Search, Settings, Target, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { relativeDay, timeAgo } from './format';
import { kindIcons, kindLabels, subjectIcon } from './icons';
import type { CreateKind } from './types';

interface Result {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: LucideIcon;
  run: () => void;
}

function snippet(text: string, query: string): string | undefined {
  const index = text.toLowerCase().indexOf(query);
  if (index < 0) return undefined;
  const start = Math.max(0, index - 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, index + query.length + 50).replace(/\s+/g, ' ')}`;
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { state, navigate, openGenerate } = useApp();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const go = (run: () => void) => () => {
      onClose();
      run();
    };
    const matches = (...fields: (string | null | undefined)[]) => !q || fields.some((field) => field?.toLowerCase().includes(q));
    const out: Result[] = [];

    const pages: [string, LucideIcon, () => void][] = [
      ['New chat', Plus, () => navigate({ kind: 'home' })],
      ['Resources', Library, () => navigate({ kind: 'resources' })],
      ['Calendar', CalendarDays, () => navigate({ kind: 'calendar' })],
      ['Review', Target, () => navigate({ kind: 'review' })],
      ['Settings', Settings, () => navigate({ kind: 'settings' })],
    ];
    for (const [label, icon, run] of pages) if (matches(label)) out.push({ id: `page-${label}`, group: 'Go to', label, icon, run: go(run) });

    const creates: CreateKind[] = ['quiz', 'test', 'flashcards', 'diagram', 'plan'];
    for (const kind of creates) {
      if (q && matches(kindLabels[kind], `/${kind}`, `new ${kind}`)) {
        out.push({ id: `create-${kind}`, group: 'Make', label: `New ${kindLabels[kind].toLowerCase()}`, detail: `/${kind}`, icon: kindIcons[kind], run: go(() => openGenerate({ kind })) });
      }
    }

    const chats = [...state.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let chatCount = 0;
    for (const chat of chats) {
      if (chatCount >= (q ? 8 : 5)) break;
      const inTitle = matches(chat.title);
      const hit = q && !inTitle ? chat.messages.map((message) => snippet(message.content, q)).find(Boolean) : undefined;
      if (!inTitle && !hit) continue;
      chatCount += 1;
      out.push({ id: `chat-${chat.id}`, group: q ? 'Chats' : 'Recent chats', label: chat.title || 'New chat', detail: hit ?? timeAgo(chat.updatedAt), icon: MessageSquare, run: go(() => navigate({ kind: 'chat', chatId: chat.id })) });
    }

    if (q) {
      for (const subject of state.subjects) {
        if (matches(subject.name, subject.shortName)) out.push({ id: `subject-${subject.id}`, group: 'Subjects', label: subject.name, icon: subjectIcon(subject), run: go(() => navigate({ kind: 'subject', subjectId: subject.id })) });
      }
      for (const topic of state.topics) {
        if (!matches(topic.name, topic.description)) continue;
        const subject = state.subjects.find((item) => item.id === topic.subjectId);
        out.push({ id: `topic-${topic.id}`, group: 'Topics', label: topic.name, detail: subject?.name, icon: Library, run: go(() => navigate({ kind: 'topic', subjectId: topic.subjectId, topicId: topic.id })) });
      }
      for (const resource of state.resources) {
        if (!matches(resource.title, resource.kind)) continue;
        const topic = state.topics.find((item) => item.id === resource.topicId);
        out.push({ id: `resource-${resource.id}`, group: 'Resources', label: resource.title, detail: [kindLabels[resource.kind], topic?.name].filter(Boolean).join(', '), icon: kindIcons[resource.kind], run: go(() => navigate({ kind: 'resource', resourceId: resource.id })) });
      }
      for (const event of state.events) {
        if (!matches(event.title, event.notes)) continue;
        out.push({ id: `event-${event.id}`, group: 'Calendar', label: event.title, detail: relativeDay(event.date), icon: CalendarDays, run: go(() => navigate({ kind: 'calendar' })) });
      }
      for (const assignment of state.assignments) {
        if (!matches(assignment.title)) continue;
        out.push({ id: `assignment-${assignment.id}`, group: 'Organato', label: assignment.title, detail: assignment.dueDate ? `Due ${relativeDay(assignment.dueDate)}` : assignment.status, icon: CalendarDays, run: go(() => navigate({ kind: 'calendar' })) });
      }
    }
    return out.slice(0, 40);
  }, [query, state, navigate, openGenerate, onClose]);

  useEffect(() => setHighlight(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      results[highlight]?.run();
    }
  }

  let lastGroup = '';
  return (
    <Dialog title="Search" onClose={onClose} size="md" className="palette" hideHeader>
      <div className="palette__field">
        <Search size={16} aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search chats, subjects, resources and events"
          aria-label="Search"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={results[highlight] ? `${listId}-${highlight}` : undefined}
        />
        <kbd>esc</kbd>
      </div>
      <ul className="palette__list" role="listbox" id={listId} ref={list} aria-label="Results">
        {results.length === 0 ? <li className="palette__empty">Nothing matches &ldquo;{query}&rdquo;</li> : null}
        {results.map((result, index) => {
          const header = result.group !== lastGroup ? result.group : null;
          lastGroup = result.group;
          const Icon = result.icon;
          return (
            <li key={result.id} role="presentation">
              {header ? <div className="palette__group" role="presentation">{header}</div> : null}
              <div
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlight}
                className="palette__item"
                onMouseMove={() => setHighlight(index)}
                onClick={result.run}
              >
                <Icon size={15} aria-hidden />
                <span className="palette__label">{result.label}</span>
                {result.detail ? <span className="palette__detail">{result.detail}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
