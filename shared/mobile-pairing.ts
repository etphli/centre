/** The fragment keeps the one-time secret out of HTTP requests and access logs. */
export function mobilePairingUrl(baseUrl: string, code: string, allowLoopback = false): string {
  const base = new URL(baseUrl);
  const loopback = allowLoopback && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((!loopback && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname) || !/^[A-Za-z0-9_-]{32,200}$/.test(code)) {
    throw new Error('Centre Cloud returned an invalid pairing invitation.');
  }
  const url = new URL('/pair', base);
  url.hash = new URLSearchParams({ code }).toString();
  return url.href;
}
