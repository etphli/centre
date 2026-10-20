import { Check, ChevronRight, Maximize2, MessageSquare, PanelRight, Plus, RotateCcw, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Chat, Resource, Snapshot } from '../../shared/schema';
import { Composer } from './Composer';
import { MessageAttachments } from './Attachments';
import { useApp, type Turn } from './context';
import { kindIcons, kindLabels } from './icons';
import { Markdown } from './Markdown';
import { InlineResourcePreview, ResourcePreviewDialog } from './ResourcePreview';
import { routeContext, type CreateKind, type Route } from './types';
import './thinking.css';
import './side-chat.css';

export function contextLabel(route: Route, state: Snapshot): string {
  const context = routeContext(route, state);
  const subject = state.subjects.find((item) => item.id === context.subjectId);
  const topic = state.topics.find((item) => item.id === context.topicId);
  const resource = state.resources.find((item) => item.id === context.resourceId);
  if (resource) return `Using ${resource.title}`;
  if (topic && subject) return `Using ${subject.name} / ${topic.name}`;
  if (subject) return `Using ${subject.name}`;
  if (route.kind === 'calendar') return 'Using your calendar';
  if (route.kind === 'review') return 'Using your weak spots';
  if (route.kind === 'settings') return 'Using your settings and connections';
  return 'Using your subjects and upcoming work';
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="working__time">{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span>;
}

const thinkingPhrases = ['Thinking it through', 'Working through the details', 'Taking a closer look', 'Putting a reply together', 'Checking the reasoning'];

/** Rotates a few neutral phrases while a reply is pending. Screen readers hear one stable label instead of every change. */
function ThinkingLabel() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((value) => (value + 1) % thinkingPhrases.length), 4500);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <span className="visually-hidden">Working</span>
      <span key={index} className="thinking-label" aria-hidden>{thinkingPhrases[index]}</span>
    </>
  );
}

function ThinkingDetails({ steps,working = false }: {steps:Chat['activity'];working?:boolean}) {
  if (!steps.length) return null;
  return <details className="thinking-details"><summary><ChevronRight size={12} />{working ? 'View thinking' : 'Thinking'}<span>{steps.filter(step => step.kind === 'tool').length || ''}</span></summary><div className="thinking-details__body">{steps.map(step => step.kind === 'summary' ? <div className="thinking-details__summary" key={step.id}><span>Reasoning summary</span><Markdown>{step.text}</Markdown></div> : <div className="thinking-details__step" key={step.id}>{step.state === 'done' ? <Check size={12} /> : step.state === 'error' ? <X size={12} className="activity-error" /> : <span className="spinner spinner--small" />}<span>{step.text}</span></div>)}</div></details>;
}

function CodexNotice() {
  const { state, navigate } = useApp();
  if (state.codex.available && state.codex.authenticated) return null;
  // The service starts disconnected while it launches the CLI; that isn't a sign-in problem yet.
  if (/^connecting/i.test(state.codex.message)) return <span className="muted">Connecting to Codex…</span>;
  return (
    <>
      {state.codex.available ? 'Sign in to Codex before chatting.' : 'Codex isn’t available on this computer.'}{' '}
      <button type="button" className="link-button" onClick={() => navigate({ kind: 'settings' })}>
        Open settings
      </button>
    </>
  );
}

/** Messages for a chat plus the in-flight turn, if any. */
export function Thread({ chat, turn, compact = false }: { chat: Chat | undefined; turn: Turn | undefined; compact?: boolean }) {
  const { state,send,cancel } = useApp();
  const [preview,setPreview] = useState<Resource|null>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = chat?.messages ?? [];
  const last = messages[messages.length - 1];
  const showPending = turn && !(last?.role === 'user' && last.content === turn.content) && turn.status !== 'error';
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const liveSteps = chat?.activity ?? [];
  const action = [...liveSteps].reverse().find(step => step.kind === 'tool' && step.state === 'working');

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, turn?.status, showPending]);

  return (
    <div className={`thread${compact ? ' thread--compact' : ''}`} aria-live="polite" aria-busy={turn?.status === 'working'}>
      {messages.map(message => <Fragment key={message.id}>
        {message.role === 'user' ? <div className="message message--user"><div className="message__bubble">{message.content}</div></div> : <div className="message message--assistant"><ThinkingDetails steps={message.activity} /><Markdown>{message.content}</Markdown></div>}
        {message.attachmentIds.length ? <MessageAttachments ids={message.attachmentIds} /> : null}
        {message.resourceIds.length ? <div className="thread-resources">{message.resourceIds.flatMap(id => { const resource = state.resources.find(item => item.id === id); return resource ? [<InlineResourcePreview key={id} resource={resource} onPreview={() => setPreview(resource)} />] : []; })}</div> : null}
      </Fragment>)}
      {preview ? <ResourcePreviewDialog resource={preview} onClose={() => setPreview(null)} /> : null}
      {showPending ? (
        <div className="message message--user message--pending">
          <div className="message__bubble">{turn.content}</div>
        </div>
      ) : null}
      {turn && turn.status !== 'error' ? (
        <div className="working" role="status">
          <span className="working__pulse" aria-hidden><i /><i /><i /></span>
          {turn.status === 'stopping' ? <span>Stopping</span> : action ? <span className="thinking-label">{action.text}</span> : <ThinkingLabel />}
          <Elapsed since={turn.startedAt} />
          {turn.chatId && turn.status === 'working' ? (
            <button type="button" className="button button--quiet button--small" onClick={() => void cancel(turn.chatId!)}>
              Stop
            </button>
          ) : null}
        </div>
      ) : null}
      {turn && turn.status !== 'error' ? <ThinkingDetails steps={liveSteps} working /> : null}
      {turn?.status === 'error' ? (
        <div className="thread-error" role="alert">
          <p>{turn.error}</p>
          <button type="button" className="button button--quiet button--small" onClick={() => void send(turn.content, turn.context, turn.chatId,undefined,turn.attachmentIds)}>
            <RotateCcw size={14} /> Try again
          </button>
        </div>
      ) : null}
      {!turn && last?.role === 'user' && lastAssistant !== last ? (
        <p className="thread-note">No reply yet. Send another message or try again.</p>
      ) : null}
      <div ref={end} />
    </div>
  );
}

type Greeting = { text: string; question?: boolean; hours?: [number, number] };

const greetings: Greeting[] = [
  { text: 'Good morning', hours: [5, 12] },
  { text: 'Good afternoon', hours: [12, 18] },
  { text: 'Good evening', hours: [18, 24] },
  { text: 'Studying late', question: true, hours: [0, 5] },
  { text: 'Still going', question: true, hours: [21, 24] },
  { text: 'Fresh start this morning', question: true, hours: [5, 11] },
  { text: 'What are we studying today', question: true },
  { text: 'Where should we start', question: true },
  { text: 'Back at it' },
  { text: 'Ready when you are' },
  { text: 'What’s on your desk', question: true },
  { text: 'What are we working through', question: true },
  { text: 'Let’s pick something up' },
];

let lastGreeting = '';

/** A different opening line each time home opens, matched to the time of day and addressed by nickname when there is one. */
function pickGreeting(name: string): string {
  const hour = new Date().getHours();
  const fits = greetings.filter((item) => !item.hours || (hour >= item.hours[0] && hour < item.hours[1]));
  const fresh = fits.filter((item) => item.text !== lastGreeting);
  const choice = fresh[Math.floor(Math.random() * fresh.length)] ?? fits[0]!;
  lastGreeting = choice.text;
  return `${choice.text}${name ? `, ${name}` : ''}${choice.question ? '?' : ''}`;
}

export function HomeView() {
  const { state, route, send, navigate, openGenerate, turns } = useApp();
  const pending = turns.find((turn) => turn.chatId === null);
  const name = state.settings.nickname.trim() || state.settings.account?.name.trim().split(/\s+/)[0] || '';
  // Picked once per visit so it doesn't change under the user while they type.
  const [opening,setOpening] = useState(() => ({ name, text: pickGreeting(name) }));
  useEffect(() => { if (opening.name !== name) setOpening({ name,text:pickGreeting(name) }); },[name,opening.name]);
  const heading = opening.text;
  const shortcuts: CreateKind[] = ['quiz', 'test', 'flashcards', 'diagram', 'plan'];

  if (pending) {
    return (
      <div className="chat-page">
        <div className="chat-page__scroll">
          <Thread chat={undefined} turn={pending} />
        </div>
        <div className="chat-page__composer">
          <Composer variant="dock" placeholder="Reply to Centre" contextLabel={contextLabel(route, state)} busy onSend={() => undefined} onCommand={(kind, rest,attachmentIds) => openGenerate({ kind,attachmentIds, instructions: rest })} />
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home__center">
        <h1 className="home__greeting">{heading}</h1>
        <Composer
          variant="hero"
          autoFocus
          placeholder="Ask about your work, or type / to make something"
          contextLabel={contextLabel(route, state)}
          busy={false}
          notice={<CodexNotice />}
          onSend={(content,attachmentIds) => {
            void send(content, routeContext(route, state), null, (chatId) => navigate({ kind: 'chat', chatId }),attachmentIds);
          }}
          onCommand={(kind, rest,attachmentIds) => openGenerate({ kind,attachmentIds, instructions: rest })}
        />
        <div className="home__shortcuts" role="group" aria-label="Make something">
          {shortcuts.map((kind) => {
            const Icon = kindIcons[kind];
            return (
              <button key={kind} type="button" className="chip" onClick={() => openGenerate({ kind })}>
                <Icon size={14} aria-hidden /> {kindLabels[kind]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ChatPage({ chatId }: { chatId: string }) {
  const { state, route, send, cancel, openGenerate, turns, navigate } = useApp();
  const chat = state.chats.find((item) => item.id === chatId);
  const turn = turns.find((item) => item.chatId === chatId);
  const busy = turn?.status === 'working' || turn?.status === 'stopping';

  if (!chat && !turn) {
    return (
      <div className="empty-page">
        <MessageSquare size={22} aria-hidden />
        <h1>This chat isn&rsquo;t here anymore</h1>
        <button type="button" className="button" onClick={() => navigate({ kind: 'home' })}>
          Start a new chat
        </button>
      </div>
    );
  }

  return (
    <div className="chat-page">
      <div className="chat-page__scroll">
        <Thread chat={chat} turn={turn} />
      </div>
      <div className="chat-page__composer">
        <Composer
          variant="dock"
          autoFocus
          placeholder="Reply to Centre"
          contextLabel={contextLabel(route, state)}
          busy={busy}
          notice={<CodexNotice />}
          onSend={(content,attachmentIds) => void send(content, routeContext(route, state), chatId,undefined,attachmentIds)}
          onCancel={() => void cancel(chatId)}
          onCommand={(kind, rest,attachmentIds) => openGenerate({ kind,attachmentIds, instructions: rest })}
        />
      </div>
    </div>
  );
}

/** Persistent bottom composer on non-chat pages while the side chat is closed. Sending opens the side chat. */
export function ChatDock() {
  const { state, route, sideChat, askHere, openSideChat, openGenerate } = useApp();
  const context = routeContext(route, state);
  const chat = state.chats.find((item) => item.id === sideChat.chatId);
  return (
    <div className="dock">
      {chat ? (
        <button type="button" className="dock__reopen" onClick={() => openSideChat()}>
          <PanelRight size={13} aria-hidden /> Show chat: {chat.title || 'New chat'}
        </button>
      ) : null}
      <Composer
        variant="dock"
        placeholder="Ask about this page, or type / to make something"
        contextLabel={contextLabel(route, state)}
        busy={false}
        notice={<CodexNotice />}
        onSend={(content,attachmentIds) => askHere(content, context,attachmentIds)}
        onCommand={(kind, rest,attachmentIds) => openGenerate({ kind,attachmentIds, subjectId: context.subjectId, topicId: context.topicId, instructions: rest })}
      />
    </div>
  );
}

/** Chat beside the current page. Each message carries the page's context at the moment it is sent. */
export function SideChat() {
  const { state, route, sideChat, askHere, cancel, openSideChat, closeSideChat, openGenerate, turns, navigate } = useApp();
  const panel = useRef<HTMLElement>(null);
  const { chatId } = sideChat;
  const context = routeContext(route, state);
  const chat = useMemo(() => state.chats.find((item) => item.id === chatId), [state.chats, chatId]);
  const turn = turns.find((item) => item.chatId === chatId);
  const busy = turn?.status === 'working' || turn?.status === 'stopping';

  function close() {
    closeSideChat();
    // The bottom composer comes back in place of the panel; keep the keyboard there.
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.dock textarea')?.focus());
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && panel.current?.contains(document.activeElement) && !document.querySelector('dialog[open]')) close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <aside className="side-chat" aria-label="Chat" ref={panel}>
      <header className="side-chat__header">
        <span className="side-chat__title">{chat?.title || 'New chat'}</span>
        <button type="button" className="icon-button icon-button--small" aria-label="New chat" title="New chat" disabled={!chatId && !turn} onClick={() => openSideChat(null)}>
          <Plus size={15} />
        </button>
        <button
          type="button"
          className="icon-button icon-button--small"
          aria-label="Open as full chat"
          title="Open as full chat"
          disabled={!chatId}
          onClick={() => {
            closeSideChat();
            if (chatId) navigate({ kind: 'chat', chatId });
          }}
        >
          <Maximize2 size={14} />
        </button>
        <button type="button" className="icon-button icon-button--small" aria-label="Close chat" title="Close chat (Esc)" onClick={close}>
          <X size={15} />
        </button>
      </header>
      <div className="side-chat__scroll">
        {chat || turn ? (
          <Thread chat={chat} turn={turn} compact />
        ) : (
          <p className="side-chat__empty">Ask about what&rsquo;s on this page. Each message is sent with the page you&rsquo;re on, so you can keep working while Centre replies.</p>
        )}
      </div>
      <div className="side-chat__composer">
        <Composer
          variant="dock"
          autoFocus
          placeholder={chat ? 'Reply to Centre' : 'Ask about this page'}
          contextLabel={contextLabel(route, state)}
          busy={busy}
          notice={<CodexNotice />}
          onSend={(content,attachmentIds) => askHere(content, context,attachmentIds)}
          onCancel={chatId ? () => void cancel(chatId) : undefined}
          onCommand={(kind, rest,attachmentIds) => openGenerate({ kind,attachmentIds, subjectId: context.subjectId, topicId: context.topicId, instructions: rest })}
        />
      </div>
    </aside>
  );
}
