import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { friendlyError } from './ui';

export function AppUpdate({ prepare, onReloading }: { prepare: () => Promise<void>; onReloading: (busy: boolean) => void }) {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let live = true;
    const cleanups: (() => void)[] = [];
    void navigator.serviceWorker.ready.then(registration => {
      if (!live) return;
      const inspect = () => {
        if (live && registration.waiting && navigator.serviceWorker.controller) setRegistration(registration);
      };
      const installing = () => {
        const worker = registration.installing;
        if (worker) {
          worker.addEventListener('statechange', inspect);
          cleanups.push(() => worker.removeEventListener('statechange', inspect));
        }
      };
      registration.addEventListener('updatefound', installing);
      cleanups.push(() => registration.removeEventListener('updatefound', installing));
      installing();
      inspect();
      let checkedAt = 0;
      const check = () => {
        if (document.visibilityState === 'hidden' || Date.now() - checkedAt < 60_000) return;
        checkedAt = Date.now();
        void registration.update().catch(() => undefined);
      };
      document.addEventListener('visibilitychange', check);
      window.addEventListener('online', check);
      cleanups.push(() => { document.removeEventListener('visibilitychange', check); window.removeEventListener('online', check); });
      check();
    }).catch(() => undefined);
    return () => { live = false; for (const cleanup of cleanups) cleanup(); };
  }, []);

  async function update() {
    if (!registration?.waiting || busy) return;
    setBusy(true);
    setError(null);
    onReloading(true);
    try {
      await prepare();
      const worker = registration.waiting;
      if (!worker) { location.reload(); return; }
      await new Promise<void>((resolve, reject) => {
        const changed = () => { cleanup(); resolve(); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('The update could not finish. Keep working and try again later.')); }, 10_000);
        const cleanup = () => { clearTimeout(timeout); navigator.serviceWorker.removeEventListener('controllerchange', changed); };
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        try { worker.postMessage('ACTIVATE_UPDATE'); } catch (failure) { cleanup(); reject(failure); }
      });
      location.reload();
    } catch (failure) {
      setError(friendlyError(failure));
      setBusy(false);
      onReloading(false);
    }
  }
  if (!registration) return null;
  return <section className="update-notice" aria-label="App update">
    <div><RefreshCw size={17} aria-hidden/><p role="status">{busy ? 'Saving before updating…' : 'A Centre update is ready.'}</p></div>
    {confirming ? <><p className="detail">Save or cancel any open form first. Saved answers, chat drafts and changes waiting to sync will stay on this device. A running timer will pause.</p><div className="button-row"><button className="button" disabled={busy} onClick={() => setConfirming(false)}>Keep working</button><button className="button primary" disabled={busy} onClick={() => void update()}>Update and reload</button></div></> : <button className="text-button" onClick={() => setConfirming(true)}>Review update</button>}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}
