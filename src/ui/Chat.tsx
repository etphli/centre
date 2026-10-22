import { BookOpen, Check, ChevronRight, GitBranch, Maximize2, MessageSquare, PanelRight, Pencil, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chat, Message, Resource, Snapshot } from '../../shared/schema';
import { api } from '../data/client';
import { Composer } from './Composer';
import { MessageAttachments } from './Attachments';
import { useApp, type Turn } from './context';
import { kindIcons, kindLabels } from './icons';
import { Markdown } from './Markdown';
import { InlineResourcePreview, ResourcePreviewDialog } from './ResourcePreview';
import { routeContext, type CreateKind, type Route } from './types';
import { useSearchTarget } from './useSearchTarget';
import './thinking.css';
import './side-chat.css';
import './chat-branches.css';

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

function ActivityBody({ steps }: {steps:Chat['activity']}) {
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (body.current && follow.current) body.current.scrollTop = body.current.scrollHeight; },[steps]);
  return <div className="thinking-details__body" ref={body} onScroll={() => { const node = body.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; }}>
    {steps.some(step => step.kind !== 'skill') ? steps.filter(step => step.kind !== 'skill').map(step => step.kind === 'tool' ? <div className="thinking-details__step" key={step.id}>{step.state === 'done' ? <Check size={12} /> : step.state === 'error' ? <X size={12} className="activity-error" /> : <span className="spinner spinner--small" />}<span>{step.text}</span></div> : <div className="thinking-details__summary" key={step.id}><Markdown>{step.text}</Markdown></div>) : <p>Preparing the response…</p>}
  </div>;
}

function SkillUsage({ steps }: {steps:Chat['activity']}) {
  const names = [...new Set(steps.filter(step => step.kind === 'skill').map(step => step.text))];
  return names.length ? <div className="skill-usage" aria-label="Skills used"><BookOpen size={12} aria-hidden /><span>Skills</span>{names.map(name => <span className="skill-usage__name" key={name}>{name}</span>)}</div> : null;
}

function ThinkingDetails({ steps,duration }: {steps:Chat['activity'];duration:number|null}) {
  if (!steps.length) return null;
  return <><SkillUsage steps={steps} /><details className="thinking-details"><summary><ChevronRight size={13} />{duration === null ? 'Thinking' : `Worked for ${Math.max(1,Math.round(duration / 1000))}s`}<span>{steps.some(step => step.kind === 'tool') ? `${steps.filter(step => step.kind === 'tool').length} actions` : ''}</span></summary><ActivityBody steps={steps} /></details></>;
}

function WorkingActivity({ steps,turn,waiting,onStop,onExpand }: {steps:Chat['activity'];turn:Turn;waiting:boolean;onStop:() => void;onExpand:() => void}) {
  const action = [...steps].reverse().find(step => step.kind === 'tool' && step.state === 'working');
  return <><SkillUsage steps={steps} /><div className="activity-row">
    <details className="thinking-details thinking-details--live" onToggle={event => { if (event.currentTarget.open) requestAnimationFrame(onExpand); }}>
      <summary><ChevronRight size={13} /><span className="working__pulse" aria-hidden><i /><i /><i /></span><span className="activity-row__label">{turn.status === 'stopping' ? 'Stopping' : waiting ? 'Waiting for your answer' : action ? action.text : <ThinkingLabel />}</span><Elapsed since={turn.startedAt} /></summary>
      <ActivityBody steps={steps} />
    </details>
    {turn.chatId && turn.status === 'working' ? <button type="button" className="activity-row__stop" onClick={onStop} aria-label="Stop response"><span aria-hidden />Stop</button> : null}
  </div></>;
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

type BranchLineage = Extract<Chat['lineage'], { kind: 'branch' }>;
type BranchOperation = BranchLineage['operation'];

/** A short, plain excerpt so repeated per-message buttons have distinct accessible names. */
function excerpt(text: string): string {
  const plain = text.replace(/[`*_#>[\]()!|~]/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) return 'empty message';
  return plain.length > 48 ? `${plain.slice(0, 47).trimEnd()}…` : plain;
}

/** Opens a chat where the user already is: the side panel stays a side panel, the full page stays full. */
function useOpenChat(compact: boolean): (chatId: string) => void {
  const { navigate, openSideChat } = useApp();
  return (chatId) => (compact ? openSideChat(chatId) : navigate({ kind: 'chat', chatId }));
}

/**
 * Which messages in a branch are new rather than inherited. Branches copy the parent's messages in order,
 * so the source message's position in the parent marks the edited prompt or replaced reply in the child.
 */
function branchMarks(chat: Chat, lineage: BranchLineage, parent: Chat | undefined): { prompt: string | null; reply: string | null } {
  if (lineage.operation === 'continue') return { prompt: null, reply: null };
  if (lineage.promptMessageId) {
    const index = chat.messages.findIndex(message => message.id === lineage.promptMessageId);
    if (index >= 0) return {prompt:lineage.operation === 'edit' ? lineage.promptMessageId : null,reply:chat.messages.slice(index + 1).find(message => message.role === 'assistant')?.id ?? null};
  }
  const fromParent = parent ? parent.messages.findIndex((message) => message.id === lineage.sourceMessageId) : -1;
  const index = fromParent >= 0 ? fromParent : chat.messages.findIndex((message) => message.id === lineage.sourceMessageId);
  if (index < 0) return { prompt: null, reply: null };
  const source = chat.messages[index];
  const prompt = lineage.operation === 'edit' && source?.role === 'user' ? source.id : null;
  const reply = source?.role === 'assistant' ? source : chat.messages.slice(index + 1).find((message) => message.role === 'assistant');
  return { prompt, reply: reply?.id ?? null };
}

function LineageBanner({ lineage, parent, compact }: { lineage: BranchLineage; parent: Chat | undefined; compact: boolean }) {
  const openChat = useOpenChat(compact);
  const title = parent?.title || 'Untitled chat';
  return (
    <div className="branch-banner" role="note">
      <GitBranch size={13} aria-hidden className="branch-banner__icon" />
      <p>
        {parent ? <>Branched from <span className="branch-banner__title">{title}</span></> : 'Branched from a chat that’s no longer available'}
      </p>
      {parent ? (
        <button type="button" className="link-button branch-banner__open" aria-label={`Open original chat: ${title}`} onClick={() => openChat(lineage.parentChatId)}>
          Open original
        </button>
      ) : null}
    </div>
  );
}

function BranchLabel({ label, note }: { label: string; note?: boolean }) {
  return (
    <div className="branch-label">
      <span className="branch-label__name"><GitBranch size={11} aria-hidden />{label}</span>
      {note ? <span className="branch-label__note">No connected files, events or saved resources were changed.</span> : null}
    </div>
  );
}

/** Inline replacement for a sent prompt. Saving never changes this chat; it starts a branch from the edit. */
function PromptEditor({ message, locked, onCancel, onSave }: { message: Message; locked: boolean; onCancel: () => void; onSave: (content: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const content = draft.trim();
  const ready = content.length > 0 && content !== message.content.trim() && !locked && !saving;

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight + 2, 320)}px`;
  }, [draft]);

  async function save() {
    if (!ready) return;
    setSaving(true);
    if (!(await onSave(content))) setSaving(false);
  }

  return (
    <form className="prompt-editor" aria-label="Edit prompt" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <textarea
        ref={field}
        className="prompt-editor__field"
        aria-label="Edited prompt"
        aria-describedby={`prompt-editor-hint-${message.id}`}
        value={draft}
        rows={2}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Keep Escape here so it doesn't also close the side chat.
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="prompt-editor__footer">
        <p id={`prompt-editor-hint-${message.id}`} className="prompt-editor__hint">
          {locked ? 'Wait for the current reply to finish.' : 'Opens a new branch. This chat stays as it is.'}
        </p>
        <button type="button" className="button button--quiet button--small" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="button button--primary button--small" disabled={!ready}>
          {saving ? 'Starting branch…' : 'Save and continue in branch'}
        </button>
      </div>
    </form>
  );
}

function MessageActions({ message, locked, busy, visible, onEdit, onBranch, onRegenerate }: { message: Message; locked: boolean; busy: boolean; visible: boolean; onEdit?: () => void; onBranch: () => void; onRegenerate?: () => void }) {
  const subject = excerpt(message.content);
  const kind = message.role === 'user' ? 'prompt' : 'reply';
  const disabled = locked || busy;
  const hint = locked ? 'Available when the current reply finishes' : undefined;
  return (
    <div className={`message-actions message-actions--${message.role}${visible ? ' is-shown' : ''}`} role="group" aria-label={`Actions for ${kind}: ${subject}`}>
      {onEdit ? (
        <button type="button" className="message-action" disabled={disabled} title={hint} aria-label={`Edit prompt: ${subject}`} onClick={onEdit}>
          <Pencil size={12} aria-hidden /><span>Edit prompt</span>
        </button>
      ) : null}
      {onRegenerate ? (
        <button type="button" className="message-action" disabled={disabled} title={hint} aria-label={`Regenerate reply: ${subject}`} onClick={onRegenerate}>
          <RefreshCw size={12} aria-hidden /><span>Regenerate</span>
        </button>
      ) : null}
      <button type="button" className="message-action" disabled={disabled} title={hint} aria-label={`Branch from ${kind}: ${subject}`} onClick={onBranch}>
        <GitBranch size={12} aria-hidden /><span>Branch from here</span>
      </button>
    </div>
  );
}

/** Messages for a chat plus the in-flight turn, if any. */
export function Thread({ chat, turn, compact = false, messageId }: { chat: Chat | undefined; turn: Turn | undefined; compact?: boolean; messageId?: string }) {
  const { state, send, cancel, act } = useApp();
  const openChat = useOpenChat(compact);
  const [preview,setPreview] = useState<Resource|null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const messages = chat?.messages ?? [];
  const last = messages[messages.length - 1];
  const showPending = turn && !(last?.role === 'user' && last.content === turn.content) && turn.status !== 'error';
  const liveSteps = chat?.activity ?? [];
  const waiting = state.pendingQuestions.some(request => request.chatId === chat?.id);
  const responding = state.activeResponses.some(response => response.chatId === chat?.id);
  // Branching, editing and retrying wait for the chat to settle: no reply running or stopping, no question open.
  const locked = responding || waiting || turn?.status === 'working' || turn?.status === 'stopping';

  const lineage = chat?.lineage.kind === 'branch' ? chat.lineage : null;
  const parent = lineage ? state.chats.find(item => item.id === lineage.parentChatId && !item.deletedAt) : undefined;
  const marks = chat && lineage ? branchMarks(chat, lineage, parent) : { prompt: null, reply: null };

  // A prompt is complete once a reply follows it. Only the tail of the thread can be waiting on one.
  const replied = new Set<string>();
  let seenReply = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant') seenReply = true;
    else if (seenReply) replied.add(message.id);
  }
  const unanswered = last?.role === 'user' ? last : undefined;
  // A local send that failed may or may not have saved its prompt. Retry a saved prompt; only resend one that never arrived.
  const failed = turn?.status === 'error' ? turn : undefined;
  const failedSaved = failed ? messages.some(message => message.id === failed.messageId) : false;
  const failedRetry = failed && failedSaved && unanswered?.id === failed.messageId ? unanswered : undefined;
  const failedResend = failed && !failedSaved ? failed : undefined;
  const stalled = !failedRetry && !failedResend && !locked && unanswered ? unanswered : undefined;

  async function branch(message: Message, operation: BranchOperation, content?: string): Promise<boolean> {
    if (!chat || locked || working) return false;
    setWorking(message.id);
    const child = await act(() => api.branchChat(chat.id, { operation, messageId: message.id, content }));
    setWorking(null);
    if (!child) return false;
    setEditing(null);
    openChat(child.id);
    return true;
  }

  async function retry(message: Message) {
    if (!chat || locked || working) return;
    setWorking(message.id);
    await act(() => api.retryMessage(chat.id, message.id));
    setWorking(null);
  }

  useEffect(() => {
    follow.current = true;
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, turn?.status, showPending]);
  useEffect(() => {
    const container = end.current?.closest('.main__content,.side-chat__scroll');
    if (!container) return;
    const onScroll = () => { follow.current = container.scrollHeight - container.scrollTop - container.clientHeight < 160; };
    container.addEventListener('scroll',onScroll,{passive:true});
    return () => container.removeEventListener('scroll',onScroll);
  },[]);
  useEffect(() => { if (turn && follow.current) end.current?.scrollIntoView({block:'end'}); },[liveSteps,turn?.id]);
  useSearchTarget(messageId ? `chat-message-${messageId}` : undefined);
  useEffect(() => { setEditing(null); }, [chat?.id]);

  function retryNotice(message: string, onRetry: () => void, alert: boolean) {
    return (
      <div className={alert ? 'thread-error' : 'thread-error thread-error--quiet'} role={alert ? 'alert' : 'status'}>
        <p>{message}{!failedResend ? <small className="retry-note">Retry uses saved history without changing connected files, events or saved resources.</small> : null}</p>
        <button type="button" className="button button--quiet button--small" disabled={locked || working !== null} onClick={onRetry}>
          <RotateCcw size={14} aria-hidden /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className={`thread${compact ? ' thread--compact' : ''}`} aria-live="polite" aria-busy={turn?.status === 'working'}>
      {lineage ? <LineageBanner lineage={lineage} parent={parent} compact={compact} /> : null}
      {messages.map(message => {
        const isEditing = editing === message.id;
        const actionable = chat && !isEditing && (message.role === 'assistant' || replied.has(message.id));
        return (
          <div id={`chat-message-${message.id}`} className="thread__item" key={message.id}>
            {message.role === 'user' ? (
              <div className="message message--user">
                {marks.prompt === message.id ? <BranchLabel label="Edited prompt" /> : null}
                {isEditing ? (
                  <PromptEditor message={message} locked={locked} onCancel={() => setEditing(null)} onSave={(content) => branch(message, 'edit', content)} />
                ) : (
                  <div className="message__bubble">{message.content}</div>
                )}
              </div>
            ) : (
              <div className="message message--assistant">
                {marks.reply === message.id ? <BranchLabel label={lineage?.operation === 'edit' ? 'Reply to edited prompt' : 'Alternate reply'} note /> : null}
                <ThinkingDetails steps={message.activity} duration={message.responseDurationMs} />
                <Markdown>{message.content}</Markdown>
              </div>
            )}
            {message.attachmentIds.length ? <MessageAttachments ids={message.attachmentIds} /> : null}
            {message.resourceIds.length ? <div className="thread-resources">{message.resourceIds.flatMap(id => { const resource = state.resources.find(item => item.id === id); return resource ? [<InlineResourcePreview key={id} resource={resource} onPreview={() => setPreview(resource)} />] : []; })}</div> : null}
            {actionable ? (
              <MessageActions
                message={message}
                locked={locked}
                busy={working !== null}
                visible={message === last || working === message.id}
                onEdit={message.role === 'user' ? () => setEditing(message.id) : undefined}
                onRegenerate={message.role === 'assistant' ? () => void branch(message, 'regenerate') : undefined}
                onBranch={() => void branch(message, 'continue')}
              />
            ) : null}
          </div>
        );
      })}
      {preview ? <ResourcePreviewDialog resource={preview} onClose={() => setPreview(null)} /> : null}
      {showPending ? (
        <div className="message message--user message--pending">
          <div className="message__bubble">{turn.content}</div>
        </div>
      ) : null}
      {turn && turn.status !== 'error' ? <WorkingActivity steps={liveSteps} turn={turn} waiting={waiting} onExpand={() => { follow.current = true; end.current?.scrollIntoView({block:'end'}); }} onStop={() => { if (turn.chatId) void cancel(turn.chatId); }} /> : null}
      {failedRetry ? retryNotice(failed?.error ?? chat?.responseError ?? 'No reply yet.', () => void retry(failedRetry), true) : null}
      {failedResend ? retryNotice(failedResend.error ?? 'The message wasn’t sent.', () => void send(failedResend.content, failedResend.context, failedResend.chatId, undefined, failedResend.attachmentIds, failedResend.resourceRequest), true) : null}
      {stalled ? retryNotice(chat?.responseError ?? 'No reply yet.', () => void retry(stalled), Boolean(chat?.responseError)) : null}
      <div ref={end} className="thread__end" />
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

export function ChatPage({ chatId, messageId }: { chatId: string; messageId?: string }) {
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
        <Thread chat={chat} turn={turn} messageId={messageId} />
      </div>
      <div className="chat-page__composer">
        <Composer
          variant="dock"
          autoFocus
          chatId={chatId}
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
  const { state, route, sideChat, askHere, openSideChat, openGenerate, turns, cancel } = useApp();
  const context = routeContext(route, state);
  const chat = state.chats.find((item) => item.id === sideChat.chatId);
  const busy = turns.some(turn => turn.chatId === sideChat.chatId && turn.status !== 'error');
  return (
    <div className="dock">
      {chat ? (
        <button type="button" className="dock__reopen" onClick={() => openSideChat()}>
          <PanelRight size={13} aria-hidden /> Show chat: {chat.title || 'New chat'}
        </button>
      ) : null}
      <Composer
        variant="dock"
        chatId={sideChat.chatId}
        placeholder="Ask about this page, or type / to make something"
        contextLabel={contextLabel(route, state)}
        busy={busy}
        onCancel={chat ? () => void cancel(chat.id) : undefined}
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
          chatId={chatId}
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
