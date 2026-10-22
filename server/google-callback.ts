import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

type CallbackResult = { kind: 'success' } | { kind: 'error'; message: string };

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

export function sendGoogleCallback(response: ServerResponse, status: number, result: CallbackResult) {
  const nonce = randomBytes(18).toString('base64url');
  const title = result.kind === 'success' ? 'You can go back to Centre.' : "Sign-in couldn't be completed.";
  const message = result.kind === 'success' ? "You're signed in. Your account is ready in the app." : result.message;
  const symbol = result.kind === 'success' ? '<path d="m6 12 4 4 8-8" />' : '<path d="M12 6v7m0 4h.01" />';
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} | Centre</title><link rel="icon" href="data:,">
<style nonce="${nonce}">
:root{color-scheme:light dark;--page:#f9f9f7;--ink:#292927;--muted:#686863;--line:#deded9;--button:#292927;--button-ink:#f9f9f7}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100svh;display:flex;flex-direction:column}
header{padding:32px clamp(24px,5vw,64px);font-size:19px;font-weight:600;letter-spacing:-.5px}
main{width:min(100%,508px);padding:40px 32px 80px;margin:auto;transform:translateY(-24px)}
.status{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--line);border-radius:50%;margin-bottom:28px}.status svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:clamp(28px,4vw,36px);line-height:1.18;font-weight:550;letter-spacing:-1px;margin:0 0 18px;max-width:15ch}p{color:var(--muted);margin:0;max-width:42ch;overflow-wrap:anywhere}
a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 19px;margin-top:32px;border-radius:8px;background:var(--button);color:var(--button-ink);text-decoration:none;font-size:14px;font-weight:550}a:hover{opacity:.88}a:focus-visible{outline:2px solid var(--ink);outline-offset:5px}.note{font-size:13px;margin-top:18px}
@media(prefers-color-scheme:dark){:root{--page:#1b1b1a;--ink:#ecebe7;--muted:#adaca6;--line:#393937;--button:#ecebe7;--button-ink:#1b1b1a}}
@media(max-width:420px){header{padding:24px}main{padding:32px 24px 56px;transform:none}}
</style><script nonce="${nonce}">history.replaceState(null, '', '/oauth/callback');</script></head>
<body><header>Centre</header><main><div class="status" aria-hidden="true"><svg viewBox="0 0 24 24">${symbol}</svg></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="centre://action/app.settings">Back to Centre</a><p class="note">You can close this tab.</p></main></body></html>`);
}
