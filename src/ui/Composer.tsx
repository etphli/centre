import { ArrowUp, Plus, Square } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { kindDescriptions, kindIcons, kindLabels } from './icons';
import type { CreateKind } from './types';
import { ModelMenu } from './ModelMenu';
import { AttachmentButton, useComposerAttachments } from './Attachments';
import './attachments.css';
import { useApp } from './context';
import { promptDraft, promptDraftKey, type PromptDraft } from '../data/prompt-drafts';

const commands: CreateKind[] = ['quiz', 'test', 'flashcards', 'diagram', 'plan'];
const commandNames: Record<string, CreateKind> = { quiz: 'quiz', test: 'test', flashcards: 'flashcards', cards: 'flashcards', diagram: 'diagram', plan: 'plan', notes: 'notes' };

interface ComposerProps {
  variant: 'hero' | 'dock';
  chatId?:string|null;
  placeholder: string;
  contextLabel: string;
  busy: boolean;
  onSend: (content: string, attachmentIds?:string[]) => void;
  onCancel?: () => void;
  onCommand: (kind: CreateKind, rest: string, attachmentIds?:string[]) => void;
  autoFocus?: boolean;
  notice?: ReactNode;
}

export function Composer(props: ComposerProps) {
  const { state } = useApp();
  const accounts = [state.settings.account?.email.toLowerCase() ?? null, state.settings.cloudAccount?.email.toLowerCase() ?? null];
  const chatId = props.chatId ?? null;
  const draft = promptDraft(accounts, chatId);
  return <DraftComposer key={promptDraftKey(accounts, chatId)} {...props} draft={draft}/>;
}

function DraftComposer({ chatId = null, variant, placeholder, contextLabel, busy, onSend, onCancel, onCommand, autoFocus, notice, draft }: ComposerProps & { draft: PromptDraft }) {
  const { text: value, error: draftError } = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const setValue = draft.setText;
  const { state: { settings } } = useApp();
  const attachments = useComposerAttachments();
  const [dragging,setDragging] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const begin = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
      setValue(`/diagram ${typeof detail === 'string' ? detail : ''}`);
      setMenuDismissed(true);
      requestAnimationFrame(() => textarea.current?.focus());
    };
    const restore = (event:Event) => { const ids:unknown = event instanceof CustomEvent ? event.detail : null; if (Array.isArray(ids) && ids.every((id:unknown):id is string => typeof id === 'string')) void attachments.restore(ids); };
    window.addEventListener('centre:diagram',begin);
    window.addEventListener('centre:restore-attachments',restore);
    return () => { window.removeEventListener('centre:diagram',begin); window.removeEventListener('centre:restore-attachments',restore); };
  },[]);
  const listId = useId();

  const slashQuery = /^\/(\w*)$/.exec(value)?.[1];
  const matches = useMemo(
    () => (slashQuery === undefined ? [] : commands.filter((kind) => kind.startsWith(slashQuery.toLowerCase()) || kindLabels[kind].toLowerCase().includes(slashQuery.toLowerCase()))),
    [slashQuery],
  );
  const menuOpen = matches.length > 0 && !menuDismissed;

  useEffect(() => setHighlight(0), [slashQuery]);
  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, variant === 'hero' ? 320 : 220)}px`;
  }, [value, variant]);

  function runCommand(kind: CreateKind, rest = '') {
    if (kind === 'diagram') { setValue(`/diagram ${rest}`); setMenuDismissed(true); requestAnimationFrame(() => textarea.current?.focus()); return; }
    setValue('');
    setMenuDismissed(false);
    onCommand(kind, rest,attachments.files.map(file => file.id));
    attachments.clear();
  }

  function submit() {
    const text = value.trim() || (attachments.files.length ? 'Please review the attached files.' : '');
    if (!text || busy || attachments.uploading) return;
    const command = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
    const kind = command ? commandNames[command[1]!.toLowerCase()] : undefined;
    if (kind === 'diagram') {
      const description = command?.[2]?.trim() ?? '';
      if (!description) { runCommand('diagram'); return; }
      onSend(text,attachments.files.map(file => file.id));
      attachments.clear();
      setValue('');
      return;
    }
    if (kind) {
      runCommand(kind, command?.[2]?.trim() ?? '');
      return;
    }
    onSend(text,attachments.files.map(file => file.id));
    attachments.clear();
    setValue('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const kind = matches[highlight];
        if (kind) runCommand(kind);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && (settings.sendKey === 'enter' || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  const activeId = menuOpen ? `${listId}-${highlight}` : undefined;

  return (
    <div className={`composer composer--${variant}${dragging ? ' composer--dragging' : ''}`} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); void attachments.addFiles(Array.from(event.dataTransfer.files)); }}>
      {attachments.picker}
      {draftError ? <p className="composer__file-error" role="alert">{draftError}</p> : null}
      {notice ? <div className="composer__notice">{notice}</div> : null}
      <div className="composer__box">
        {attachments.chips}
        {menuOpen ? (
          <ul className="slash-menu" role="listbox" id={listId} aria-label="Create">
            {matches.map((kind, index) => {
              const Icon = kindIcons[kind];
              return (
                <li
                  key={kind}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === highlight}
                  className="slash-menu__item"
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    runCommand(kind);
                  }}
                >
                  <Icon size={16} aria-hidden />
                  <span className="slash-menu__name">/{kind}</span>
                  <span className="slash-menu__description">{kindDescriptions[kind]}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <textarea
          ref={textarea}
          className="composer__input"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label="Message Centre"
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          onChange={(event) => {
            setValue(event.target.value);
            setMenuDismissed(false);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer__tools">
          <AttachmentButton onClick={() => void attachments.pick()} disabled={busy || attachments.uploading} />
          <button
            type="button"
            className="icon-button composer__plus"
            aria-label="Create a resource"
            title="Create a quiz, test, flashcards, diagram or plan"
            onClick={() => {
              setValue('/');
              setMenuDismissed(false);
              textarea.current?.focus();
            }}
          >
            <Plus size={18} />
          </button>
        </div>
        {busy && onCancel ? (
          <button type="button" className="send-button send-button--stop" aria-label="Stop" title="Stop" onClick={onCancel}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button type="button" className="send-button" aria-label="Send" title={settings.sendKey === 'enter' ? 'Send (Enter)' : 'Send (⌘ / Ctrl + Enter)'} disabled={(!value.trim() && !attachments.files.length) || busy || attachments.uploading} onClick={submit}>
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        )}
      </div>
      {attachments.error ? <div className="composer__file-error" role="alert">{attachments.error}<button type="button" aria-label="Dismiss attachment error" onClick={() => attachments.setError('')}>Dismiss</button></div> : null}
      <div className="composer__meta">
        <span className="composer__context" title="Centre sends this page as context">{contextLabel}</span>
        <ModelMenu chatId={chatId} />
      </div>
    </div>
  );
}
