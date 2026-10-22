import { saveQuizDraftSchema, type QuizDraft } from '../../shared/practice';
import type { Snapshot } from '../../shared/schema';
import { api } from './client';

type Progress = {
  id: string;
  answers: Record<string, string>;
  currentQuestion: number;
  started: boolean;
  saving: boolean;
  marking: boolean;
  markingError: string | null;
  error: string | null;
};

const sessions = new Map<string, PracticeDraft>();
const cacheKey = (resourceId: string) => `centre.practice-draft.v1.${resourceId}`;

/** A session outlives its quiz view so navigation cannot cancel an in-flight save. */
class PracticeDraft {
  private progress: Progress;
  private revision: number | null;
  private dirty = false;
  private pending: Promise<{ id: string; revision: number }> | null = null;
  private listeners = new Set<() => void>();
  onSaved: () => Promise<void>;

  constructor(readonly resourceId: string, state: Snapshot, onSaved: () => Promise<void>) {
    this.onSaved = onSaved;
    const saved = state.practiceDrafts.find(item => item.resourceId === resourceId && !item.deletedAt);
    let recovery: ReturnType<typeof saveQuizDraftSchema.parse> | undefined;
    try {
      const parsed = saveQuizDraftSchema.safeParse(JSON.parse(localStorage.getItem(cacheKey(resourceId)) ?? 'null'));
      if (parsed.success && !state.practiceDrafts.some(item => item.id === parsed.data.id && item.deletedAt)
        && !state.attempts.some(item => item.sourceDraftId === parsed.data.id)) recovery = parsed.data;
    } catch { /* Server persistence remains available when browser storage is unavailable. */ }
    const matches = saved && recovery?.id === saved.id
      && JSON.stringify(recovery.answers) === JSON.stringify(saved.answers) && recovery.currentQuestion === saved.currentQuestion;
    this.revision = matches || !recovery ? saved?.revision ?? null : recovery.expectedRevision;
    this.progress = {
      id: recovery?.id ?? saved?.id ?? crypto.randomUUID(),
      answers: recovery?.answers ?? saved?.answers ?? {},
      currentQuestion: recovery?.currentQuestion ?? saved?.currentQuestion ?? 0,
      started: Boolean(recovery || saved), saving: false, marking: false, markingError: null, error: null,
    };
    this.dirty = Boolean(recovery && !matches);
  }

  getSnapshot = () => this.progress;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<Progress>) {
    this.progress = { ...this.progress, ...patch };
    for (const listener of this.listeners) listener();
  }
  private cache() {
    try {
      if (!this.progress.started) localStorage.removeItem(cacheKey(this.resourceId));
      else localStorage.setItem(cacheKey(this.resourceId), JSON.stringify({ id: this.progress.id,
        expectedRevision: this.revision, answers: this.progress.answers, currentQuestion: this.progress.currentQuestion }));
    } catch { /* The durable service save reports its own failure below. */ }
  }

  update(answers: Record<string, string>, currentQuestion: number) {
    this.dirty = true;
    this.publish({ answers, currentQuestion, started: true });
    this.cache();
    void this.flush().catch(() => undefined);
  }

  setMarking(marking: boolean) { this.publish({ marking, ...(marking ? {markingError:null} : {}) }); }
  setMarkingError(markingError: string | null) { this.publish({ markingError }); }

  flush(): Promise<{ id: string; revision: number }> {
    if (this.pending) return this.pending;
    if (!this.progress.started) {
      this.dirty = true;
      this.publish({ started: true });
    }
    this.pending = (async () => {
      while (this.dirty) {
        const { id, answers, currentQuestion } = this.progress;
        this.publish({ saving: true, error: null });
        try {
          const saved = await api.saveQuizDraft(this.resourceId, { id, expectedRevision: this.revision, answers, currentQuestion });
          this.revision = saved.revision;
          this.dirty = this.progress.answers !== answers || this.progress.currentQuestion !== currentQuestion;
          this.cache();
          void this.onSaved().catch(() => undefined);
        } catch (error) {
          this.publish({ saving: false, error: error instanceof Error ? error.message : 'The draft could not be saved.' });
          throw error;
        }
      }
      this.publish({ saving: false, error: null });
      if (this.revision === null) throw new Error('Save the quiz draft before continuing.');
      return { id: this.progress.id, revision: this.revision };
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  begin() {
    this.clear();
    this.update({}, 0);
  }

  async startOver() {
    const saved = await this.flush();
    await api.startOverQuizDraft(this.resourceId, { id: saved.id, expectedRevision: saved.revision });
    this.begin();
    await this.flush();
  }

  clear() {
    this.dirty = false;
    this.revision = null;
    this.publish({ id: crypto.randomUUID(), answers: {}, currentQuestion: 0, started: false, saving: false, marking: false, markingError: null, error: null });
    this.cache();
  }

  async reload(): Promise<QuizDraft | undefined> {
    await this.pending?.catch(() => undefined);
    const state = await api.state();
    const saved = state.practiceDrafts.find(item => item.resourceId === this.resourceId && !item.deletedAt);
    this.dirty = false;
    this.revision = saved?.revision ?? null;
    this.publish({ id: saved?.id ?? crypto.randomUUID(), answers: saved?.answers ?? {},
      currentQuestion: saved?.currentQuestion ?? 0, started: Boolean(saved), saving: false, error: null });
    this.cache();
    await this.onSaved();
    return saved;
  }
}

export function practiceDraft(resourceId: string, state: Snapshot, onSaved: () => Promise<void>): PracticeDraft {
  let session = sessions.get(resourceId);
  if (!session) {
    session = new PracticeDraft(resourceId, state, onSaved);
    sessions.set(resourceId, session);
  }
  session.onSaved = onSaved;
  return session;
}
