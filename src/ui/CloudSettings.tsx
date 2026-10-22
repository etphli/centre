import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Copy, RefreshCw, CheckCircle2, PauseCircle, CircleAlert } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { cloudApi } from '../data/client';
import type { CloudStatus } from '../../shared/cloud-status';
import { useApp } from './context';
import { errorMessage, plural, timeAgo } from './format';
import './cloud-settings.css';

const POLL_MS = 2000;
const SIGN_IN_LIMIT_MS = 180_000;

type Pairing = { baseUrl: string; code: string; expiresAt: string };

function Status({ tone, children }: { tone: 'ok' | 'off' | 'error' | 'busy'; children: ReactNode }) {
  return (
    <p className={`status status--${tone}`} role="status">
      {tone === 'busy' ? <span className="spinner spinner--small" aria-hidden /> : tone === 'ok' ? <CheckCircle2 size={14} aria-hidden /> : tone === 'error' ? <CircleAlert size={14} aria-hidden /> : <PauseCircle size={14} aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

/** Accepts an https address, or plain http on this computer for local development. */
function checkAddress(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return null;
    return 'Use an https address.';
  } catch {
    return 'That isn’t a valid web address.';
  }
}

function describe(status: CloudStatus): { tone: 'ok' | 'off' | 'error' | 'busy'; text: string } {
  const waiting = status.pending ? `${plural(status.pending, 'change')} waiting to upload` : '';
  switch (status.phase) {
    case 'syncing': return { tone: 'busy', text: waiting ? `Syncing, ${waiting}` : 'Syncing' };
    case 'conflict': return { tone: 'error', text: `${plural(status.conflicts.length, 'item')} changed on both sides. Choose which copy to keep.` };
    case 'error': return { tone: 'error', text: `Sync stopped: ${status.error ?? 'unknown error'}` };
    case 'pending': return { tone: 'off', text: status.error ? `Sync paused. ${waiting || 'Changes are waiting to upload'}. ${status.error}` : waiting || 'Changes waiting to upload' };
    case 'ready': return { tone: 'ok', text: status.lastSyncedAt ? `Synced ${timeAgo(status.lastSyncedAt)}` : 'Connected, not synced yet' };
    default: return { tone: 'off', text: status.authenticated ? 'Signed in. Sync is off.' : 'Local only' };
  }
}

export function CloudSettings() {
  const { state, act, notify } = useApp();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'configure' | 'sign-in' | 'import' | 'sync' | 'pair' | 'disconnect' | 'resolve' | null>(null);
  const [signingInSince, setSigningInSince] = useState<number | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const live = useRef(true);
  const pairLink = pairing ? `centre://pair?baseUrl=${encodeURIComponent(pairing.baseUrl)}&code=${encodeURIComponent(pairing.code)}` : null;
  const pairingQr = useMemo(()=>{
    if (!pairLink) return null;
    const qr = qrcode(0,'M'); qr.addData(pairLink); qr.make();
    return `data:image/svg+xml,${encodeURIComponent(qr.createSvgTag({cellSize:4,margin:16,scalable:true}))}`;
  },[pairLink]);

  function apply(next: CloudStatus | undefined) {
    if (!next || !live.current) return next;
    setStatus(next);
    setLoadError(null);
    return next;
  }

  useEffect(() => {
    live.current = true;
    cloudApi.status().then((next) => {
      if (!live.current) return;
      setStatus(next);
      setAddress(next.baseUrl);
    }).catch((failure: unknown) => { if (live.current) setLoadError(errorMessage(failure)); });
    return () => { live.current = false; };
  }, []);

  // Poll while the browser sign-in is open or a sync is in flight.
  const syncing = status?.phase === 'syncing' || status?.phase === 'pending';
  useEffect(() => {
    if (signingInSince === null && !syncing) return;
    const timer = setInterval(() => {
      if (signingInSince !== null && Date.now() - signingInSince > SIGN_IN_LIMIT_MS) {
        setSigningInSince(null);
        return;
      }
      cloudApi.status().then((next) => {
        if (!live.current) return;
        setStatus(next);
        if (signingInSince !== null && next.authenticated) {
          setSigningInSince(null);
          notify({ tone: 'success', message: 'Signed in to Centre cloud' });
        }
      }).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [signingInSince, syncing, notify]);

  // The pairing code is single-use and short-lived: drop it from memory when it expires.
  useEffect(() => {
    if (!pairing) return;
    const remaining = new Date(pairing.expiresAt).getTime() - Date.now();
    const timer = setTimeout(() => setPairing(null), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [pairing]);

  async function run<T>(kind: NonNullable<typeof busy>, work: () => Promise<T>, success?: string) {
    setBusy(kind);
    try {
      return await act(work, success);
    } finally {
      if (live.current) setBusy(null);
    }
  }

  async function configure(event: FormEvent) {
    event.preventDefault();
    const value = address.trim();
    const problem = checkAddress(value);
    setAddressError(problem);
    if (problem) return;
    const next = apply(await run('configure', () => cloudApi.configure(value), 'Cloud address saved'));
    if (next) setAddress(next.baseUrl);
  }

  async function signIn() {
    const result = await run('sign-in', () => cloudApi.signIn());
    if (result) setSigningInSince(Date.now());
  }

  async function disconnect() {
    setPairing(null);
    setConfirmDisconnect(false);
    apply(await run('disconnect', () => cloudApi.disconnect(), 'Sync turned off. Everything on this computer is kept.'));
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      notify({ tone: 'success', message: 'Pairing link copied' });
    } catch {
      notify({ tone: 'error', message: 'Couldn’t copy the pairing link. Try again.' });
    }
  }

  const section = (body: ReactNode) => (
    <section className="settings-section" aria-labelledby="settings-cloud">
      <div className="settings-section__intro">
        <h2 className="settings-section__title" id="settings-cloud">Centre cloud</h2>
        <p className="settings-section__description">
          Keep your study available on your other devices. Everything stays on this computer until you enable sync.
        </p>
      </div>
      <div className="settings-section__body">{body}</div>
    </section>
  );

  if (!status) {
    return section(loadError
      ? <Status tone="error">Cloud status unavailable: {loadError}</Status>
      : <Status tone="busy">Checking cloud status</Status>);
  }

  const summary = describe(status);
  const configured = Boolean(status.baseUrl);

  return section(<>
    <div className="settings-row">
      {signingInSince !== null
        ? <Status tone="busy">Finish signing in with Google in your browser.</Status>
        : !configured ? <Status tone="off">Not set up</Status>
        : <Status tone={summary.tone}>{summary.text}</Status>}
      <div className="settings-row__actions">
        {signingInSince !== null ? <button type="button" className="button button--quiet button--small" onClick={() => setSigningInSince(null)}>Cancel</button> : null}
        {configured && !status.authenticated ? (
          <button type="button" className="button button--small" onClick={() => void signIn()} disabled={Boolean(busy)}>
            {signingInSince !== null ? 'Open Google again' : 'Sign in with Google'}
          </button>
        ) : null}
        {status.enabled ? (
          <button type="button" className="button button--small" onClick={() => void run('sync', async () => apply(await cloudApi.sync()))} disabled={Boolean(busy) || status.phase === 'syncing'}>
            <RefreshCw size={14} className={busy === 'sync' || status.phase === 'syncing' ? 'spin' : undefined} /> Sync now
          </button>
        ) : null}
      </div>
    </div>

    {!status.enabled ? (
      <form className="form cloud-settings__form" onSubmit={(event) => void configure(event)}>
        <label className="field">
          <span className="field__label">Storage address</span>
          <input
            value={address}
            onChange={(event) => { setAddress(event.target.value); setAddressError(null); }}
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            placeholder="https://your-centre-worker.example"
          />
        </label>
        {addressError ? <p className="form__error" role="alert">{addressError}</p> : null}
        <div className="form__actions">
          <button type="submit" className="button button--small" disabled={Boolean(busy) || !address.trim() || address.trim() === status.baseUrl}>
            {busy === 'configure' ? 'Saving' : 'Save address'}
          </button>
        </div>
      </form>
    ) : null}

    {status.authenticated && !status.enabled ? (
      <div className="form form--settings">
        <p className="muted">
          Importing saves a backup on this computer, then syncs your resources, chats, practice and study history. Your app connections and Codex settings stay on this computer.
        </p>
        <div className="form__actions">
          <button type="button" className="button button--primary button--small" onClick={() => void run('import', async () => apply(await cloudApi.importData()))} disabled={Boolean(busy)}>
            {busy === 'import' ? 'Importing' : 'Import and enable sync'}
          </button>
        </div>
      </div>
    ) : null}

    {status.conflicts.length ? (
      <div className="form form--settings" role="list" aria-label="Sync conflicts">
        {status.conflicts.map((conflict) => (
          <div className="settings-row" role="listitem" key={`${conflict.kind}:${conflict.id}`}>
            <span className="settings-detail">Changed here and in the cloud: {conflict.label}</span>
            <div className="settings-row__actions">
              {conflict.canKeepLocal ? <button type="button" className="button button--quiet button--small" disabled={Boolean(busy)} onClick={() => void run('resolve', async () => apply(await cloudApi.resolve(conflict.kind, conflict.id, 'local')))}>
                Keep this device
              </button> : null}
              <button type="button" className="button button--small" disabled={Boolean(busy)} onClick={() => void run('resolve', async () => apply(await cloudApi.resolve(conflict.kind, conflict.id, 'cloud')))}>
                Use cloud copy
              </button>
            </div>
          </div>
        ))}
      </div>
    ) : null}

    {status.enabled ? (
      <dl className="facts">
        <div><dt>Address</dt><dd>{status.baseUrl}</dd></div>
        <div><dt>Account</dt><dd>{state.settings.cloudAccount?.email ?? state.settings.account?.email ?? 'Connected Centre account'}</dd></div>
        <div><dt>Device</dt><dd>This computer</dd></div>
        <div><dt>Waiting</dt><dd>{status.pending ? plural(status.pending, 'change') : 'Nothing'}</dd></div>
        <div><dt>Last sync</dt><dd>{status.lastSyncedAt ? timeAgo(status.lastSyncedAt) : 'Not yet'}</dd></div>
      </dl>
    ) : null}

    {pairing && pairLink && pairingQr ? (
      <div className="form form--settings cloud-settings__pairing">
        <img src={pairingQr} className="cloud-settings__qr" width={192} height={192} alt="Scan to pair another device with Centre" />
        <p className="muted">Scan with your other device&rsquo;s camera, or copy the link. It works once and expires at {new Date(pairing.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</p>
        <div className="form__actions">
          <button type="button" className="button button--quiet button--small" onClick={() => setPairing(null)}>Done</button>
          <button type="button" className="button button--small" onClick={() => void copyLink(pairLink)}><Copy size={14} /> Copy link</button>
        </div>
      </div>
    ) : null}

    {status.authenticated && confirmDisconnect ? (
      <div className="form form--settings" role="alertdialog" aria-label="Turn off sync">
        <p className="muted">Sync stops on this computer. Everything here stays, and the cloud copy isn&rsquo;t deleted.</p>
        <div className="form__actions">
          <button type="button" className="button button--quiet button--small" onClick={() => setConfirmDisconnect(false)}>Cancel</button>
          <button type="button" className="button button--small cloud-settings__disconnect" onClick={() => void disconnect()} disabled={Boolean(busy)}>
            {busy === 'disconnect' ? 'Turning off' : 'Turn off sync'}
          </button>
        </div>
      </div>
    ) : status.authenticated ? (
      <div className="settings-row__actions">
        {status.enabled ? <button type="button" className="button button--small" disabled={Boolean(busy)} onClick={() => void run('pair', async () => { const next = await cloudApi.pairing(); if (live.current) setPairing(next); return next; })}>
          Pair another device
        </button> : null}
        <button type="button" className="button button--quiet button--small cloud-settings__disconnect" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
      </div>
    ) : null}
  </>);
}
