import { ArrowLeft, ArrowRight, PanelLeft, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../data/client';
import { useCentre } from '../data/useCentre';
import type { ModelSelection, CreateResource, PageContext, Resource, Snapshot } from '../../shared/schema';
import { CalendarPage } from './Calendar';
import { ChatDock, ChatPage, HomeView, SideChat } from './Chat';
import { CentreContext, type CentreActions, type SideChatState, type Turn } from './context';
import { EventDialog, FeedbackDialog } from './Dialogs';
import { errorMessage } from './format';
import { QuestionDialog } from './QuestionDialog';
import { GenerateDialog } from './GenerateDialog';
import { kindLabels } from './icons';
import { ResourceView } from './ResourceView';
import { SubjectPage, SubjectsPage, TopicPage } from './Resources';
import { ReviewPage } from './Review';
import { SearchPalette } from './SearchPalette';
import { SettingsPage } from './Settings';
import { PreferencesEffect } from './preferences';
import { Sidebar } from './Sidebar';
import { Toasts, type Toast } from './Toasts';
import type { GenerateRequest, Route, ToastInput } from './types';
import './centre.css';

type Modal =
  | { kind: 'generate'; request: GenerateRequest; key: number }
  | { kind: 'event'; date?: string }
  | { kind: 'feedback'; resource: Resource; questionIds: string[] }
  | { kind: 'search' }
  | null;

const dockedRoutes: Route['kind'][] = ['resources', 'subject', 'topic', 'resource', 'calendar', 'review', 'settings'];

function Crumbs({ route, state, navigate }: { route: Route; state: Snapshot; navigate: (route: Route) => void }) {
  const crumbs: { label: string; to?: Route }[] = [];
  const subjectName = (id: string) => state.subjects.find((subject) => subject.id === id)?.name ?? 'Subject';
  switch (route.kind) {
    case 'home':
      crumbs.push({ label: 'New chat' });
      break;
    case 'chat':
      crumbs.push({ label: state.chats.find((chat) => chat.id === route.chatId)?.title || 'New chat' });
      break;
    case 'resources':
      crumbs.push({ label: 'Resources' });
      break;
    case 'subject':
      crumbs.push({ label: 'Resources', to: { kind: 'resources' } }, { label: subjectName(route.subjectId) });
      break;
    case 'topic':
      crumbs.push(
        { label: 'Resources', to: { kind: 'resources' } },
        { label: subjectName(route.subjectId), to: { kind: 'subject', subjectId: route.subjectId } },
        { label: state.topics.find((topic) => topic.id === route.topicId)?.name ?? 'Topic' },
      );
      break;
    case 'resource': {
      const resource = state.resources.find((item) => item.id === route.resourceId);
      const topic = state.topics.find((item) => item.id === resource?.topicId);
      crumbs.push({ label: 'Resources', to: { kind: 'resources' } });
      if (resource?.subjectId) crumbs.push({ label: subjectName(resource.subjectId), to: { kind: 'subject', subjectId: resource.subjectId } });
      else if (resource) crumbs.push({label:'Personal learning'});
      if (topic) crumbs.push({ label: topic.name, to: { kind: 'topic', subjectId: topic.subjectId, topicId: topic.id } });
      crumbs.push({ label: resource?.title ?? 'Resource' });
      break;
    }
    case 'calendar':
      crumbs.push({ label: 'Calendar' });
      break;
    case 'review':
      crumbs.push({ label: 'Review' });
      break;
    case 'settings':
      crumbs.push({ label: 'Settings' });
      break;
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={index}>
            {crumb.to ? (
              <button type="button" className="crumbs__link" onClick={() => navigate(crumb.to!)}>{crumb.label}</button>
            ) : (
              <span className="crumbs__current" aria-current="page">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.kind) {
    case 'home':
      return <HomeView />;
    case 'chat':
      return <ChatPage key={route.chatId} chatId={route.chatId} messageId={route.messageId} />;
    case 'resources':
      return <SubjectsPage />;
    case 'subject':
      return <SubjectPage subjectId={route.subjectId} />;
    case 'topic':
      return <TopicPage subjectId={route.subjectId} topicId={route.topicId} />;
    case 'resource':
      return <ResourceView resourceId={route.resourceId} questionId={route.questionId} />;
    case 'calendar':
      return <CalendarPage />;
    case 'review':
      return <ReviewPage />;
    case 'settings':
      return <SettingsPage />;
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

export default function CentreApp() {
  const { state, loading, error, refresh } = useCentre();
  const [history, setHistory] = useState<{ stack: Route[]; index: number }>({ stack: [{ kind: 'home' }], index: 0 });
  const route = history.stack[history.index] ?? { kind: 'home' };
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [modal, setModal] = useState<Modal>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [draftModelSelection,setDraftModelSelection] = useState<ModelSelection|null>(null);
  const selectModel = useCallback(async (chatId:string|null,selection:ModelSelection) => {
    if (chatId) return api.selectChatModel(chatId,selection);
    setDraftModelSelection(selection); return selection;
  },[]);
  const [localTurns, setTurns] = useState<Turn[]>([]);
  const inFlight = useRef(new Set<string|null>());
  const turns = useMemo(() => {
    const active = state?.activeResponses ?? [];
    const result = localTurns.filter(turn => turn.status !== 'error' || !active.some(response => response.chatId === turn.chatId));
    for (const response of active) {
      if (result.some(turn => turn.chatId === response.chatId)) continue;
      const chat = state?.chats.find(chat => chat.id === response.chatId);
      if (!chat) continue;
      const message = [...chat.messages].reverse().find(message => message.role === 'user');
      result.push({id:-response.startedAt,chatId:response.chatId,content:message?.content ?? '',attachmentIds:message?.attachmentIds ?? [],context:{page:'chat'},status:response.status,startedAt:response.startedAt});
    }
    return result;
  },[localTurns,state]);
  const [generating, setGenerating] = useState<{ id: number; label: string }[]>([]);
  const [sideChat, setSideChat] = useState<SideChatState>({ open: false, chatId: null });
  const [homeVisit,setHomeVisit] = useState(0);
  const [navigationId, setNavigationId] = useState(0);
  const seq = useRef(0);
  const stopped = useRef(new Set<number>());
  const main = useRef<HTMLDivElement>(null);

  const navigate = useCallback((next: Route) => {
    setNavigationId(value => value + 1);
    if (next.kind === 'home') setHomeVisit(value => value + 1);
    setHistory((current) => {
      const here = current.stack[current.index];
      if (here && JSON.stringify(here) === JSON.stringify(next)) return current;
      const stack = [...current.stack.slice(0, current.index + 1), next].slice(-50);
      return { stack, index: stack.length - 1 };
    });
  }, []);
  const go = useCallback((step: number) => setHistory((current) => ({ ...current, index: Math.min(current.stack.length - 1, Math.max(0, current.index + step)) })), []);

  useEffect(() => {
    if ((route.kind === 'chat' && route.messageId) || (route.kind === 'resource' && route.questionId)) return;
    main.current?.scrollTo({ top: 0 });
  }, [route]);

  const notify = useCallback((toast: ToastInput) => {
    seq.current += 1;
    const id = seq.current;
    setToasts((list) => [...list.slice(-3), { ...toast, id }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const quietRefresh = useCallback(() => refresh().catch(() => undefined), [refresh]);

  const act = useCallback(async <T,>(work: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const result = await work();
      await quietRefresh();
      if (success) notify({ tone: 'success', message: success });
      return result;
    } catch (failure) {
      notify({ tone: 'error', message: errorMessage(failure) });
      return undefined;
    }
  }, [notify, quietRefresh]);

  const send = useCallback(async (content: string, context: PageContext, chatId: string | null, onCreated?: (chatId: string) => void, attachmentIds:string[] = [], resourceRequest?:CreateResource): Promise<string | null> => {
    if (inFlight.current.has(chatId) || state?.activeResponses.some(response => response.chatId === chatId)) return chatId;
    inFlight.current.add(chatId);
    seq.current += 1;
    const id = seq.current;
    const messageId = crypto.randomUUID();
    const update = (patch: Partial<Turn>) => setTurns((list) => list.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)));
    const remove = () => setTurns((list) => list.filter((turn) => turn.id !== id));
    setTurns((list) => [...list.filter((turn) => turn.chatId !== chatId), { id,messageId, chatId, content, context, attachmentIds, resourceRequest, status: 'working', startedAt: Date.now() }]);
    let target = chatId;
    try {
      if (!target) {
        const chat = await api.createChat(draftModelSelection);
        setDraftModelSelection(null);
        target = chat.id;
        inFlight.current.add(target);
        inFlight.current.delete(null);
        update({ chatId: target });
        await quietRefresh();
        onCreated?.(target);
      }
      await api.sendMessage(target, content, context,attachmentIds,resourceRequest,messageId);
      await quietRefresh();
      remove();
    } catch (failure) {
      await quietRefresh();
      if (stopped.current.has(id)) remove();
      else update({ status: 'error', error: errorMessage(failure) });
    } finally {
      stopped.current.delete(id);
      inFlight.current.delete(target);
    }
    return target;
  }, [quietRefresh,draftModelSelection,state?.activeResponses]);

  const hasActiveTurn = turns.some(turn => turn.status !== 'error');
  useEffect(() => {
    if (!hasActiveTurn) return;
    const timer = setInterval(() => { void quietRefresh(); },1000);
    return () => clearInterval(timer);
  },[hasActiveTurn,quietRefresh]);

  const cancel = useCallback(async (chatId: string) => {
    const turn = turns.find((item) => item.chatId === chatId && item.status === 'working');
    if (turn) {
      stopped.current.add(turn.id);
      setTurns((list) => list.map((item) => (item.id === turn.id ? { ...item, status: 'stopping' } : item)));
    }
    try {
      await api.cancelChat(chatId);
    } catch (failure) {
      if (turn) {
        stopped.current.delete(turn.id);
        setTurns((list) => list.map((item) => (item.id === turn.id ? { ...item, status: 'working' } : item)));
      }
      notify({ tone: 'error', message: errorMessage(failure) });
    }
  }, [turns, notify]);

  const openSideChat = useCallback((chatId?: string | null) => setSideChat((current) => ({ open: true, chatId: chatId === undefined ? current.chatId : chatId })), []);
  const closeSideChat = useCallback(() => setSideChat((current) => ({ ...current, open: false })), []);

  const askHere = useCallback((content: string, context: PageContext,attachmentIds:string[] = [], resourceRequest?:CreateResource) => {
    if (route.kind === 'chat') {
      const busy = inFlight.current.has(route.chatId) || turns.some(turn => turn.chatId === route.chatId && turn.status !== 'error');
      if (busy) void send(content,context,null,chatId => navigate({kind:'chat',chatId}),attachmentIds,resourceRequest);
      else void send(content, context, route.chatId,undefined,attachmentIds,resourceRequest);
      return;
    }
    if (!dockedRoutes.includes(route.kind)) {
      void send(content, context, null, (chatId) => navigate({ kind: 'chat', chatId }),attachmentIds,resourceRequest);
      return;
    }
    // Start a fresh chat if the panel's chat was deleted, or if a reply already running there would block this one.
    const exists = state?.chats.some((chat) => chat.id === sideChat.chatId) ?? false;
    const busy = inFlight.current.has(sideChat.chatId) || turns.some((turn) => turn.chatId === sideChat.chatId && turn.status !== 'error');
    const chatId = exists && !busy ? sideChat.chatId : null;
    setSideChat({ open: true, chatId });
    void send(content, context, chatId, (created) => setSideChat((current) => (current.chatId === null ? { ...current, chatId: created } : current)),attachmentIds,resourceRequest);
  }, [route, state, send, navigate, turns, sideChat.chatId]);

  const generate = useCallback(async (input: CreateResource): Promise<Resource | undefined> => {
    seq.current += 1;
    const id = seq.current;
    const label = kindLabels[input.kind].toLowerCase();
    setGenerating((list) => [...list, { id, label }]);
    try {
      const resource = await api.generateResource(input);
      await quietRefresh();
      notify({ tone: 'success', message: `${kindLabels[resource.kind]} ready: ${resource.title}`, action: { label: 'Open', run: () => navigate({ kind: 'resource', resourceId: resource.id }) } });
      return resource;
    } catch (failure) {
      notify({ tone: 'error', message: `Couldn’t make the ${label}. ${errorMessage(failure)}` });
      return undefined;
    } finally {
      setGenerating((list) => list.filter((job) => job.id !== id));
    }
  }, [navigate, notify, quietRefresh]);

  const openGenerate = useCallback((request: GenerateRequest) => {
    if (request.kind === 'diagram') { window.dispatchEvent(new CustomEvent('centre:diagram',{ detail:request.instructions ?? '' })); return; }
    seq.current += 1;
    setModal({ kind: 'generate', request, key: seq.current });
  }, []);
  const openEventDialog = useCallback((date?: string) => setModal({ kind: 'event', date }), []);
  const openFeedback = useCallback((resource: Resource, questionIds: string[] = []) => setModal({ kind: 'feedback', resource, questionIds }), []);
  const openSearch = useCallback(() => setModal({ kind: 'search' }), []);
  const closeModal = useCallback(() => setModal(null), []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setModal((current) => (current?.kind === 'search' ? null : { kind: 'search' }));
      } else if (key === 'n' && !event.shiftKey && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        navigate({ kind: 'home' });
      } else if (key === '\\' || key === 'b') {
        event.preventDefault();
        setCollapsed((value) => !value);
      } else if (key === '[' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        go(-1);
      } else if (key === ']' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        go(1);
      } else if (key === ',') {
        event.preventDefault();
        navigate({ kind: 'settings' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, go]);

  const actions = useMemo<CentreActions | null>(
    () =>
      state
        ? { state,draftModelSelection,selectModel, route, navigationId, navigate, refresh, act, notify, openGenerate, openEventDialog, openFeedback, openSearch, send, cancel, askHere, sideChat, openSideChat, closeSideChat, turns, generating }
        : null,
    [state,draftModelSelection,selectModel, route, navigationId, navigate, refresh, act, notify, openGenerate, openEventDialog, openFeedback, openSearch, send, cancel, askHere, sideChat, openSideChat, closeSideChat, turns, generating],
  );

  if (!actions) {
    return (
      <div className="boot">
        <div className="titlebar-drag" />
        {loading || !error ? (
          <p className="boot__message" role="status"><span className="spinner" aria-hidden /> Opening Centre</p>
        ) : (
          <div className="boot__error" role="alert">
            <h1>Centre can&rsquo;t reach its local service</h1>
            <p>{error}</p>
            <button type="button" className="button button--primary" onClick={() => void quietRefresh()}>Try again</button>
          </div>
        )}
      </div>
    );
  }

  const docked = dockedRoutes.includes(route.kind);
  const sideOpen = docked && sideChat.open;

  return (
    <CentreContext.Provider value={actions}>
      <PreferencesEffect />
      <div className={`app${collapsed ? ' app--collapsed' : ''}`}>
        {!collapsed ? <Sidebar onCollapse={() => setCollapsed(true)} /> : null}
        <main className="main">
          {/* The page keeps the same parents whether or not the side chat is open, so its state (typed quiz answers, scroll) survives. */}
          <div className={`main__body${sideOpen ? ' main__body--side' : ''}`}>
            <div className="main__column">
              <header className="topbar">
                {collapsed ? (
                  <button type="button" className="icon-button" aria-label="Show sidebar" title="Show sidebar" onClick={() => setCollapsed(false)}>
                    <PanelLeft size={17} />
                  </button>
                ) : null}
                <div className="topbar__history">
                  <button type="button" className="icon-button icon-button--small" aria-label="Back" title="Back" disabled={history.index === 0} onClick={() => go(-1)}>
                    <ArrowLeft size={15} />
                  </button>
                  <button type="button" className="icon-button icon-button--small" aria-label="Forward" title="Forward" disabled={history.index >= history.stack.length - 1} onClick={() => go(1)}>
                    <ArrowRight size={15} />
                  </button>
                </div>
                <Crumbs route={route} state={actions.state} navigate={navigate} />
                <div className="topbar__end">
                  {generating.length ? (
                    <span className="topbar__jobs" role="status">
                      <span className="spinner spinner--small" aria-hidden /> Making {generating.length === 1 ? `a ${generating[0]!.label}` : `${generating.length} resources`}
                    </span>
                  ) : null}
                  {collapsed ? (
                    <button type="button" className="icon-button" aria-label="Search" title="Search (⌘K)" onClick={openSearch}>
                      <Search size={16} />
                    </button>
                  ) : null}
                </div>
              </header>
              {error ? (
                <div className="banner" role="alert">
                  Lost contact with the Centre service: {error} Showing the last data Centre loaded.
                  <button type="button" className="link-button" onClick={() => void quietRefresh()}>Retry</button>
                </div>
              ) : null}
              <div className={`main__content${docked ? ' main__content--docked' : ''}`} ref={main}>
                <Page key={route.kind === 'home' ? `home-${homeVisit}` : route.kind} route={route} />
              </div>
              {docked && !sideOpen ? <ChatDock /> : null}
            </div>
            {sideOpen ? <SideChat /> : null}
          </div>
        </main>
      </div>
      {!modal && actions.state.pendingQuestions[0] ? <QuestionDialog key={actions.state.pendingQuestions[0].id} request={actions.state.pendingQuestions[0]} /> : null}
      {modal?.kind === 'generate' ? <GenerateDialog key={modal.key} request={modal.request} onClose={closeModal} /> : null}
      {modal?.kind === 'event' ? <EventDialog initialDate={modal.date} onClose={closeModal} /> : null}
      {modal?.kind === 'feedback' ? <FeedbackDialog resource={modal.resource} initialQuestionIds={modal.questionIds} onClose={closeModal} /> : null}
      {modal?.kind === 'search' ? <SearchPalette onClose={closeModal} /> : null}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </CentreContext.Provider>
  );
}
