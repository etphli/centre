import {
  ArrowDown, ArrowUp, CalendarDays, Check, ChevronRight, Folder, FolderMinus, FolderPlus, GitBranch, Inbox, Library, MoreHorizontal,
  PanelLeft, Pencil, Pin, PinOff, Plus, Search, Settings, Target, Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Chat, ChatFolder } from '../../shared/schema';
import { api } from '../data/client';
import { useApp } from './context';
import { initials, todayKey } from './format';
import type { Route } from './types';
import './chat-list.css';
import { preloadMarkdown } from './Markdown';

function NavItem({ icon, label, active, onClick, badge }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button type="button" className={`nav-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <span className="nav-item__icon" aria-hidden>{icon}</span>
      <span className="nav-item__label">{label}</span>
      {badge ? <span className="nav-item__badge" aria-label={`${badge} due`}>{badge}</span> : null}
    </button>
  );
}

const resourceRoutes: Route['kind'][] = ['resources', 'subject', 'topic', 'resource'];

/** Where a chat is listed. Pinned chats keep their folderId but show only under Pinned. */
type Group = { kind: 'pinned' } | { kind: 'folder'; folderId: string | null };
type DragItem = { kind: 'chat'; chatId: string } | { kind: 'folder'; folderId: string };
type Edge = 'before' | 'after';
type DropTarget =
  | { kind: 'chat'; chatId: string; edge: Edge }
  | { kind: 'group'; group: Group }
  | { kind: 'folder'; folderId: string; edge: Edge };
/** y is where the menu opens downward; above is where its bottom sits if it has to open upward. */
type MenuAnchor = { x: number; y: number; above: number; trigger: HTMLElement | null };
type MenuState =
  | ({ kind: 'chat'; chatId: string } & MenuAnchor)
  | ({ kind: 'folder'; folderId: string } & MenuAnchor)
  | ({ kind: 'remove-folder'; folderId: string } & MenuAnchor);
type MenuSubject = { kind: 'chat'; chatId: string } | { kind: 'folder'; folderId: string };
type Editing = { kind: 'new-folder'; moveChatId: string | null } | { kind: 'rename'; folderId: string } | null;

const AUTO_EXPAND_MS = 550;

function byOrder(left: Chat, right: Chat): number {
  return left.sortOrder - right.sortOrder || right.updatedAt.localeCompare(left.updatedAt);
}

function groupKey(group: Group): string {
  return group.kind === 'pinned' ? 'pinned' : `folder:${group.folderId ?? ''}`;
}

function dropKey(target: DropTarget | null): string {
  if (!target) return '';
  if (target.kind === 'group') return `group:${groupKey(target.group)}`;
  return `${target.kind}:${target.kind === 'chat' ? target.chatId : target.folderId}:${target.edge}`;
}

/** The id to insert before so the moving item lands on the given side of the target. Null appends. */
function placement(list: { id: string }[], movingId: string, targetId: string, edge: Edge): string | null {
  if (edge === 'before') return targetId;
  const rest = list.filter((item) => item.id !== movingId);
  return rest[rest.findIndex((item) => item.id === targetId) + 1]?.id ?? null;
}

function staysPut(list: { id: string }[], movingId: string, beforeId: string | null): boolean {
  const index = list.findIndex((item) => item.id === movingId);
  return index >= 0 && (list[index + 1]?.id ?? null) === beforeId;
}

function edgeOf(event: DragEvent<HTMLElement>): Edge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** A compact label that follows the pointer instead of a screenshot of the whole row. */
function setGhost(event: DragEvent<HTMLElement>, label: string, kind: DragItem['kind']) {
  const ghost = document.createElement('div');
  ghost.className = `chat-nav-ghost chat-nav-ghost--${kind}`;
  ghost.textContent = label;
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 14, 14);
  window.setTimeout(() => ghost.remove(), 0);
}

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const { state, route, navigate, openSearch, turns, act, notify } = useApp();
  const openMemories = state.memories.filter((memory) => !memory.resolvedAt);
  const dueMemories = openMemories.filter((memory) => memory.nextReviewAt.slice(0, 10) <= todayKey()).length;
  const account = state.settings.account;
  const workingChats = new Set(turns.filter((turn) => turn.status !== 'error').map((turn) => turn.chatId));

  const folders = [...state.chatFolders].sort((left, right) => left.sortOrder - right.sortOrder);
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const chatById = new Map(state.chats.map((chat) => [chat.id, chat]));
  const groupOf = (chat: Chat): Group => chat.pinnedAt !== null
    ? { kind: 'pinned' }
    : { kind: 'folder', folderId: chat.folderId !== null && folderById.has(chat.folderId) ? chat.folderId : null };
  const lists = new Map<string, Chat[]>();
  for (const chat of [...state.chats].sort(byOrder)) {
    const key = groupKey(groupOf(chat));
    lists.set(key, [...(lists.get(key) ?? []), chat]);
  }
  const listFor = (group: Group) => lists.get(groupKey(group)) ?? [];
  const pinned = listFor({ kind: 'pinned' });
  const unfiled = listFor({ kind: 'folder', folderId: null });
  const groupName = (group: Group) => group.kind === 'pinned' ? 'Pinned' : group.folderId === null ? 'Recents' : folderById.get(group.folderId)?.name ?? 'folder';
  const chatTitle = (chat: Chat) => chat.title || 'New chat';

  const [drag, setDrag] = useState<DragItem | null>(null);
  const dragRef = useRef<DragItem | null>(null);
  const [drop, setDropState] = useState<DropTarget | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const [peek, setPeek] = useState<ReadonlySet<string>>(new Set());
  const peekRef = useRef<ReadonlySet<string>>(peek);
  peekRef.current = peek;
  const expandTimer = useRef<{ folderId: string; timer: number } | null>(null);
  const committing = useRef(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => () => { if (expandTimer.current) window.clearTimeout(expandTimer.current.timer); }, []);

  const isOpen = (folder: ChatFolder) => !folder.collapsed || peek.has(folder.id);

  function setDrop(target: DropTarget | null) {
    if (dropKey(target) === dropKey(dropRef.current)) return;
    dropRef.current = target;
    setDropState(target);
    const hoverFolder = target?.kind === 'group' && target.group.kind === 'folder' ? target.group.folderId : null;
    if (expandTimer.current && expandTimer.current.folderId !== hoverFolder) {
      window.clearTimeout(expandTimer.current.timer);
      expandTimer.current = null;
    }
    const folder = hoverFolder === null ? undefined : folderById.get(hoverFolder);
    if (folder && folder.collapsed && !peekRef.current.has(folder.id) && !expandTimer.current) {
      expandTimer.current = {
        folderId: folder.id,
        timer: window.setTimeout(() => {
          expandTimer.current = null;
          setPeek((current) => new Set([...current, folder.id]));
        }, AUTO_EXPAND_MS),
      };
    }
  }

  function startDrag(event: DragEvent<HTMLElement>, item: DragItem, label: string) {
    setMenu(null);
    dragRef.current = item;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', label);
    setGhost(event, label, item.kind);
    // Changing the DOM inside dragstart makes Chromium cancel the drag, so reveal drop zones a tick later.
    window.setTimeout(() => setDrag(item), 0);
  }

  function endDrag() {
    dragRef.current = null;
    setDrag(null);
    setDrop(null);
    if (!committing.current) setPeek(new Set());
  }

  /** Accepts a drag over this element when the target makes sense for what is being dragged. */
  function offer(event: DragEvent<HTMLElement>, target: DropTarget | null) {
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDrop(target);
  }

  function chatTarget(event: DragEvent<HTMLElement>, target: (edge: Edge) => DropTarget | null) {
    if (dragRef.current?.kind === 'chat') offer(event, target(edgeOf(event)));
  }

  function folderTarget(event: DragEvent<HTMLElement>, folderId: string) {
    const item = dragRef.current;
    if (item?.kind === 'chat') offer(event, { kind: 'group', group: { kind: 'folder', folderId } });
    if (item?.kind === 'folder') offer(event, { kind: 'folder', folderId, edge: edgeOf(event) });
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const item = dragRef.current;
    const target = dropRef.current;
    setDrop(null);
    if (!item || !target) return;
    if (item.kind === 'chat') {
      const chat = chatById.get(item.chatId);
      if (!chat) return;
      if (target.kind === 'group') moveChat(chat, target.group, null);
      if (target.kind === 'chat' && target.chatId !== chat.id) {
        const anchor = chatById.get(target.chatId);
        if (!anchor) return;
        const group = groupOf(anchor);
        moveChat(chat, group, placement(listFor(group), chat.id, anchor.id, target.edge));
      }
    } else if (target.kind === 'folder' && target.folderId !== item.folderId) {
      moveFolder(item.folderId, placement(folders, item.folderId, target.folderId, target.edge));
    }
  }

  function moveChat(chat: Chat, group: Group, beforeChatId: string | null, done = `Moved ${chatTitle(chat)} to ${groupName(group)}`) {
    if (groupKey(groupOf(chat)) === groupKey(group) && staysPut(listFor(group), chat.id, beforeChatId)) return;
    const folderId = group.kind === 'folder' ? group.folderId : null;
    const expand = folderId !== null && folderById.get(folderId)?.collapsed && peekRef.current.has(folderId) ? folderId : null;
    committing.current = true;
    void act(async () => {
      if (expand) await api.updateChatFolder(expand, { collapsed: false });
      return api.organizeChat(chat.id, group.kind === 'pinned' ? { pinned: true, beforeChatId } : { pinned: false, folderId, beforeChatId });
    }).then((moved) => {
      committing.current = false;
      setPeek(new Set());
      if (moved) setAnnouncement(done);
    });
  }

  function moveFolder(folderId: string, beforeFolderId: string | null) {
    if (staysPut(folders, folderId, beforeFolderId)) return;
    void act(() => api.updateChatFolder(folderId, { beforeFolderId })).then((moved) => {
      if (moved) setAnnouncement(`Moved folder ${moved.name}`);
    });
  }

  function nudgeChat(chat: Chat, step: -1 | 1) {
    const group = groupOf(chat);
    const list = listFor(group);
    const index = list.findIndex((item) => item.id === chat.id);
    if (step === -1 && index > 0) moveChat(chat, group, list[index - 1]?.id ?? null, `Moved ${chatTitle(chat)} up`);
    if (step === 1 && index < list.length - 1) moveChat(chat, group, list[index + 2]?.id ?? null, `Moved ${chatTitle(chat)} down`);
  }

  function nudgeFolder(folder: ChatFolder, step: -1 | 1) {
    const index = folders.findIndex((item) => item.id === folder.id);
    if (step === -1 && index > 0) moveFolder(folder.id, folders[index - 1]?.id ?? null);
    if (step === 1 && index < folders.length - 1) moveFolder(folder.id, folders[index + 2]?.id ?? null);
  }

  function togglePin(chat: Chat) {
    const pinning = chat.pinnedAt === null;
    void act(() => api.organizeChat(chat.id, pinning ? { pinned: true, beforeChatId: pinned[0]?.id ?? null } : { pinned: false }))
      .then((moved) => { if (moved) setAnnouncement(`${pinning ? 'Pinned' : 'Unpinned'} ${chatTitle(chat)}`); });
  }

  function deleteChat(chat: Chat) {
    void (async () => {
      const result = await act(() => api.archiveChat(chat.id));
      if (!result) return;
      if (route.kind === 'chat' && route.chatId === chat.id) navigate({ kind: 'home' });
      notify({ tone: 'success', message: 'Chat deleted', action: { label: 'Undo', run: () => { void act(() => api.restoreChat(chat.id), 'Chat restored'); } } });
    })();
  }

  function toggleFolder(folder: ChatFolder) {
    setPeek((current) => { const next = new Set(current); next.delete(folder.id); return next; });
    void act(() => api.updateChatFolder(folder.id, { collapsed: isOpen(folder) }));
  }

  function createFolder(name: string, moveChatId: string | null) {
    setEditing(null);
    void act(async () => {
      const folder = await api.createChatFolder(name);
      const chat = moveChatId === null ? undefined : chatById.get(moveChatId);
      if (chat) await api.organizeChat(chat.id, chat.pinnedAt === null ? { folderId: folder.id, beforeChatId: null } : { folderId: folder.id });
      return folder;
    }).then((folder) => { if (folder) setAnnouncement(`Created folder ${folder.name}`); });
  }

  function renameFolder(folder: ChatFolder, name: string) {
    setEditing(null);
    void act(() => api.updateChatFolder(folder.id, { name }));
  }

  function removeFolder(folder: ChatFolder) {
    void act(() => api.deleteChatFolder(folder.id), `Removed ${folder.name}. Its chats are in Recents.`);
  }

  function openMenu(subject: MenuSubject, anchor: MenuAnchor) {
    setMenu(subject.kind === 'chat' ? { ...anchor, kind: 'chat', chatId: subject.chatId } : { ...anchor, kind: 'folder', folderId: subject.folderId });
  }

  function toggleMenuFrom(event: MouseEvent<HTMLElement>, subject: MenuSubject) {
    const trigger = event.currentTarget;
    if (menu && menu.trigger === trigger) { setMenu(null); return; }
    const rect = trigger.getBoundingClientRect();
    openMenu(subject, { x: rect.left, y: rect.bottom + 4, above: rect.top - 4, trigger });
  }

  function contextMenu(event: MouseEvent<HTMLElement>, subject: MenuSubject) {
    event.preventDefault();
    const row = event.currentTarget;
    const trigger = row.querySelector<HTMLElement>('[data-row-focus]');
    // The context-menu key reports no pointer position, so anchor under the row instead.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const rect = row.getBoundingClientRect();
    openMenu(subject, fromKeyboard
      ? { x: rect.left + 12, y: rect.bottom + 2, above: rect.top - 2, trigger }
      : { x: event.clientX, y: event.clientY, above: event.clientY, trigger });
  }

  function closeMenu(restoreFocus: boolean) {
    const trigger = menu?.trigger;
    setMenu(null);
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }

  function rowKeys(event: KeyboardEvent<HTMLElement>, subject: MenuSubject, nudge: (step: -1 | 1) => void) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const trigger = event.currentTarget;
      const rect = (trigger.parentElement ?? trigger).getBoundingClientRect();
      openMenu(subject, { x: rect.left + 12, y: rect.bottom + 2, above: rect.top - 2, trigger });
      return;
    }
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    nudge(event.key === 'ArrowUp' ? -1 : 1);
  }

  function chatMenu(chat: Chat): MenuEntry[] {
    const list = listFor(groupOf(chat));
    const index = list.findIndex((item) => item.id === chat.id);
    const isPinned = chat.pinnedAt !== null;
    const currentFolder = chat.folderId !== null && folderById.has(chat.folderId) ? chat.folderId : null;
    const moveTo = (folderId: string | null) => {
      if (currentFolder === folderId) return;
      if (!isPinned) { moveChat(chat, { kind: 'folder', folderId }, null); return; }
      // A pinned chat stays pinned; this only changes where it returns when unpinned.
      void act(() => api.organizeChat(chat.id, { folderId })).then((moved) => {
        if (moved) setAnnouncement(`${chatTitle(chat)} will return to ${groupName({ kind: 'folder', folderId })} when unpinned`);
      });
    };
    const working = workingChats.has(chat.id);
    return [
      { kind: 'item', label: isPinned ? 'Unpin' : 'Pin', icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => togglePin(chat) },
      ...(index > 0 ? [{ kind: 'item', label: 'Move up', icon: <ArrowUp size={14} />, hint: '⌥↑', onSelect: () => nudgeChat(chat, -1) } satisfies MenuEntry] : []),
      ...(index < list.length - 1 ? [{ kind: 'item', label: 'Move down', icon: <ArrowDown size={14} />, hint: '⌥↓', onSelect: () => nudgeChat(chat, 1) } satisfies MenuEntry] : []),
      { kind: 'separator' },
      { kind: 'label', label: isPinned ? 'Folder when unpinned' : 'Move to' },
      { kind: 'item', label: 'No folder', icon: <Inbox size={14} />, checked: currentFolder === null, onSelect: () => moveTo(null) },
      ...folders.map((folder): MenuEntry => ({ kind: 'item', label: folder.name, icon: <Folder size={14} />, checked: currentFolder === folder.id, onSelect: () => moveTo(folder.id) })),
      { kind: 'item', label: 'New folder…', icon: <FolderPlus size={14} />, onSelect: () => setEditing({ kind: 'new-folder', moveChatId: chat.id }) },
      { kind: 'separator' },
      { kind: 'item', label: working ? 'Stop the reply to delete' : 'Delete', icon: <Trash2 size={14} />, danger: true, disabled: working, onSelect: () => deleteChat(chat) },
    ];
  }

  function folderMenu(folder: ChatFolder, anchor: MenuAnchor): MenuEntry[] {
    const index = folders.findIndex((item) => item.id === folder.id);
    const hasChats = state.chats.some((chat) => chat.folderId === folder.id);
    return [
      { kind: 'item', label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setEditing({ kind: 'rename', folderId: folder.id }) },
      { kind: 'item', label: isOpen(folder) ? 'Collapse' : 'Expand', icon: <ChevronRight size={14} className={isOpen(folder) ? 'is-turned' : undefined} />, onSelect: () => toggleFolder(folder) },
      ...(index > 0 ? [{ kind: 'item', label: 'Move up', icon: <ArrowUp size={14} />, hint: '⌥↑', onSelect: () => nudgeFolder(folder, -1) } satisfies MenuEntry] : []),
      ...(index < folders.length - 1 ? [{ kind: 'item', label: 'Move down', icon: <ArrowDown size={14} />, hint: '⌥↓', onSelect: () => nudgeFolder(folder, 1) } satisfies MenuEntry] : []),
      { kind: 'separator' },
      {
        kind: 'item', label: hasChats ? 'Remove folder…' : 'Remove folder', icon: <FolderMinus size={14} />, danger: true,
        onSelect: () => hasChats ? setMenu({ ...anchor, kind: 'remove-folder', folderId: folder.id }) : removeFolder(folder),
      },
    ];
  }

  function renderChat(chat: Chat, nested: boolean) {
    const active = route.kind === 'chat' && route.chatId === chat.id;
    const title = chatTitle(chat);
    const branchParent = chat.lineage.kind === 'branch' ? chatById.get(chat.lineage.parentChatId) : undefined;
    const branchOrigin = chat.lineage.kind === 'branch' ? `From ${branchParent ? chatTitle(branchParent) : 'an earlier chat'}` : null;
    const edge = drop?.kind === 'chat' && drop.chatId === chat.id ? drop.edge : null;
    const menuOpen = menu?.kind === 'chat' && menu.chatId === chat.id;
    return (
      <li
        key={chat.id}
        data-chat-id={chat.id}
        className={cx('chat-nav__row', nested && 'is-nested', active && 'is-active', menuOpen && 'is-menu-open',
          drag?.kind === 'chat' && drag.chatId === chat.id && 'is-dragging', edge && `is-drop-${edge}`)}
        onDragOver={(event) => chatTarget(event, (side) => ({ kind: 'chat', chatId: chat.id, edge: side }))}
        onDrop={onDrop}
        onContextMenu={(event) => contextMenu(event, { kind: 'chat', chatId: chat.id })}
      >
        <button
          type="button"
          data-row-focus
          className={cx('chat-nav__item', branchOrigin !== null && 'chat-nav__item--branch')}
          aria-label={title}
          onPointerEnter={() => { void preloadMarkdown().catch(() => {}); }}
          onFocus={() => { void preloadMarkdown().catch(() => {}); }}
          draggable
          aria-current={active ? 'page' : undefined}
          title={branchOrigin ? `${title} · ${branchOrigin}` : title}
          onClick={() => navigate({ kind: 'chat', chatId: chat.id })}
          onKeyDown={(event) => rowKeys(event, { kind: 'chat', chatId: chat.id }, (step) => nudgeChat(chat, step))}
          onDragStart={(event) => startDrag(event, { kind: 'chat', chatId: chat.id }, title)}
          onDragEnd={endDrag}
        >
          {branchOrigin ? <GitBranch size={13} className="chat-nav__branch-glyph" aria-hidden /> : null}
          <span className="chat-nav__text">
            <span className="chat-nav__title">{title}</span>
            {branchOrigin ? <span className="chat-nav__origin">{branchOrigin}</span> : null}
          </span>
          {workingChats.has(chat.id) ? <span className="spinner spinner--small chat-nav__spinner" aria-label="Working" /> : null}
        </button>
        <button
          type="button"
          className="chat-nav__more"
          aria-label={`Options for ${title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => toggleMenuFrom(event, { kind: 'chat', chatId: chat.id })}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </li>
    );
  }

  function renderFolder(folder: ChatFolder) {
    const open = isOpen(folder);
    const chats = listFor({ kind: 'folder', folderId: folder.id });
    const renaming = editing?.kind === 'rename' && editing.folderId === folder.id;
    const targeted = drop?.kind === 'group' && drop.group.kind === 'folder' && drop.group.folderId === folder.id;
    const edge = drop?.kind === 'folder' && drop.folderId === folder.id ? drop.edge : null;
    const menuOpen = (menu?.kind === 'folder' || menu?.kind === 'remove-folder') && menu.folderId === folder.id;
    const holdsActive = !open && route.kind === 'chat' && chats.some((chat) => chat.id === route.chatId);
    return (
      <li
        key={folder.id}
        data-folder-id={folder.id}
        className={cx('chat-nav__folder', targeted && 'is-drop-target', drag?.kind === 'folder' && drag.folderId === folder.id && 'is-dragging')}
      >
        <div
          className={cx('chat-nav__row chat-nav__folder-head', menuOpen && 'is-menu-open', edge && `is-drop-${edge}`, holdsActive && 'holds-active')}
          onDragOver={(event) => folderTarget(event, folder.id)}
          onDrop={onDrop}
          onContextMenu={(event) => { if (!renaming) contextMenu(event, { kind: 'folder', folderId: folder.id }); }}
        >
          {renaming ? (
            <NameField initial={folder.name} label="Folder name" onSubmit={(name) => renameFolder(folder, name)} onCancel={() => setEditing(null)} />
          ) : (
            <>
              <button
                type="button"
                data-row-focus
                className="chat-nav__item chat-nav__folder-toggle"
                draggable
                aria-expanded={open}
                onClick={() => toggleFolder(folder)}
                onKeyDown={(event) => {
                  if (!event.altKey && ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open))) {
                    event.preventDefault();
                    toggleFolder(folder);
                  }
                  rowKeys(event, { kind: 'folder', folderId: folder.id }, (step) => nudgeFolder(folder, step));
                }}
                onDragStart={(event) => startDrag(event, { kind: 'folder', folderId: folder.id }, folder.name)}
                onDragEnd={endDrag}
              >
                <ChevronRight size={12} className={cx('chat-nav__chevron', open && 'is-turned')} aria-hidden />
                <span className="chat-nav__title">{folder.name}</span>
                {!open && chats.length > 0 ? <span className="chat-nav__count" aria-label={`${chats.length} chats`}>{chats.length}</span> : null}
              </button>
              <button
                type="button"
                className="chat-nav__more"
                aria-label={`Options for folder ${folder.name}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={(event) => toggleMenuFrom(event, { kind: 'folder', folderId: folder.id })}
              >
                <MoreHorizontal size={14} aria-hidden />
              </button>
            </>
          )}
        </div>
        {open ? (
          chats.length > 0 ? (
            <ul className="chat-nav__list" aria-label={`Chats in ${folder.name}`}>{chats.map((chat) => renderChat(chat, true))}</ul>
          ) : (
            <p
              className="chat-nav__empty"
              onDragOver={(event) => chatTarget(event, () => ({ kind: 'group', group: { kind: 'folder', folderId: folder.id } }))}
              onDrop={onDrop}
            >
              {drag?.kind === 'chat' ? 'Drop a chat here' : 'No chats yet'}
            </p>
          )
        ) : null}
      </li>
    );
  }

  const newFolderButton = (
    <button
      type="button"
      className="chat-nav__heading-action"
      aria-label="New folder"
      title="New folder"
      onClick={() => setEditing({ kind: 'new-folder', moveChatId: null })}
    >
      <FolderPlus size={13} aria-hidden />
    </button>
  );
  const creating = editing?.kind === 'new-folder' ? editing : null;
  const draggingChat = drag?.kind === 'chat';
  const pinTarget = drop?.kind === 'group' && drop.group.kind === 'pinned';
  const unfiledTarget = drop?.kind === 'group' && drop.group.kind === 'folder' && drop.group.folderId === null;
  const offerGroup = (group: Group) => (event: DragEvent<HTMLElement>) => chatTarget(event, () => ({ kind: 'group', group }));

  const menuChat = menu?.kind === 'chat' ? chatById.get(menu.chatId) : undefined;
  const menuFolder = menu && menu.kind !== 'chat' ? folderById.get(menu.folderId) : undefined;
  const removingCount = menu?.kind === 'remove-folder' ? state.chats.filter((chat) => chat.folderId === menu.folderId).length : 0;

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar__header">
        <div className="sidebar__titlebar">
          <button type="button" className="icon-button" aria-label="Hide sidebar" title="Hide sidebar" onClick={onCollapse}>
            <PanelLeft size={16} />
          </button>
        </div>
        <button type="button" className="sidebar__search" onClick={openSearch}>
          <Search size={14} aria-hidden />
          <span>Search</span>
          <kbd>&#8984;K</kbd>
        </button>
      </div>
      <nav className="sidebar__nav" aria-label="Main">
        <NavItem icon={<Plus size={15} />} label="New chat" active={route.kind === 'home'} onClick={() => navigate({ kind: 'home' })} />
        <NavItem icon={<Library size={15} />} label="Resources" active={resourceRoutes.includes(route.kind)} onClick={() => navigate({ kind: 'resources' })} />
        <NavItem icon={<CalendarDays size={15} />} label="Calendar" active={route.kind === 'calendar'} onClick={() => navigate({ kind: 'calendar' })} />
        <NavItem icon={<Target size={15} />} label="Review" active={route.kind === 'review'} onClick={() => navigate({ kind: 'review' })} badge={dueMemories || undefined} />
      </nav>
      <div
        className={cx('sidebar__recents chat-nav', drag && 'is-dragging')}
        onDragOver={(event) => { if (!event.defaultPrevented) setDrop(null); }}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDrop(null); }}
      >
        <section className={cx('chat-nav__section', pinned.length === 0 && 'chat-nav__reveal', pinned.length === 0 && draggingChat && 'is-revealed')} aria-label="Pinned" aria-hidden={pinned.length === 0 && !draggingChat ? true : undefined}>
          <div className="chat-nav__reveal-inner">
            <div className={cx('chat-nav__heading-row', pinTarget && pinned.length > 0 && 'is-drop-target')} onDragOver={offerGroup({ kind: 'pinned' })} onDrop={onDrop}>
              <h2 className="sidebar__heading">Pinned</h2>
            </div>
            {pinned.length > 0 ? (
              <ul className="chat-nav__list">{pinned.map((chat) => renderChat(chat, false))}</ul>
            ) : (
              <div className={cx('chat-nav__dropzone', pinTarget && 'is-drop-target')} onDragOver={offerGroup({ kind: 'pinned' })} onDrop={onDrop}>
                <Pin size={12} aria-hidden /> Drop to pin
              </div>
            )}
          </div>
        </section>

        {folders.length > 0 || creating ? (
          <section className="chat-nav__section" aria-label="Folders">
            <div className="chat-nav__heading-row">
              <h2 className="sidebar__heading">Folders</h2>
              {newFolderButton}
            </div>
            <ul className="chat-nav__list">
              {folders.map(renderFolder)}
              {creating ? (
                <li className="chat-nav__row chat-nav__folder-head">
                  <NameField initial="" label="New folder name" onSubmit={(name) => createFolder(name, creating.moveChatId)} onCancel={() => setEditing(null)} />
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}

        <section className="chat-nav__section" aria-label="Recents">
          <div className={cx('chat-nav__heading-row', unfiledTarget && unfiled.length > 0 && 'is-drop-target')} onDragOver={offerGroup({ kind: 'folder', folderId: null })} onDrop={onDrop}>
            <h2 className="sidebar__heading">Recents</h2>
            {folders.length === 0 && !creating ? newFolderButton : null}
          </div>
          {unfiled.length > 0 ? (
            <ul className="chat-nav__list">{unfiled.map((chat) => renderChat(chat, false))}</ul>
          ) : state.chats.length === 0 ? (
            <p className="sidebar__empty">Chats you start will show up here</p>
          ) : (
            <div className={cx('chat-nav__dropzone chat-nav__dropzone--quiet', unfiledTarget && 'is-drop-target')} onDragOver={offerGroup({ kind: 'folder', folderId: null })} onDrop={onDrop}>
              {draggingChat ? 'Drop to take out of folders' : 'Every chat is pinned or filed'}
            </div>
          )}
        </section>
        <p className="chat-nav__sr" aria-live="polite">{announcement}</p>
      </div>
      <footer className="sidebar__footer">
        <button type="button" className="account" onClick={() => navigate({ kind: 'settings' })} aria-label="Account and settings">
          {account?.picture ? (
            <img className="avatar" src={account.picture} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="avatar" aria-hidden>{initials(account?.name ?? 'Centre')}</span>
          )}
          <span className="account__text">
            <span className="account__name">{account?.name ?? 'Not signed in'}</span>
            <span className="account__status">{state.settings.organatoConnected ? 'Organato connected' : 'Local only'}</span>
          </span>
        </button>
        <button type="button" className={`icon-button icon-button--small${route.kind === 'settings' ? ' is-active' : ''}`} aria-label="Settings" title="Settings" onClick={() => navigate({ kind: 'settings' })}>
          <Settings size={15} />
        </button>
      </footer>
      {menu && menuChat ? (
        <FloatingMenu anchor={menu} label={`Options for ${chatTitle(menuChat)}`} entries={chatMenu(menuChat)} onClose={closeMenu} />
      ) : null}
      {menu?.kind === 'folder' && menuFolder ? (
        <FloatingMenu anchor={menu} label={`Options for folder ${menuFolder.name}`} entries={folderMenu(menuFolder, menu)} onClose={closeMenu} />
      ) : null}
      {menu?.kind === 'remove-folder' && menuFolder ? (
        <RemoveFolderConfirm
          anchor={menu}
          folder={menuFolder}
          chatCount={removingCount}
          onCancel={() => closeMenu(true)}
          onConfirm={() => { closeMenu(false); removeFolder(menuFolder); }}
        />
      ) : null}
    </aside>
  );
}

function NameField({ initial, label, onSubmit, onCancel }: { initial: string; label: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== initial) onSubmit(name);
    else onCancel();
  };
  return (
    <form className="chat-nav__name" onSubmit={(event) => { event.preventDefault(); finish(true); }}>
      <Folder size={13} aria-hidden />
      <input
        autoFocus
        aria-label={label}
        placeholder="Folder name"
        maxLength={80}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }}
      />
    </form>
  );
}

type MenuEntry =
  | { kind: 'item'; label: string; icon: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string; checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

/** Positions a popover inside the viewport and closes it on outside presses, scrolling, or resizing. */
function useFloating(anchor: MenuAnchor, onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)),
      top: anchor.y + height > window.innerHeight - 8 ? Math.max(8, anchor.above - height) : anchor.y,
    });
  }, [anchor.x, anchor.y, anchor.above]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && (ref.current?.contains(target) || anchor.trigger?.contains(target))) return;
      dismiss.current();
    };
    const close = () => dismiss.current();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [anchor.trigger]);

  const style: CSSProperties = position ?? { left: anchor.x, top: anchor.y, visibility: 'hidden' };
  // Hidden elements cannot take focus, so callers wait for placement before focusing.
  return { ref, style, placed: position !== null };
}

function FloatingMenu({ anchor, label, entries, onClose }: { anchor: MenuAnchor; label: string; entries: MenuEntry[]; onClose: (restoreFocus: boolean) => void }) {
  const { ref, style, placed } = useFloating(anchor, () => onClose(false));
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

  useEffect(() => { if (placed) items()[0]?.focus(); }, [placed]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.findIndex((item) => item === document.activeElement);
    const focus = (next: number) => list[(next + list.length) % list.length]?.focus();
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focus(index + 1); break;
      case 'ArrowUp': event.preventDefault(); focus(index - 1); break;
      case 'Home': event.preventDefault(); focus(0); break;
      case 'End': event.preventDefault(); focus(list.length - 1); break;
      case 'Escape': event.preventDefault(); event.stopPropagation(); onClose(true); break;
      case 'Tab': event.preventDefault(); onClose(true); break;
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) break;
        const key = event.key.toLowerCase();
        const after = [...list.slice(index + 1), ...list.slice(0, index + 1)];
        after.find((item) => item.textContent?.trim().toLowerCase().startsWith(key))?.focus();
      }
    }
  };

  return createPortal(
    <div ref={ref} className="chat-nav-menu" role="menu" aria-label={label} style={style} onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') return <div key={index} role="separator" className="chat-nav-menu__separator" />;
        if (entry.kind === 'label') return <div key={index} role="presentation" className="chat-nav-menu__label">{entry.label}</div>;
        return (
          <button
            key={index}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked}
            tabIndex={-1}
            disabled={entry.disabled}
            className={cx('chat-nav-menu__item', entry.danger && 'is-danger')}
            onClick={() => { onClose(true); entry.onSelect(); }}
          >
            <span className="chat-nav-menu__icon" aria-hidden>{entry.icon}</span>
            <span className="chat-nav-menu__text">{entry.label}</span>
            {entry.checked ? <Check size={13} className="chat-nav-menu__check" aria-hidden /> : null}
            {entry.hint ? <kbd className="chat-nav-menu__hint">{entry.hint}</kbd> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

function RemoveFolderConfirm({ anchor, folder, chatCount, onCancel, onConfirm }: { anchor: MenuAnchor; folder: ChatFolder; chatCount: number; onCancel: () => void; onConfirm: () => void }) {
  const { ref, style, placed } = useFloating(anchor, onCancel);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (placed) confirm.current?.focus(); }, [placed]);
  return createPortal(
    <div
      ref={ref}
      className="chat-nav-menu chat-nav-confirm"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="chat-nav-confirm-title"
      aria-describedby="chat-nav-confirm-body"
      style={style}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}
    >
      <p id="chat-nav-confirm-title" className="chat-nav-confirm__title">Remove “{folder.name}”?</p>
      <p id="chat-nav-confirm-body" className="chat-nav-confirm__body">
        {chatCount === 1 ? 'Its chat moves' : `Its ${chatCount} chats move`} to Recents. No chats are deleted.
      </p>
      <div className="chat-nav-confirm__actions">
        <button type="button" className="button button--quiet button--small" onClick={onCancel}>Cancel</button>
        <button ref={confirm} type="button" className="button button--small chat-nav-confirm__remove" onClick={onConfirm}>Remove folder</button>
      </div>
    </div>,
    document.body,
  );
}
