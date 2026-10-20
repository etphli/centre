import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/schema';
import { api } from './client';

export function useCentre() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const load = useCallback((polling: boolean) => {
    if (pending.current) return pending.current;
    const work = (async () => {
      try {
        const next = await (polling ? api.pollState() : api.state());
        if (alive.current) {
          if (next) setState(next);
          setError(null);
        }
      } catch (failure) {
        if (alive.current) setError(failure instanceof Error ? failure.message : 'Centre could not load your study data.');
        throw failure;
      } finally {
        pending.current = null;
        if (alive.current) setLoading(false);
      }
    })();
    pending.current = work;
    return work;
  }, []);
  const refresh = useCallback(async () => {
    // A mutation must refresh after any older poll finishes.
    await pending.current?.catch(() => {});
    await load(false);
  }, [load]);
  useEffect(() => {
    alive.current = true;
    void load(false).catch(() => {});
    const poll = () => {
      if (document.visibilityState === 'visible') void load(true).catch(() => {});
    };
    const timer = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [load]);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    const result = await work();
    await refresh();
    return result;
  }, [refresh]);
  return { state, loading, error, refresh, run };
}
