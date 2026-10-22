import { useEffect, useState } from 'react';
import { ExternalLink, Smartphone } from 'lucide-react';
import { mobileDistribution } from '../../shared/mobile-distribution';
import { api, openExternal } from '../data/client';
import { errorMessage } from './format';

const distribution = mobileDistribution(import.meta.env.VITE_CENTRE_IOS_DISTRIBUTION_URL);

function AccountPairing() {
  const [pairing, setPairing] = useState<{qr:string;expiresAt:string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  async function create() {
    setBusy(true); setError(null); setPairing(null);
    try {
      const value = await api.mobilePairing();
      const base = new URL(value.baseUrl);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['','/'].includes(base.pathname) || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 6 * 60_000) throw new Error('Centre Cloud returned an invalid pairing invitation.');
      const url = new URL('centre://pair');
      url.searchParams.set('baseUrl',base.href); url.searchParams.set('code',value.code);
      const module = await import('qrcode');
      const qr = await module.toDataURL(url.href,{width:260,margin:4,errorCorrectionLevel:'M'});
      setNow(Date.now()); setPairing({qr,expiresAt:value.expiresAt});
    } catch (failure) {
      const message = errorMessage(failure);
      setError(message === 'Endpoint not found.' ? 'Account pairing is unavailable in this build. Connect Centre Cloud in Connections after the cloud update is installed.' : message);
    }
    finally { setBusy(false); }
  }
  const expires = pairing ? Math.ceil((Date.parse(pairing.expiresAt)-now)/1000) : 0;
  return <>
    <p>Sign in to Centre Cloud in Connections first. Create a one-time account code, then scan it with the installed Centre iPhone app.</p>
    <button type="button" className="button button--small" onClick={() => void create()} disabled={busy}>{busy ? 'Creating code' : 'Create account pairing code'}</button>
    {pairing && expires > 0 ? <div className="mobile-install"><img className="mobile-install__qr" src={pairing.qr} width={260} height={260} alt="One-time Centre account pairing code. Keep this private." /><div><p>Account access code. Keep this private.</p><p className="settings-detail">Expires in {Math.ceil(expires/60)} minutes and works once. This connects your account; it does not install the app.</p><button type="button" className="button button--quiet button--small" onClick={() => setPairing(null)}>Hide code</button></div></div> : pairing ? <p className="settings-detail" role="status">This account code has expired. Create a new one.</p> : null}
    {error ? <p className="form__error" role="alert">{error}</p> : null}
  </>;
}

export function MobileSettings() {
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!distribution) return;
    let live = true;
    void import('qrcode').then(module => module.toDataURL(distribution.url, { width:220, margin:4, errorCorrectionLevel:'M' }))
      .then(value => { if (live) setQr(value); }).catch(() => { if (live) setError('The installation code could not load. Use the installation link.'); });
    return () => { live = false; };
  }, []);
  return <div className="mobile-settings">
    <section className="settings-section" aria-labelledby="mobile-install">
      <div className="settings-section__intro"><h2 id="mobile-install" className="settings-section__title">Centre for iPhone</h2><p className="settings-section__description">Take your study with you. Read saved resources, practise quizzes and keep your study Log offline.</p></div>
      <div className="settings-section__body">
        {distribution ? <div className="mobile-install">
          {qr ? <img className="mobile-install__qr" src={qr} width={220} height={220} alt="Scan to open Centre's Apple installation invitation" /> : <Smartphone size={40} aria-hidden />}
          <div><p>Scan with your iPhone camera to open {distribution.kind === 'testflight' ? 'the TestFlight invitation' : 'Centre in the App Store'}.</p><p className="settings-detail">Apple controls build availability. A configured link does not guarantee that testing is currently open.</p><button className="button button--small" type="button" onClick={() => void openExternal(distribution.url).catch(() => setError('The installation link could not open.'))}>Open installation link <ExternalLink size={12} /></button></div>
        </div> : <div className="mobile-install"><Smartphone size={40} aria-hidden /><div><p>An iPhone release is not available yet.</p><p className="settings-detail">An approved TestFlight invitation or App Store listing will appear here when distribution is ready.</p></div></div>}
        {error ? <p className="form__error" role="alert">{error}</p> : null}
      </div>
    </section>
    <section className="settings-section" aria-labelledby="mobile-account">
      <div className="settings-section__intro"><h2 id="mobile-account" className="settings-section__title">Connect your account</h2><p className="settings-section__description">Installation and account access are separate.</p></div>
      <div className="settings-section__body"><AccountPairing /><p className="settings-detail">The installation code contains no account credentials. Mobile AI uses Centre Cloud with Llama 3.1, within a daily allowance. Desktop Codex sign-in does not grant cloud AI access.</p></div>
    </section>
  </div>;
}
