import { z } from 'zod';

const savedDraft = z.object({ version: z.literal(1), text: z.string() }).strict();
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Draft = { text: string; error: string | null };

export function promptDraftKey(accounts: readonly (string | null)[], chatId: string | null) {
  return `centre.prompt-draft.v1.${JSON.stringify([accounts, chatId])}`;
}

export class PromptDraft {
  private state: Draft;
  private listeners = new Set<() => void>();
  constructor(private key: string, private storage: () => Storage) {
    try {
      const value = storage().getItem(key);
      this.state = { text: value === null ? '' : savedDraft.parse(JSON.parse(value)).text, error: null };
    } catch {
      this.state = { text: '', error: 'The saved draft could not be opened. New text will stay in this session if local storage is unavailable.' };
    }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  setText = (text: string) => {
    let error: string | null = null;
    try {
      if (text) this.storage().setItem(this.key, JSON.stringify({ version: 1, text }));
      else this.storage().removeItem(this.key);
    } catch {
      error = 'This draft stays in the current session, but could not be saved on this Mac. Copy it before quitting.';
    }
    this.state = { text, error };
    for (const listener of this.listeners) listener();
  };
}

const drafts = new Map<string, PromptDraft>();
export function promptDraft(accounts: readonly (string | null)[], chatId: string | null) {
  const key = promptDraftKey(accounts, chatId);
  let draft = drafts.get(key);
  if (!draft) { draft = new PromptDraft(key, () => window.localStorage); drafts.set(key, draft); }
  return draft;
}
