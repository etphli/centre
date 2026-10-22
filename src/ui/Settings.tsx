import { Connections } from './Connections';
import { ExternalLink, LogOut, RefreshCw, SlidersHorizontal, GraduationCap, Cpu, Plug, Wand2, Download, Brain } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, openExternal, updates, type UpdateStatus } from '../data/client';
import { useApp } from './context';
import { GeneralPreferences, StudyPreferences, ModelPreferences, SkillsPreferences } from './preferences';
import { errorMessage, initials, timeAgo } from './format';
import { MemorySettings } from './MemorySettings';
import { CloudSettings } from './CloudSettings';

const POLL_MS = 2000;
const POLL_LIMIT_MS = 180_000;

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={id}>
      <div className="settings-section__intro">
        <h2 className="settings-section__title" id={id}>{title}</h2>
        {description ? <p className="settings-section__description">{description}</p> : null}
      </div>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function Status({ tone, children }: { tone: 'ok' | 'off' | 'error' | 'busy'; children: ReactNode }) {
  return (
    <p className={`status status--${tone}`}>
      {tone === 'busy' ? <span className="spinner spinner--small" aria-hidden /> : <span className="status__dot" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

/** Polls the snapshot until `done` is true or the time limit passes. */
function usePoll(refresh: () => Promise<void>) {
  const [polling, setPolling] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPolling(null);
  };
  const start = (label: string) => {
    stop();
    setPolling(label);
    const started = Date.now();
    timer.current = setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) stop();
      else void refresh().catch(() => undefined);
    }, POLL_MS);
  };
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);
  return { polling, start, stop };
}

function GoogleSection() {
  const { state, act, notify, refresh } = useApp();
  const account = state.settings.account;
  const poll = usePoll(refresh);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (account && poll.polling) {
      poll.stop();
      notify({ tone: 'success', message: `Signed in as ${account.email}` });
    }
  }, [account, poll, notify]);

  async function signIn() {
    setBusy(true);
    const result = await act(() => api.googleSignIn());
    setBusy(false);
    if (result) poll.start('google');
  }

  return (
    <Section id="settings-account" title="Account" description="Sign in with Google so Centre knows who you are on this computer. Centre cloud sync is configured separately above.">
      {account ? (
        <div className="account-card">
          {account.picture ? <img className="avatar avatar--large" src={account.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar avatar--large" aria-hidden>{initials(account.name)}</span>}
          <div className="account-card__text">
            <span className="account-card__name">{account.name}</span>
            <span className="muted">{account.email}</span>
          </div>
          <button type="button" className="button button--quiet button--small" onClick={() => void act(() => api.googleSignOut(), 'Signed out')}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      ) : (
        <div className="settings-row">
          {poll.polling ? <Status tone="busy">Finish signing in with Google in your browser.</Status> : <Status tone="off">Not signed in</Status>}
          <div className="settings-row__actions">
            {poll.polling ? <button type="button" className="button button--quiet button--small" onClick={poll.stop}>Cancel</button> : null}
            <button type="button" className="button button--small" onClick={() => void signIn()} disabled={busy}>
              {poll.polling ? 'Open Google again' : 'Sign in with Google'}
            </button>
          </div>
        </div>
      )}

    </Section>
  );
}

function OrganatoSection() {
  const { state, act } = useApp();
  const settings = state.settings;
  const [baseUrl, setBaseUrl] = useState(settings.organatoBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const url = new URL(baseUrl.trim());
      if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        setError('Use an https address.');
        return;
      }
    } catch {
      setError('That isn’t a valid web address.');
      return;
    }
    setSaving(true);
    const patch = { organatoBaseUrl: baseUrl.trim(), ...(apiKey ? { organatoApiKey: apiKey } : {}) };
    const saved = await act(() => api.saveSettings(patch), 'Organato settings saved');
    setApiKey('');
    setSaving(false);
    if (saved && patch.organatoApiKey) {
      setSyncing(true);
      await act(() => api.syncOrganato(), 'Synced with Organato');
      setSyncing(false);
    }
  }

  async function sync() {
    setSyncing(true);
    await act(() => api.syncOrganato(), 'Synced with Organato');
    setSyncing(false);
  }

  return (
    <Section id="settings-organato" title="Organato" description="Your subjects, assignments and to-dos connect to Organato. Study sessions are saved there as calendar-enabled to-dos.">
      <div className="settings-row">
        {syncing ? (
          <Status tone="busy">Syncing</Status>
        ) : state.syncError ? (
          <Status tone="error">Sync failed: {state.syncError}</Status>
        ) : settings.organatoConnected ? (
          <Status tone="ok">Connected{state.lastSyncedAt ? `, last synced ${timeAgo(state.lastSyncedAt)}` : ', not synced yet'}</Status>
        ) : (
          <Status tone="off">Not connected</Status>
        )}
        <div className="settings-row__actions">
          <button type="button" className="button button--small" onClick={() => void sync()} disabled={syncing || !settings.organatoConnected}>
            <RefreshCw size={14} className={syncing ? 'spin' : undefined} /> Sync now
          </button>
        </div>
      </div>
      <form className="form form--settings" onSubmit={(event) => void save(event)}>
        <label className="field">
          <span className="field__label">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={settings.organatoConnected ? 'Saved in your Keychain. Enter a new key to replace it.' : 'Paste your Organato API key'}
          />
        </label>
        <label className="field">
          <span className="field__label">API address</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} autoComplete="off" inputMode="url" />
        </label>
        {error ? <p className="form__error" role="alert">{error}</p> : null}
        <div className="form__actions">
          <button type="submit" className="button button--primary button--small" disabled={saving || (!apiKey && baseUrl.trim() === settings.organatoBaseUrl)}>
            {saving ? 'Saving' : apiKey ? 'Save and sync' : 'Save'}
          </button>
        </div>
      </form>
    </Section>
  );
}

function CodexSection() {
  const { state, act, refresh, notify } = useApp();
  const codex = state.codex;
  const poll = usePoll(refresh);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (codex.authenticated && poll.polling) {
      poll.stop();
      setMessage(null);
      notify({ tone: 'success', message: 'Codex is signed in' });
    }
  }, [codex.authenticated, poll, notify]);

  async function signIn() {
    setBusy(true);
    const result = await act(() => api.codexSignIn());
    setBusy(false);
    if (result) {
      setMessage(result.message);
      poll.start('codex');
    }
  }

  return (
    <Section id="settings-codex" title="Codex" description="Chat, resource generation and marking use Codex CLI on this computer.">
      <div className="settings-row">
        {poll.polling ? (
          <Status tone="busy">Waiting for Codex sign-in</Status>
        ) : !codex.available ? (
          <Status tone="error">Codex isn&rsquo;t available</Status>
        ) : codex.authenticated ? (
          <Status tone="ok">Signed in</Status>
        ) : (
          <Status tone="off">Not signed in</Status>
        )}
        <div className="settings-row__actions">
          <button type="button" className="button button--quiet button--small" onClick={() => void act(refresh)}>Check again</button>
          {codex.available && !codex.authenticated ? (
            <button type="button" className="button button--small" onClick={() => void signIn()} disabled={busy}>Sign in to Codex</button>
          ) : null}
        </div>
      </div>
      {codex.message ? <p className="settings-detail">{codex.message}</p> : null}
      {message ? <p className="settings-detail">{message}</p> : null}
    </Section>
  );
}

function UpdatesSection() {
  const { notify } = useApp();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<'check' | 'install' | 'configure' | null>(null);
  const [token, setToken] = useState('');

  useEffect(() => {
    let live = true;
    updates.status().then((next) => { if (live) setStatus(next); }).catch((failure: unknown) => { if (live) setStatus({ state: 'error', message: errorMessage(failure) }); });
    return () => { live = false; };
  }, []);

  async function runUpdate(kind: 'check' | 'install') {
    setBusy(kind);
    try {
      setStatus(await (kind === 'check' ? updates.check() : updates.install()));
    } catch (failure) {
      setStatus({ state: 'error', message: errorMessage(failure) });
    } finally {
      setBusy(null);
    }
  }

  async function configure(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy('configure');
    try {
      setStatus(await updates.configure({ token }));
      notify({ tone: 'success', message: 'Update access saved' });
    } catch (failure) {
      setStatus({ state: 'error', message: errorMessage(failure) });
    } finally {
      setToken('');
      setBusy(null);
    }
  }

  const unavailable = status?.state === 'unavailable';
  const tone = !status ? 'busy' : status.state === 'error' ? 'error' : status.downloaded || /available|downloaded/i.test(status.state) ? 'ok' : 'off';

  return (
    <Section id="settings-updates" title="App updates" description="Centre checks GitHub releases. Nothing installs without you pressing Install.">
      <div className="settings-row">
        <Status tone={busy ? 'busy' : tone}>{status ? status.message : 'Checking update status'}{status?.version ? ` (${status.version})` : ''}</Status>
        <div className="settings-row__actions">
          <button type="button" className="button button--quiet button--small" onClick={() => void runUpdate('check')} disabled={Boolean(busy) || unavailable}>
            {busy === 'check' ? 'Checking' : 'Check for updates'}
          </button>
          <button type="button" className="button button--small" onClick={() => void runUpdate('install')} disabled={Boolean(busy) || unavailable || !status?.downloaded}>
            {busy === 'install' ? 'Installing' : 'Install and restart'}
          </button>
        </div>
      </div>
      {status && status.configured === false ? (
        <form className="form form--settings" onSubmit={(event) => void configure(event)}>
          <label className="field">
            <span className="field__label">GitHub access token for releases</span>
            <input type="password" value={token} onChange={(event) => setToken(event.target.value)} spellCheck={false} autoComplete="off" placeholder="Read-only token, stored in your Keychain" />
          </label>
          <div className="form__actions">
            <button type="submit" className="button button--small" disabled={!token || Boolean(busy)}>Save token</button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

const categories = [
  { id:'general',label:'General',icon:SlidersHorizontal },
  { id:'study',label:'Study',icon:GraduationCap },
  { id:'memory',label:'Memory',icon:Brain },
  { id:'models',label:'Models',icon:Cpu },
  { id:'connections',label:'Connections',icon:Plug },
  { id:'skills',label:'Skills',icon:Wand2 },
  { id:'updates',label:'Updates',icon:Download },
];

export function SettingsPage() {
  const [category,setCategory] = useState('general');
  return <div className="settings-layout">
    <nav className="settings-layout__nav" aria-label="Settings categories"><h1>Settings</h1>{categories.map(item => <button type="button" key={item.id} aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}><item.icon size={14} />{item.label}</button>)}</nav>
    <div className="settings-layout__content"><h1>{categories.find(item => item.id === category)?.label}</h1>
      {category === 'general' ? <GeneralPreferences /> : null}
      {category === 'study' ? <StudyPreferences /> : null}
      {category === 'memory' ? <MemorySettings /> : null}
      {category === 'models' ? <><ModelPreferences /><CodexSection /></> : null}
      {category === 'connections' ? <><CloudSettings /><Connections /><GoogleSection /><OrganatoSection /><p className="settings-foot">Credentials are stored in your macOS Keychain. <button type="button" className="link-button" onClick={() => void openExternal('https://organato.vercel.app').catch(() => undefined)}>Open Organato <ExternalLink size={12} aria-hidden /></button></p></> : null}
      {category === 'skills' ? <SkillsPreferences /> : null}
      {category === 'updates' ? <UpdatesSection /> : null}
    </div>
  </div>;
}
