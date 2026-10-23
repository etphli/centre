import { mobileDistribution } from '../shared/mobile-distribution';

export function mobilePairingPage(distributionUrl?: string): Response {
  const distribution = mobileDistribution(distributionUrl);
  const nonce = crypto.randomUUID();
  const install = distribution
    ? `<a class="button" href="${distribution.url}" rel="noreferrer">${distribution.kind === 'testflight' ? 'Install with TestFlight' : 'View in the App Store'}</a><p class="detail">Install Centre first, then create a new account code on your Mac. Apple controls availability.</p>`
    : '<p class="notice">The iPhone app isn’t available to install yet.</p><p class="detail">A TestFlight invitation or App Store download will appear in Centre on your Mac when a signed release is ready.</p>';
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>Connect your iPhone · Centre</title>
<style nonce="${nonce}">
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#272725;background:#fafaf9;color-scheme:light dark;--muted:#696965;--line:#dcdcd7;--surface:#f0f0ed;--ink:#272725;--paper:#fafaf9}
*{box-sizing:border-box}body{margin:0;min-height:100svh;padding:56px 24px 32px;display:grid;place-items:center}main{width:100%;max-width:440px}.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600;margin-bottom:48px}.brand svg{width:28px;height:28px}h1{font-size:32px;line-height:1.15;letter-spacing:-.8px;font-weight:600;margin:0 0 18px}p{font-size:16px;line-height:1.55;margin:0 0 16px}.detail{color:var(--muted);font-size:14px}.notice{font-weight:600}section{border-top:1px solid var(--line);padding-top:24px;margin-top:28px}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0 14px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 17px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);font:inherit;font-size:15px;font-weight:500;text-decoration:none;cursor:pointer}.button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}.button:focus-visible{outline:2px solid var(--ink);outline-offset:4px}[hidden]{display:none!important}#feedback{min-height:22px}footer{color:var(--muted);font-size:13px;margin-top:42px;line-height:1.5}@media(prefers-color-scheme:dark){:root{color:#ececea;background:#20201f;--ink:#ececea;--paper:#20201f;--muted:#aaa9a3;--line:#444440;--surface:#30302e}}@media(max-width:380px){body{padding:32px 20px}h1{font-size:28px}.brand{margin-bottom:36px}}
</style></head><body><main>
<div class="brand"><svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7" stroke="currentColor"/><path d="M19 9a7 7 0 1 0 0 10M10 14h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>Centre</div>
<h1 id="heading">Connect your iPhone</h1><p id="intro">This is an account connection code. It connects an installed Centre app to your study data.</p>
<section aria-label="Installation">${install}</section>
<section id="pairing" hidden aria-label="Connect an installed app"><p class="notice">Already have Centre installed?</p><p class="detail">Open the app, then confirm the connection there. Your private code works once and expires five minutes after it was created.</p><div class="actions"><a id="open" class="button primary">Open Centre</a><button id="copy" class="button" type="button">Copy account code</button></div><p id="feedback" class="detail" role="status" aria-live="polite"></p><p class="detail">If Centre doesn’t open, it isn’t installed on this iPhone. This page cannot install the app.</p></section>
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
    heading.textContent='Connect your iPhone';intro.textContent='This is an account connection code. It connects an installed Centre app to your study data.';
    const app=new URL('centre://pair');app.searchParams.set('baseUrl',location.origin);app.searchParams.set('code',code);open.href=app.href;pairing.hidden=false;
  }
  readLink();window.addEventListener('hashchange',readLink);
  document.getElementById('copy').addEventListener('click',async()=>{if(!code)return;try{await navigator.clipboard.writeText(code);feedback.textContent='Account code copied. Paste it in Centre on your iPhone.';}catch{feedback.textContent='Could not copy the code. Open Centre, or scan a new code from your Mac.';}});
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
