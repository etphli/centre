import { mobileDistribution } from '../shared/mobile-distribution';

export function mobilePairingPage(distributionUrl?: string): Response {
  const distribution = mobileDistribution(distributionUrl);
  const nonce = crypto.randomUUID();
  const nativeInstall = distribution
    ? `<a class="button" href="${distribution.url}" rel="noreferrer">${distribution.kind === 'testflight' ? 'Install with TestFlight' : 'View in the App Store'}</a><p class="detail">Install Centre first, then create a new account code on your Mac. Apple controls availability.</p>`
    : '<p class="notice">A native iPhone release isn’t available yet.</p><p class="detail">A TestFlight invitation or App Store download will appear in Centre on your Mac when a signed release is ready.</p>';
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>Connect your iPhone · Centre</title>
<style nonce="${nonce}">
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#272725;background:#fafaf9;color-scheme:light dark;--muted:#696965;--line:#dcdcd7;--surface:#f0f0ed;--ink:#272725;--paper:#fafaf9}
*{box-sizing:border-box}body{margin:0;min-height:100svh;padding:56px 24px 32px;display:grid;place-items:center}main{width:100%;max-width:440px}.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600;margin-bottom:48px}.brand svg{width:28px;height:28px}h1{font-size:32px;line-height:1.15;letter-spacing:-.8px;font-weight:600;margin:0 0 18px}p{font-size:16px;line-height:1.55;margin:0 0 16px}.detail{color:var(--muted);font-size:14px}.notice{font-weight:600}section{border-top:1px solid var(--line);padding-top:24px;margin-top:28px}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0 14px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 17px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);font:inherit;font-size:15px;font-weight:500;text-decoration:none;cursor:pointer}.button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}.button:focus-visible{outline:2px solid var(--ink);outline-offset:4px}[hidden]{display:none!important}#feedback{min-height:22px}footer{color:var(--muted);font-size:13px;margin-top:42px;line-height:1.5}@media(prefers-color-scheme:dark){:root{color:#ececea;background:#20201f;--ink:#ececea;--paper:#20201f;--muted:#aaa9a3;--line:#444440;--surface:#30302e}}@media(max-width:380px){body{padding:32px 20px}h1{font-size:28px}.brand{margin-bottom:36px}}
</style></head><body><main>
<div class="brand"><svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7" stroke="currentColor"/><path d="M19 9a7 7 0 1 0 0 10M10 14h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>Centre</div>
<h1 id="heading">Connect your iPhone</h1><p id="intro">This is an account connection code. Copy it into Centre on your iPhone Home Screen to connect your study data.</p>
<section aria-label="Installation"><a class="button primary" href="/iphone/" rel="noreferrer">Install Centre for iPhone</a><p class="detail">In Safari, choose Share → Add to Home Screen. Open Centre from its new icon, then paste your account code there. Install before connecting: Safari and the Home Screen app can keep separate account storage.</p>${nativeInstall}</section>
<section id="pairing" hidden aria-label="Connect an installed app"><p class="notice">Connect the Home Screen app</p><p class="detail">Copy your account code, open Centre from your iPhone Home Screen and paste it into Connect your account. It works once and expires five minutes after it was created.</p><div class="actions"><button id="copy" class="button primary" type="button">Copy account code</button><a id="open" class="button">Open native Centre</a></div><p id="feedback" class="detail" role="status" aria-live="polite"></p><p class="detail">Use Open native Centre only if you already have the native app installed. For the web app, use the Centre icon on your Home Screen.</p></section>
<noscript><p>Enable JavaScript to use this private account link, or create a new code in Centre on your Mac.</p></noscript>
<footer>You can go back to Centre on your Mac.<br>Keep this code private. No account connection happens until you confirm it in the iPhone app.</footer>
</main><script nonce="${nonce}">
(()=>{
  let code=null;
  const heading=document.getElementById('heading'),intro=document.getElementById('intro'),open=document.getElementById('open'),pairing=document.getElementById('pairing'),feedback=document.getElementById('feedback');
  function readLink(){
    const fragment=location.hash.slice(1);
    history.replaceState(null,'',location.pathname);
    const match=/^code=([A-Za-z0-9_-]{32,200})$/.exec(fragment);
    code=match?match[1]:null;
    feedback.textContent='';open.removeAttribute('href');pairing.hidden=true;
    if(!code){heading.textContent='Create a fresh account code';intro.textContent='In Centre on your Mac, open Settings → iPhone and choose “Connect an installed iPhone app”. Then scan the new code with your iPhone camera.';return;}
    heading.textContent='Connect your iPhone';intro.textContent='This is an account connection code. Copy it into Centre on your iPhone Home Screen to connect your study data.';
    const app=new URL('centre://pair');app.searchParams.set('baseUrl',location.origin);app.searchParams.set('code',code);open.href=app.href;pairing.hidden=false;
  }
  readLink();window.addEventListener('hashchange',readLink);
  document.getElementById('copy').addEventListener('click',async()=>{if(!code)return;try{await navigator.clipboard.writeText(code);feedback.textContent='Account code copied. Paste it in Centre on your iPhone.';}catch{feedback.textContent='Copy the code below into Centre on your Home Screen.';const field=document.createElement('input');field.readOnly=true;field.value=code;field.setAttribute('aria-label','Private one-time account code');feedback.replaceChildren(document.createTextNode('Copy this private code: '),field);field.select();}});
})();
</script></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'none'`,
    },
  });
}
