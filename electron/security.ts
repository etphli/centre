import { z } from 'zod';
import { MAX_SEARCH_QUERY_LENGTH } from '../shared/search';

const routes = [
  ['GET', /^\/api\/state$/],
  ['GET', /^\/api\/state\/poll$/],
  ['GET', /^\/api\/models$/],
  ['GET', /^\/api\/search$/],
  ['GET', /^\/api\/skills$/],
  ['PATCH', /^\/api\/assistant-memories\/[0-9a-f-]{36}$/],
  ['POST', /^\/api\/assistant-memories\/[0-9a-f-]{36}\/forget$/],
  ['GET', /^\/api\/connectors$/],
  ['POST', /^\/api\/connectors\/(google\/start|notion|disconnect|cancel)$/],
  ['POST', /^\/api\/chats$/],
  ['POST', /^\/api\/questions\/[^/]+\/answer$/],
  ['POST', /^\/api\/chats\/[^/]+\/(messages|cancel|archive|restore)$/],
  ['POST', /^\/api\/attachments$/],
  ['GET', /^\/api\/attachments\/[0-9a-f-]{36}$/],
  ['PATCH', /^\/api\/chats\/[^/]+\/(organize|model)$/],
  ['POST', /^\/api\/chat-folders$/],
  ['PATCH', /^\/api\/chat-folders\/[^/]+$/],
  ['POST', /^\/api\/chat-folders\/[^/]+\/remove$/],
  ['POST', /^\/api\/topics$/],
  ['POST', /^\/api\/resources\/generate$/],
  ['PATCH', /^\/api\/resources\/[^/]+\/location$/],
  ['GET', /^\/api\/resources\/[^/]+\/(export|preview)$/],
  ['POST', /^\/api\/resources\/[^/]+\/(feedback|archive|restore|refresh)$/],
  ['POST', /^\/api\/quiz\/grade$/],
  ['POST', /^\/api\/events$/],
  ['PATCH', /^\/api\/events\/[^/]+$/],
  ['POST', /^\/api\/memories\/[^/]+\/resolve$/],
  ['POST', /^\/api\/organato\/(sync|items)$/],
  ['PATCH', /^\/api\/settings$/],
  ['POST', /^\/api\/auth\/(google\/(start|logout)|codex\/start)$/],
] satisfies [string, RegExp][];

export function validateRequest(method: unknown, path: unknown, body: unknown) {
  const request = z.object({
    method: z.enum(['GET', 'POST', 'PATCH']),
    path: z.string().max(MAX_SEARCH_QUERY_LENGTH * 12 + 32).regex(/^\/api\/[A-Za-z0-9_/-]+(?:\?[^#\s]*)?$/),
    body: z.unknown().optional(),
  }).parse({ method, path, body });
  const url = new URL(request.path, 'http://127.0.0.1');
  const search = request.method === 'GET' && url.pathname === '/api/search';
  const validQuery = search
    ? url.searchParams.size === 1 && url.searchParams.has('q') && (url.searchParams.get('q')?.length ?? 0) <= MAX_SEARCH_QUERY_LENGTH
    : !url.search;
  if (!validQuery || request.path.includes('//') || !routes.some(([verb, route]) => verb === request.method && route.test(url.pathname))) {
    throw new Error('This request is not allowed by the desktop app.');
  }
  if (request.method === 'GET' && body !== undefined) throw new Error('GET requests cannot include a body.');
  const serializedLength = JSON.stringify(body ?? null).length;
  const maxLength = request.method === 'POST' && request.path === '/api/attachments' ? 30_000_000 : 2_000_000;
  if (serializedLength > maxLength) throw new Error('This request is too large.');
  return request;
}

export const nativeAttachmentSchema = z.object({
  name:z.string().min(1).max(200).refine(name => !/[\\/\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..','Invalid filename.'),
  mimeType:z.string().max(200),
  data:z.string().min(4).max(28_000_000),
}).strict();

export function validateExternalUrl(value: unknown): string {
  const url = new URL(z.string().max(4096).parse(value));
  const oauthLoopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port !== '' && /^\/(oauth|auth)(\/|$)/.test(url.pathname);
  if (url.username || url.password || (url.protocol !== 'https:' && !oauthLoopback)) {
    throw new Error('Only HTTPS links and local OAuth callbacks can be opened.');
  }
  return url.href;
}

export const saveFileSchema = z.object({
  filename: z.string().min(1).max(200).refine((name) => !/[\\/\x00-\x1f]/.test(name) && name !== '.' && name !== '..', 'Invalid filename'),
  content: z.string().max(20_000_000),
  mimeType: z.string().max(200),
});

export const printPaperSchema = z.object({
  title: z.string().min(1).max(300),
  latex: z.string().min(1).max(2_000_000),
  html: z.string().max(2_000_000).optional(),
});
