import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, BookOpen, CalendarDays, ChartNoAxesCombined, Check, ChevronRight, ContactRound, FileSpreadsheet, FileText, Files, Film, ListChecks, MessageCircle, NotebookPen, Presentation, Search, Video } from 'lucide-react';
import { connectorCatalog, googleConnectorIdSchema, type ConnectorId } from '../../shared/connectors';
import { api, openExternal } from '../data/client';
import { useApp } from './context';
import './connections.css';

const icons = { 'google-drive': Files, 'google-docs': FileText, 'google-sheets': FileSpreadsheet, 'google-slides': Presentation, 'google-calendar': CalendarDays, 'google-contacts': ContactRound, 'google-tasks': ListChecks, 'google-classroom': BookOpen, 'google-forms': NotebookPen, 'google-meet': Video, 'google-chat': MessageCircle, 'google-youtube': Film, 'google-analytics': ChartNoAxesCombined, 'google-search-console': Search, notion: NotebookPen };

export function Connections() {
  const { act, refresh } = useApp();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.connectors>> | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'connected'>('all');
  const [selected, setSelected] = useState<ConnectorId | null>(null);
  const [pending, setPending] = useState<ConnectorId | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [configure, setConfigure] = useState(false);
  const [editable, setEditable] = useState(false);
  async function reload() { const result = await api.connectors(); setStatus(result); return result; }
  useEffect(() => { let live = true; api.connectors().then(value => { if (live) setStatus(value); }).catch(failure => { if (live) setError(String(failure.message)); }); return () => { live = false; }; }, []);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const timer = setInterval(() => { void api.connectors().then(value => {
      if (!live) return;
      setStatus(value);
      if (value.connectors.some(item => item.id === pending && item.connected && (!editable || item.canEdit))) { setPending(null); void refresh(); }
    }).catch(failure => { if (live) { setError(failure instanceof Error ? failure.message : 'Connection status unavailable.'); setPending(null); } }); }, 2000);
    const timeout = setTimeout(() => { if (live) { setPending(null); setError('Connection timed out. Choose Connect to try again.'); } }, 5 * 60000);
    return () => { live = false; clearInterval(timer); clearTimeout(timeout); };
  }, [pending, refresh, editable]);
  async function connect(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError('');
    try {
      if (selected === 'notion') { await api.connectNotion(token.trim()); setToken(''); await reload(); await refresh(); }
      else { await api.connectGoogle(googleConnectorIdSchema.parse(selected), editable); setPending(selected); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not connect.'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!selected) return;
    setBusy(true);
    try { await api.disconnectConnector(selected); setPending(null); await reload(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not disconnect.'); }
    finally { setBusy(false); }
  }
  async function saveGoogle(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    const saved = await act(() => api.saveSettings({ googleClientId: clientId.trim(), ...(clientSecret ? { googleClientSecret: clientSecret.trim() } : {}) }), 'Google setup saved');
    setClientSecret(''); setBusy(false);
    if (saved) { setConfigure(false); await reload(); }
  }
  const detail = connectorCatalog.find(item => item.id === selected);
  const saved = status?.connectors.find(item => item.id === selected);
  const count = status?.connectors.filter(item => item.connected).length ?? 0;
  const visible = connectorCatalog.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || status?.connectors.some(saved => saved.id === item.id && saved.connected)));
  return <section className="connections" aria-label="Connected apps">
    <div className="connections__intro"><h2>Your apps, in Centre</h2><p>Bring your notes, classes and plans into the conversation. Choose the services Centre can read.</p></div>
    {error ? <p className="connections__error" role="alert">{error}</p> : null}
    {!status && !error ? <p role="status">Loading connections…</p> : null}
    {detail ? <div className="connection-detail">
      <button className="connection-back" type="button" onClick={() => { setSelected(null); setToken(''); setError(''); }}><ArrowLeft size={14} /> All apps</button>
      <div className="connection-detail__heading"><ServiceIcon id={detail.id} /><div><h3>{detail.name}</h3><p>{detail.description}</p></div></div>
      <p className="connection-permission">{saved?.canEdit ? 'Read and edit access' : 'Read access'}{saved?.connected ? ` · ${saved.account ?? 'Connected'}` : ' · You choose what to share'}</p>
      {saved?.connected && pending !== detail.id ? <div className="connection-actions"><span className="connection-connected"><Check size={14} /> Connected</span>{!saved.canEdit && ['google-docs','google-sheets','google-slides'].includes(detail.id) ? <button type="button" className="button button--small" disabled={busy || Boolean(pending)} onClick={async () => { setBusy(true); try { await api.connectGoogle(googleConnectorIdSchema.parse(detail.id), true); setEditable(true); setPending(detail.id); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not enable editing.'); } finally { setBusy(false); } }}>Enable editing</button> : null}<button type="button" className="button button--small" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></div> : pending === detail.id ? <div role="status"><p>Finish connecting in your browser. If access was declined, cancel and try again.</p><button type="button" className="button button--small" onClick={() => { void act(() => api.cancelConnector()); setPending(null); }}>Cancel connection</button></div> : <form className="form" onSubmit={event => void connect(event)}>
        {detail.id === 'notion' ? <><p>Use a Notion internal integration token, then add that integration to the pages you want Centre to read.</p><label className="field"><span className="field__label">Integration token</span><input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="Paste your Notion token" required /></label><button type="button" className="link-button" onClick={() => void openExternal('https://www.notion.so/profile/integrations')}>Create a Notion integration</button></> : <p>Google will ask you to approve this service. Your Google sign-in and other connections stay separate.</p>}
        {['google-docs','google-sheets','google-slides'].includes(detail.id) ? <label className="connection-edit-option"><input type="checkbox" checked={editable} onChange={event => setEditable(event.target.checked)} /> Allow Centre to edit this service when I ask</label> : null}
        <div className="form__actions"><button type="submit" className="button button--primary button--small" disabled={busy || Boolean(pending) || !status || (detail.id === 'notion' ? !token.trim() : !status.googleConfigured)}>{busy ? 'Connecting…' : `Connect ${detail.name}`}</button></div>
      </form>}
    </div> : <>
      <div className="connections__toolbar"><div className="connections__filters" role="group" aria-label="Filter apps"><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All apps <span>{connectorCatalog.length}</span></button><button type="button" aria-pressed={filter === 'connected'} onClick={() => setFilter('connected')}>Connected <span>{count}</span></button></div><label className="connections__search"><Search size={14} aria-hidden /><input aria-label="Search apps" placeholder="Find an app" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="connection-list">{visible.map(item => {
        const connected = status?.connectors.some(saved => saved.id === item.id && saved.connected);
        return <button type="button" className="connection-item" key={item.id} onClick={() => { setSelected(item.id); setEditable(false); setError(''); }}><ServiceIcon id={item.id} /><span className="connection-item__copy"><span className="connection-item__name">{item.name}</span><span className="connection-item__description">{item.description}</span></span><span className={`connection-item__status${connected ? ' is-connected' : ''}`}>{connected ? <><Check size={12} /> Connected</> : pending === item.id ? 'Connecting…' : 'Connect'}</span><ChevronRight size={14} aria-hidden /></button>;
      })}</div>
      {visible.length === 0 ? <p className="connections__empty">{query ? 'No apps match your search.' : 'No apps connected yet. Choose All apps to get started.'}</p> : null}
    </>}
    {status && (!status.googleConfigured || configure) ? <form className="form connection-setup" onSubmit={event => void saveGoogle(event)}><h3>Set up Google connections</h3><p>Use Desktop app OAuth credentials from your Google Cloud project. Enable the APIs for the services you want to connect.</p><label className="field"><span className="field__label">Google client ID</span><input value={clientId} onChange={event => setClientId(event.target.value)} required placeholder="Desktop OAuth client ID" /></label><label className="field"><span className="field__label">Client secret</span><input required type="password" autoComplete="off" value={clientSecret} onChange={event => setClientSecret(event.target.value)} placeholder="Desktop OAuth client secret" /></label><div className="form__actions"><button type="submit" className="button button--small" disabled={busy}>Save Google setup</button></div></form> : status ? <button type="button" className="link-button connection-setup-link" onClick={() => setConfigure(true)}>Google connection setup</button> : null}
    <p className="connections__foot">Credentials stay in your macOS Keychain. Gmail is excluded. Workspace access may depend on your school or organisation.</p>
  </section>;
}
function ServiceIcon({ id }: { id: ConnectorId }) {
  const Icon = icons[id]; const service = connectorCatalog.find(item => item.id === id);
  return <span className="service-icon" style={{ color: service?.color }} aria-hidden><Icon size={21} strokeWidth={1.7} /></span>;
}
