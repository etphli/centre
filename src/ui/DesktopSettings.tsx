import { Check, FileWarning, Monitor, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { desktopActions, type DesktopAction } from '../../shared/desktop-actions';
import { launcherListSchema, type LauncherList, type LauncherOperation, type LauncherStatus } from '../../shared/desktop-launchers';
import { useApp } from './context';
import { errorMessage } from './format';
import './desktop-settings.css';

const labels: Record<LauncherStatus['state'], string> = {
  absent: 'Not on Desktop', installed: 'On Desktop', missing: 'Icon missing', conflict: 'File needs attention',
};

export function DesktopSettings() {
  const { state, notify } = useApp();
  const [result, setResult] = useState<LauncherList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<DesktopAction | null>(null);
  const rows = useRef(new Map<DesktopAction, HTMLLIElement>());
  const studyLogAvailable = 'studyLog' in state;
  async function reload() {
    const bridge = window.centre?.launchers;
    if (!bridge) return;
    setError('');
    try { setResult(launcherListSchema.parse(await bridge.list())); }
    catch (failure) { setError(errorMessage(failure)); }
  }
  useEffect(() => {
    let alive = true;
    const bridge = window.centre?.launchers;
    if (!bridge) { setResult({ supported: false, message: 'Desktop icons are available in the installed Centre app for macOS.', launchers: [] }); return; }
    void bridge.list().then(value => { if (alive) setResult(launcherListSchema.parse(value)); }).catch(failure => { if (alive) setError(errorMessage(failure)); });
    return () => { alive = false; };
  }, []);

  async function change(action: DesktopAction, operation: LauncherOperation) {
    const bridge = window.centre?.launchers;
    if (!bridge) return;
    setError(''); setBusy(action);
    try {
      setResult(launcherListSchema.parse(await bridge.change(action, operation)));
      const verb = operation === 'create' ? 'Added' : operation === 'repair' ? 'Repaired' : 'Removed';
      notify({ tone: 'success', message: `${verb} ${desktopActions.find(item => item.id === action)?.label ?? 'icon'}${operation === 'remove' ? ' from' : ' on'} Desktop.` });
    } catch (failure) { setError(errorMessage(failure)); }
    finally {
      setBusy(null);
      requestAnimationFrame(() => rows.current.get(action)?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    }
  }

  return <section className="desktop-settings" aria-labelledby="desktop-icons-title">
    <div className="desktop-settings__intro">
      <Monitor size={22} strokeWidth={1.5} aria-hidden />
      <div><h2 id="desktop-icons-title">Centre, one click away</h2><p>Add just the icons you want. Each opens Centre straight to an action, even when the app is closed.</p></div>
    </div>
    <div className="desktop-settings__tools"><p className="desktop-settings__note">Icons are named “Centre – …” on your Desktop. You can remove them here at any time.</p>{window.centre?.launchers ? <button type="button" className="button button--quiet button--small" disabled={Boolean(busy)} onClick={() => void reload()}><RotateCcw size={13} aria-hidden />Refresh icons</button> : null}</div>
    {error ? <p className="form__error" role="alert">{error}</p> : null}
    {!result && !error ? <p className="muted" role="status"><span className="spinner spinner--small" aria-hidden /> Checking desktop icons…</p> : null}
    {result && !result.supported ? <p className="desktop-settings__unavailable" role="status">{result.message}</p> : null}
    {result?.supported ? <>
      {!studyLogAvailable ? <p className="desktop-settings__unavailable">Study icons will be available when this build includes Study Log.</p> : null}
      <ul className="desktop-settings__list">
        {desktopActions.map(action => {
          const status = result.launchers.find(item => item.action === action.id);
          if (!status) return null;
          const requiresLog = action.id.startsWith('study-log.') && !studyLogAvailable;
          const working = busy === action.id;
          const operation = status.state === 'missing' ? 'repair' : 'create';
          return <li key={action.id} ref={element => { if (element) rows.current.set(action.id, element); else rows.current.delete(action.id); }} className="desktop-settings__row" data-action={action.id}>
            <div className="desktop-settings__label"><h3>{action.label}</h3><p>{action.detail}</p>
              <span className={`desktop-settings__status desktop-settings__status--${status.state}`} aria-live="polite">
                {working ? <span className="spinner spinner--small" aria-hidden /> : status.state === 'installed' ? <Check size={12} aria-hidden /> : status.state === 'conflict' ? <FileWarning size={12} aria-hidden /> : null}
                {working ? 'Updating icon…' : labels[status.state]}
              </span>
              {status.state === 'conflict' ? <p className="desktop-settings__conflict">“{status.filename}” was changed or belongs to you. Move or rename it in Finder to keep it safe.</p> : null}
            </div>
            <div className="desktop-settings__actions">
              {status.state === 'installed' || status.state === 'missing' ? <button type="button" className="button button--quiet button--small" aria-label={`Remove ${action.label} desktop icon`} disabled={Boolean(busy)} onClick={() => void change(action.id, 'remove')}><Trash2 size={13} aria-hidden />Remove</button> : null}
              {status.state === 'absent' || status.state === 'missing' ? <button type="button" className="button button--small" aria-label={`${operation === 'repair' ? 'Repair' : 'Add'} ${action.label} desktop icon`} disabled={Boolean(busy) || requiresLog} onClick={() => void change(action.id, operation)}>{operation === 'repair' ? <RotateCcw size={13} aria-hidden /> : <Plus size={13} aria-hidden />}{operation === 'repair' ? 'Repair' : 'Add icon'}</button> : null}
            </div>
          </li>;
        })}
      </ul>
      <p className="desktop-settings__note">Log study opens the entry form. Study timer opens its controls and waits for you to start. Existing files are never replaced.</p>
    </> : null}
  </section>;
}
