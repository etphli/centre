import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/schema';
import { api } from './client';

export function useCentre() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      if (alive.current) { setState(next); setError(null); }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'Centre could not load your study data.');
      throw failure;
    } finally { if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => {});
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    const result = await work();
    await refresh();
    return result;
  }, [refresh]);
  return { state, loading, error, refresh, run };
}
