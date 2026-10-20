import { validateRequest } from './security';

export async function proxyRequest(connection: { port: number; token: string }, method: unknown, path: unknown, body: unknown): Promise<unknown> {
  const apiPath = typeof path === 'string' && path.startsWith('/') && !path.startsWith('/api/') ? `/api${path}` : path;
  const request = validateRequest(method, apiPath, body);
  const response = await fetch(`http://127.0.0.1:${connection.port}${request.path}`, {
    method: request.method,
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    redirect: 'error',
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `Centre request failed (${response.status}).`;
    throw new Error(message);
  }
  return result;
}
