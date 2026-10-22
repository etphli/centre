import { validateRequest } from './security';
import type { DesktopResponse } from '../shared/desktop-response';

const stateEtags = new WeakMap<object,string>();

export async function proxyRequestForIpc(connection: { port: number; token: string }, method: unknown, path: unknown, body: unknown): Promise<DesktopResponse> {
  try { return { ok: true, value: await proxyRequest(connection, method, path, body) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Centre request failed.' }; }
}

export async function proxyRequest(connection: { port: number; token: string }, method: unknown, path: unknown, body: unknown): Promise<unknown> {
  const apiPath = typeof path === 'string' && path.startsWith('/') && !path.startsWith('/api/') ? `/api${path}` : path;
  const request = validateRequest(method, apiPath, body);
  const polling = request.method === 'GET' && request.path === '/api/state/poll';
  const etag = polling ? stateEtags.get(connection) : undefined;
  const response = await fetch(`http://127.0.0.1:${connection.port}${request.path}`, {
    method: request.method,
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', ...(etag ? { 'if-none-match':etag } : {}) },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    redirect: 'error',
  });
  if (polling && response.status === 304) return null;
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `Centre request failed (${response.status}).`;
    throw new Error(message);
  }
  // Seed the first poll from startup. Later full reads must not consume poll updates.
  if (polling || (request.path === '/api/state' && !stateEtags.has(connection))) {
    const nextEtag = response.headers.get('etag');
    if (nextEtag) stateEtags.set(connection,nextEtag);
    else stateEtags.delete(connection);
  }
  return result;
}
