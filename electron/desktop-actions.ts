import { randomUUID } from 'node:crypto';
import { parseDesktopActionUrl, type DesktopActionRequest } from '../shared/desktop-actions';

/** At-most-once delivery: a new renderer never replays a request sent to its predecessor. */
export function createDesktopActionDelivery(send: (request: DesktopActionRequest) => void, onError: (error: unknown) => void) {
  const pending: DesktopActionRequest[] = [];
  let ready = false;
  let inFlight: DesktopActionRequest | undefined;

  function drain() {
    if (!ready || inFlight) return;
    const request = pending[0];
    if (!request) return;
    inFlight = request;
    try {
      send(request);
      pending.shift();
    } catch (error) {
      inFlight = undefined;
      ready = false;
      onError(error);
    }
  }

  function enqueueUrl(url: string): boolean {
    const action = parseDesktopActionUrl(url);
    if (!action) return false;
    pending.push({ id: randomUUID(), action });
    drain();
    return true;
  }

  return {
    enqueueUrl,
    enqueueArgv(argv: readonly string[]) {
      for (const value of argv) enqueueUrl(value);
    },
    ready() { ready = true; drain(); },
    unready() {
      ready = false;
      // A delivered request may already have changed app state, even without an ack.
      inFlight = undefined;
    },
    acknowledge(id: string) {
      if (inFlight?.id !== id) return;
      inFlight = undefined;
      drain();
    },
  };
}

type DesktopWindow = {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

/** Coalesce launch events while a closed window is being recreated. */
export function createDesktopWindowOpener(options: {
  available(): boolean;
  getWindow(): DesktopWindow | null;
  createWindow(): Promise<void>;
}) {
  let opening: Promise<void> | undefined;
  return async function open() {
    if (!options.available()) return;
    if (opening) await opening;
    else if (!options.getWindow()) {
      opening = options.createWindow();
      try { await opening; } finally { opening = undefined; }
    }
    const window = options.getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
}
