import { createContext, useContext } from 'react';
import type { CreateResource, ModelSelection, PageContext, Resource, Snapshot } from '../../shared/schema';
import type { GenerateRequest, Navigate, Route, ToastInput } from './types';

export type TurnStatus = 'working' | 'stopping' | 'error';

export interface Turn {
  id: number;
  chatId: string | null;
  content: string;
  attachmentIds: string[];
  resourceRequest?: CreateResource;
  context: PageContext;
  status: TurnStatus;
  startedAt: number;
  error?: string;
}

/** The chat panel beside docked pages. chatId null means the next message starts a new chat. */
export interface SideChatState {
  open: boolean;
  chatId: string | null;
}

export interface CentreActions {
  state: Snapshot;
  draftModelSelection:ModelSelection|null;
  selectModel:(chatId:string|null,selection:ModelSelection) => Promise<unknown>;
  route: Route;
  navigate: Navigate;
  refresh: () => Promise<void>;
  /** Runs a mutation, refreshes, and reports failures as a toast. Resolves undefined on failure. */
  act: <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
  notify: (toast: ToastInput) => void;
  openGenerate: (request: GenerateRequest) => void;
  openEventDialog: (date?: string) => void;
  openFeedback: (resource: Resource, questionIds?: string[]) => void;
  openSearch: () => void;
  /** Sends a chat message. chatId null starts a new chat. Resolves with the chat id used. */
  send: (content: string, context: PageContext, chatId: string | null, onCreated?: (chatId: string) => void, attachmentIds?:string[], resourceRequest?:CreateResource) => Promise<string | null>;
  cancel: (chatId: string) => Promise<void>;
  /**
   * Sends where the user already is, without leaving the page: into the open chat on a chat page,
   * the side panel on other pages (opening it), or a new full chat from home.
   */
  askHere: (content: string, context: PageContext,attachmentIds?:string[], resourceRequest?:CreateResource) => void;
  sideChat: SideChatState;
  /** Opens the side panel. Pass a chat id to show it, null for a new chat, or nothing to keep the current one. */
  openSideChat: (chatId?: string | null) => void;
  closeSideChat: () => void;
  turns: Turn[];
  generating: { id: number; label: string }[];
}

export const CentreContext = createContext<CentreActions | null>(null);

export function useApp(): CentreActions {
  const value = useContext(CentreContext);
  if (!value) throw new Error('useApp must be used inside CentreApp.');
  return value;
}
