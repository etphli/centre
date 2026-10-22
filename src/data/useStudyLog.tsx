import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { HEARTBEAT_MS, emptyStudyLog, type StudyLog, type TimerAction } from '../../shared/study-log';
import { api } from './client';
import { z } from 'zod';

const studyActionSchema = z.object({ id: z.string().min(1).max(200), mode: z.enum(['manual', 'timer', 'week']) }).strict();
export type StudyLogActionRequest = z.infer<typeof studyActionSchema>;
export function requestStudyLogAction(request: StudyLogActionRequest): void {
  window.dispatchEvent(new CustomEvent('centre:study-log-action', { detail: studyActionSchema.parse(request) }));
}

function useStudyStore(snapshot: StudyLog) {
  const [log, setLog] = useState<StudyLog>(emptyStudyLog);
  const current = useRef(log);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [actionRequest, setActionRequest] = useState<StudyLogActionRequest | null>(null);
  const handledActions = useRef(new Set<string>());
  const acknowledgeAction = useCallback((id: string) => setActionRequest(current => current?.id === id ? null : current), []);
  useEffect(() => {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const result = studyActionSchema.safeParse(event.detail);
      if (!result.success || handledActions.current.has(result.data.id)) return;
      handledActions.current.add(result.data.id);
      if (handledActions.current.size > 128) {
        const oldest = handledActions.current.values().next().value;
        if (oldest) handledActions.current.delete(oldest);
      }
      setActionRequest(result.data);
    };
    window.addEventListener('centre:study-log-action', receive);
    return () => window.removeEventListener('centre:study-log-action', receive);
  }, []);
  const activity = useRef(false);
  const alive = useRef(false);
  const apply = useCallback((next: StudyLog) => { current.current = next; setLog(next); }, []);
  const run = useCallback(async (work: () => Promise<StudyLog>): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true; setBusy(true);
    try { apply(await work()); setReady(true); setError(''); return true; }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save study time.');
      try { apply(await api.studyLog()); } catch { /* Keep the last confirmed data visible. */ }
      return false;
    } finally { locked.current = false; setBusy(false); }
  }, [apply]);
  useEffect(() => {
    if (locked.current || JSON.stringify(snapshot) === JSON.stringify(current.current)) return;
    // Fetch confirmed state instead of applying an older app poll over a local save.
    void run(api.studyLog);
  }, [snapshot, run]);
  useEffect(() => {
    alive.current = true;
    const load = async () => {
      if (locked.current) return;
      locked.current = true; setBusy(true);
      try { const next = await api.studyLog(); if (alive.current) { apply(next); setReady(true); setError(''); } }
      catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : 'Could not load study time.'); }
      finally { locked.current = false; if (alive.current) setBusy(false); }
    };
    void load();
    const onActivity = () => { activity.current = true; };
    for (const name of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(name, onActivity, { passive: true });
    const timer = setInterval(() => {
      const active = current.current.sessions.find(session => !session.deletedAt && session.state.kind === 'running');
      if (!active) { void load(); return; }
      if (locked.current) return;
      const wasActive = activity.current; activity.current = false;
      void run(() => api.timerStudy(active.id, 'heartbeat', active.revision, wasActive));
    }, HEARTBEAT_MS);
    return () => {
      alive.current = false; clearInterval(timer);
      for (const name of ['pointerdown', 'keydown', 'wheel']) window.removeEventListener(name, onActivity);
    };
  }, [apply, run]);
  const command = useCallback((action: TimerAction) => {
    const active = current.current.sessions.find(session => !session.deletedAt && session.state.kind !== 'completed');
    return active ? run(() => api.timerStudy(active.id, action, active.revision, true)) : Promise.resolve(false);
  }, [run]);
  return { log, busy, ready, error, run, command, actionRequest, acknowledgeAction };
}
const StudyContext = createContext<ReturnType<typeof useStudyStore> | null>(null);
export function StudyLogProvider({ children, snapshot }: { children: ReactNode; snapshot: StudyLog }) {
  const store = useStudyStore(snapshot);
  return <StudyContext.Provider value={store}>{children}</StudyContext.Provider>;
}
export function useStudyLog() {
  const value = useContext(StudyContext);
  if (!value) throw new Error('StudyLogProvider is required.');
  return value;
}
export function useStudyClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
