export interface MobileAssets { fetch(request: Request): Promise<Response> }

export async function serveMobileAsset(request: Request, assets?: MobileAssets): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/iphone') return Response.redirect(url.origin + '/iphone/', 308);
  if (!url.pathname.startsWith('/iphone/')) return null;
  if (!['GET','HEAD'].includes(request.method)) return new Response('Use GET or HEAD.',{status:405,headers:{Allow:'GET, HEAD'}});
  if (!assets) return new Response('Centre for iPhone is temporarily unavailable.',{status:503,headers:{'Cache-Control':'no-store'}});
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  headers.set('Referrer-Policy','no-referrer');
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('X-Frame-Options','DENY');
  headers.set('Service-Worker-Allowed','/iphone/');
  if (!url.pathname.includes('/assets/')) headers.set('Cache-Control','no-cache');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
