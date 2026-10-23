import { CalendarDays, Clock3, FileQuestion, FileText, Library, MessageSquare, Paperclip, Plus, Search, Settings, Target, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_SEARCH_QUERY_LENGTH, type SearchResult } from '../../shared/search';
import { api } from '../data/client';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { errorMessage, timeAgo } from './format';
import { kindIcons, kindLabels } from './icons';
import type { CreateKind } from './types';

interface Result {
  id: string;
  group: string;
  label: string;
  detail?: string;
  match?: SearchResult;
  icon: LucideIcon;
  run: () => void;
}

const resultIcons: Record<SearchResult['kind'], LucideIcon> = {
  chat: MessageSquare, message: MessageSquare, resource: FileText, question: FileQuestion,
  attachment: Paperclip, subject: Library, topic: Library, event: CalendarDays, assignment: CalendarDays,
};

function HighlightedSnippet({ result }: { result: SearchResult }) {
  let offset = 0;
  return <>{result.highlights.map(([start, end]) => {
    const before = result.snippet.slice(offset, start);
    offset = end;
    return <Fragment key={`${start}-${end}`}>{before}<mark>{result.snippet.slice(start, end)}</mark></Fragment>;
  })}{result.snippet.slice(offset)}</>;
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { state, navigate, openGenerate } = useApp();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const trimmedQuery = query.trim();

  useEffect(() => {
    let current = true;
    setMatches([]);
    setError(null);
    setLoading(Boolean(trimmedQuery));
    if (!trimmedQuery) return;
    const timer = setTimeout(() => {
      void api.search(trimmedQuery).then(results => {
        if (current) setMatches(results);
      }).catch(failure => {
        if (current) setError(errorMessage(failure));
      }).finally(() => {
        if (current) setLoading(false);
      });
    }, 120);
    return () => { current = false; clearTimeout(timer); };
  }, [trimmedQuery]);

  const results = useMemo<Result[]>(() => {
    const q = trimmedQuery.toLocaleLowerCase();
    const go = (run: () => void) => () => { onClose(); run(); };
    const includes = (...fields: string[]) => !q || fields.some(field => field.toLocaleLowerCase().includes(q));
    const out: Result[] = [];
    const pages: [string, LucideIcon, () => void][] = [
      ['New chat', Plus, () => navigate({ kind: 'home' })],
      ['Resources', Library, () => navigate({ kind: 'resources' })],
      ['Calendar', CalendarDays, () => navigate({ kind: 'calendar' })],
      ['Log', Clock3, () => navigate({ kind: 'log' })],
      ['Review', Target, () => navigate({ kind: 'review' })],
      ['Settings', Settings, () => navigate({ kind: 'settings' })],
    ];
    for (const [label, icon, run] of pages) if (includes(label)) out.push({ id: `page-${label}`, group: 'Go to', label, icon, run: go(run) });
    const creates: CreateKind[] = ['quiz', 'test', 'flashcards', 'diagram', 'plan'];
    for (const kind of creates) {
      if (q && includes(kindLabels[kind], `/${kind}`, `new ${kind}`)) {
        out.push({ id: `create-${kind}`, group: 'Make', label: `New ${kindLabels[kind].toLowerCase()}`, detail: `/${kind}`, icon: kindIcons[kind], run: go(() => openGenerate({ kind })) });
      }
    }
    if (!q) {
      for (const chat of [...state.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)) {
        out.push({ id: `chat-${chat.id}`, group: 'Recent chats', label: chat.title || 'New chat', detail: timeAgo(chat.updatedAt), icon: MessageSquare, run: go(() => navigate({ kind: 'chat', chatId: chat.id })) });
      }
    } else {
      for (const match of matches) {
        out.push({ id: match.id, group: 'In your study', label: match.label, match, icon: resultIcons[match.kind], run: go(() => navigate(match.target)) });
      }
    }
    return out;
  }, [trimmedQuery, matches, state.chats, navigate, openGenerate, onClose]);

  useEffect(() => setHighlight(0), [query, matches]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight(index => Math.max(0, Math.min(results.length - 1, index + 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight(index => Math.max(0, index - 1));
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
        <input autoFocus value={query} maxLength={MAX_SEARCH_QUERY_LENGTH} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown}
          placeholder="Search chats, resources and attachments" aria-label="Search" role="combobox" aria-expanded aria-controls={listId}
          aria-activedescendant={results[highlight] ? `${listId}-${highlight}` : undefined} />
        <kbd>esc</kbd>
      </div>
      <ul className="palette__list" role="listbox" id={listId} ref={list} aria-label="Results" aria-busy={loading}>
        {results.map((result, index) => {
          const header = result.group !== lastGroup ? result.group : null;
          lastGroup = result.group;
          const Icon = result.icon;
          return <li key={result.id} role="presentation">
            {header ? <div className="palette__group" role="presentation">{header}</div> : null}
            <div id={`${listId}-${index}`} role="option" aria-selected={index === highlight} className={`palette__item${result.match ? ' palette__item--match' : ''}`}
              onMouseMove={() => setHighlight(index)} onClick={result.run}>
              <Icon size={15} aria-hidden />
              {result.match ? <div className="palette__match">
                <div className="palette__heading"><span className="palette__label">{result.label}</span><span className="palette__source">{result.match.sourceLabel}</span></div>
                {result.match.contextLabel ? <span className="palette__context">{result.match.contextLabel}</span> : null}
                <span className="palette__snippet"><HighlightedSnippet result={result.match} /></span>
              </div> : <><span className="palette__label">{result.label}</span>{result.detail ? <span className="palette__detail">{result.detail}</span> : null}</>}
            </div>
          </li>;
        })}
        {loading ? <li className="palette__empty" role="status">Searching your study…</li> : null}
        {error ? <li className="palette__empty" role="alert">Search couldn&rsquo;t finish. {error}</li> : null}
        {!loading && !error && results.length === 0 ? <li className="palette__empty">Nothing matches &ldquo;{query}&rdquo;</li> : null}
      </ul>
    </Dialog>
  );
}
