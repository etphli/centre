import { useEffect, useState } from 'react';
import { ExternalLink, Smartphone } from 'lucide-react';
import { mobileDistribution } from '../../shared/mobile-distribution';
import { mobilePairingUrl } from '../../shared/mobile-pairing';
import { api, copyText, openExternal } from '../data/client';
import { errorMessage } from './format';

const distribution = mobileDistribution(import.meta.env.VITE_CENTRE_IOS_DISTRIBUTION_URL);

export function MobileDownloadSummary({ onOpen }: { onOpen: () => void }) {
  return <div className="preference-row">
    <div><div className="preference-row__title">Centre for iPhone</div><p>{distribution ? 'Download Centre on your iPhone and connect your account.' : 'Not available to download yet. View release availability and setup in Centre’s iPhone section.'}</p></div>
    <div className="preference-row__control"><button type="button" className="button button--small" onClick={onOpen}><Smartphone size={14} aria-hidden />{distribution ? 'Download & setup' : 'View iPhone setup'}</button></div>
  </div>;
}

/** Shared by iPhone installation settings and Centre Cloud's account controls. */
export function AccountPairing({onSignIn}:{onSignIn:()=>void}) {
  const [pairing, setPairing] = useState<{qr:string;expiresAt:string;link:string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [authenticated,setAuthenticated] = useState(false);
  const [checking,setChecking] = useState(true);
  useEffect(() => {
    let live=true;
    const check=async()=>{
      try {
        const status=await api.mobileCloudStatus();
        if (live) { setAuthenticated(status.authenticated);if (!status.authenticated) setPairing(null); }
      } catch { if(live) { setAuthenticated(false);setPairing(null); } }
      finally { if(live) setChecking(false); }
    };
    void check();
    const timer=setInterval(()=>void check(),15_000);
    return()=>{live=false;clearInterval(timer);};
  },[]);
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  async function create() {
    setBusy(true); setError(null); setPairing(null);
    try {
      const status=await api.mobileCloudStatus();
      setAuthenticated(status.authenticated);
      if (!status.authenticated) throw new Error('Sign in to Centre cloud first.');
      const value = await api.mobilePairing();
      const expiry = Date.parse(value.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 6 * 60_000) throw new Error('Centre Cloud returned an invalid pairing invitation.');
      const link = mobilePairingUrl(value.baseUrl, value.code, import.meta.env.DEV);
      const module = await import('qrcode');
      const qr = await module.toDataURL(link,{width:280,margin:4,errorCorrectionLevel:'M',color:{dark:'#000000',light:'#ffffff'}});
      setNow(Date.now()); setPairing({qr,expiresAt:value.expiresAt,link});
    } catch (failure) {
      const message = errorMessage(failure);
      setError(message === 'Endpoint not found.' ? 'Account pairing is unavailable in this build. Connect Centre Cloud in Connections after the cloud update is installed.' : message);
    }
    finally { setBusy(false); }
  }
  async function copyLink() {
    if (!pairing || Date.parse(pairing.expiresAt)<=Date.now()) return;
    try { await copyText(pairing.link); }
    catch { setError('The pairing link could not be copied. Scan the code instead.'); }
  }
  const expires = pairing ? Math.ceil((Date.parse(pairing.expiresAt)-now)/1000) : 0;
  return <>
    <p>Already have Centre installed on your iPhone? Connect it to your account with a private, one-time code.</p>
    <button type="button" className="button button--small" onClick={() => void create()} disabled={busy || checking || !authenticated}>{busy ? 'Creating code' : 'Connect an installed iPhone app'}</button>
    {!authenticated ? <p className="settings-detail">{checking ? 'Checking your Centre cloud account…' : <button type="button" className="link-button" onClick={onSignIn}>Sign in to Centre cloud first</button>}</p> : null}
    {pairing && expires > 0 ? <div className="mobile-install"><img className="mobile-install__qr" src={pairing.qr} width={280} height={280} alt="Scan with your iPhone camera to connect an installed Centre app. Keep this code private." /><div><p>Scan with your iPhone camera, then tap the link and choose Open Centre.</p><p className="settings-detail">Expires in {Math.ceil(expires/60)} minutes and works once. This connects your account; it does not install the app.</p><div className="form__actions"><button type="button" className="button button--quiet button--small" onClick={() => setPairing(null)}>Hide code</button><button type="button" className="button button--small" onClick={()=>void copyLink()}>Copy link</button></div></div></div> : pairing ? <p className="settings-detail" role="status">This account code has expired. Create a new one.</p> : null}
    {error ? <p className="form__error" role="alert">{error}</p> : null}
  </>;
}

export function MobileSettings({onSignIn}:{onSignIn:()=>void}) {
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
      <div className="settings-section__intro"><h2 id="mobile-install" className="settings-section__title">Download Centre for iPhone</h2><p className="settings-section__description">Read saved resources, practise quizzes and keep your study Log offline. Requires iOS 17 or later.</p></div>
      <div className="settings-section__body">
        {distribution ? <div className="mobile-install">
          {qr ? <img className="mobile-install__qr" src={qr} width={220} height={220} alt="Scan to open Centre's Apple installation invitation" /> : <Smartphone size={40} aria-hidden />}
          <div>
            <ol className="mobile-install__steps">
              {distribution.kind === 'testflight' ? <>
                <li>Install Apple's TestFlight app from the App Store on your iPhone.</li>
                <li>Scan this QR code with your iPhone camera, open the Centre invitation in TestFlight, then tap Accept and Install.</li>
              </> : <li>Scan this QR code with your iPhone camera to open Centre in the App Store, then tap Get or the download button.</li>}
              <li>Open Centre, then connect your account using the steps below.</li>
            </ol>
            <p className="settings-detail">{distribution.kind === 'testflight' ? 'TestFlight places may be full or the build may have expired. Follow the invitation for current availability.' : 'Apple controls availability for your device and region.'}</p>
            <button className="button button--small" type="button" onClick={() => void openExternal(distribution.url).catch(() => setError('The installation link could not open.'))}>{distribution.kind === 'testflight' ? 'Open TestFlight invitation' : 'Open App Store'} <ExternalLink size={12} aria-hidden /></button>
          </div>
        </div> : <div className="mobile-install"><Smartphone size={40} aria-hidden /><div><p>An iPhone release is not available yet.</p><p className="settings-detail">Centre is not available to download from TestFlight or the App Store yet. The download link, installation steps and QR code will appear here when a release is ready.</p><p className="settings-detail">The account code below connects an already installed app. It cannot download or install Centre.</p></div></div>}
        {error ? <p className="form__error" role="alert">{error}</p> : null}
      </div>
    </section>
    <section className="settings-section" aria-labelledby="mobile-account">
      <div className="settings-section__intro"><h2 id="mobile-account" className="settings-section__title">Connect an installed app</h2><p className="settings-section__description">Use this after installing Centre on your iPhone.</p></div>
      <div className="settings-section__body"><AccountPairing onSignIn={onSignIn} /></div>
    </section>
  </div>;
}
