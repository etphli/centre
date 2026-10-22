import { useEffect, useRef } from 'react';
import { desktopActions, desktopActionRequestSchema, type DesktopActionRequest } from '../../shared/desktop-actions';
import { useApp } from './context';

/** Wait behind existing dialogs so launching Centre cannot discard unfinished work. */
export function DesktopActionBridge() {
  const app = useApp();
  const current = useRef(app);
  current.current = app;
  const handled = useRef(new Set<string>());

  useEffect(() => {
    const bridge = window.centre?.actions;
    if (!bridge) return;
    let pending: DesktopActionRequest | null = null;
    let frame = 0;
    let alive = true;
    const acknowledge = (id: string) => {
      void bridge.acknowledge(id).catch(() => {
        if (alive) current.current.notify({ tone: 'error', message: 'Centre could not confirm the desktop action. Reopen the icon to try again.' });
      });
    };
    function drain() {
      if (!pending || document.querySelector('dialog[open]')) return;
      const request = pending;
      pending = null;
      if (handled.current.has(request.id)) { acknowledge(request.id); return; }
      handled.current.add(request.id);
      if (handled.current.size > 128) {
        const oldest = handled.current.values().next().value;
        if (oldest) handled.current.delete(oldest);
      }
      const { navigate, openSearch, notify, state } = current.current;
      switch (request.action) {
        case 'study-log.manual':
        case 'study-log.timer':
        case 'study-log.week':
          if ('studyLog' in state) {
            // This is the canonical StudyLogProvider boundary, owned by the Log feature.
            const mode = request.action === 'study-log.manual' ? 'manual' : request.action === 'study-log.timer' ? 'timer' : 'week';
            window.dispatchEvent(new CustomEvent('centre:study-log-action', { detail: { id: request.id, mode } }));
          } else notify({ tone: 'error', message: 'Study Log is unavailable in this build of Centre.' });
          break;
        case 'chat.new': navigate({ kind: 'home' }); break;
        case 'app.search': openSearch(); break;
        case 'app.resources': navigate({ kind: 'resources' }); break;
        case 'app.calendar': navigate({ kind: 'calendar' }); break;
        case 'app.settings': navigate({ kind: 'settings' }); break;
        default: { const exhaustive: never = request.action; return exhaustive; }
      }
      // Give React the transition before the next queued action can arrive.
      frame = requestAnimationFrame(() => {
        if (!request.action.startsWith('study-log.') && request.action !== 'app.search' && request.action !== 'chat.new') {
          const heading = document.querySelector<HTMLElement>('.main__content h1');
          if (heading) { heading.tabIndex = -1; heading.focus(); }
        }
        acknowledge(request.id);
      });
    }
    const unsubscribe = bridge.subscribe(value => {
      const result = desktopActionRequestSchema.safeParse(value);
      if (!result.success) return;
      pending = result.data;
      if (document.querySelector('dialog[open]')) {
        const label = desktopActions.find(action => action.id === result.data.action)?.label ?? 'desktop action';
        current.current.notify({ tone: 'info', message: `Close the current dialog to open ${label}.` });
      }
      drain();
    });
    const observer = new MutationObserver(drain);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    void bridge.ready().catch(() => {
      if (alive) current.current.notify({ tone: 'error', message: 'Desktop actions could not connect. Reopen Centre to try again.' });
    });
    return () => { alive = false; unsubscribe(); observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return null;
}
