import { editConnectedFileSchema } from '../shared/connected-files';
import { z } from 'zod';
import { connectorCatalog, connectorReadSchema, type ConnectorId, type ConnectorRead } from '../shared/connectors';
import type { Store } from './store';
import type { Credentials } from './credentials';
import { HttpError } from './errors';

export const googleTokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive().default(3600), scope: z.string().optional() });
const storedTokenSchema = googleTokenSchema.extend({ expires_at: z.number(), client_id: z.string().min(1), refresh_token: z.string().min(1) });
const notionHeaders = { 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' };
const maxResponseBytes = 2 * 1024 * 1024;

async function remoteJson(url: URL | string, token: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    await response.body?.cancel();
    const reason = response.status === 401 ? 'Reconnect this service in Settings.' : response.status === 403 ? 'Check the granted permissions and that this API is enabled for your account.' : response.status === 429 ? 'The service is busy. Try again shortly.' : 'Try again later.';
    throw new HttpError(response.status === 401 || response.status === 403 ? response.status : 502, `Connector request failed (${response.status}). ${reason}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, 'The connector returned an empty response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) throw new HttpError(413, 'Connector content is too large. Select a smaller resource.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(502, 'The connector returned invalid JSON.'); }
}

function endpoint(origin: string, path: string, parameters: Record<string, string | undefined> = {}) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
  return url;
}
const segment = (value: string) => {
  if (!value || value === '.' || value === '..') throw new HttpError(400, 'Choose a valid resource ID.');
  return encodeURIComponent(value);
};

export function googleReadRequest(input: ConnectorRead): { url: URL; init?: RequestInit } {
  const { connector, action, query, resourceId, cursor } = input;
  if (action === 'read' && !resourceId) throw new HttpError(400, 'A resource ID is required to read content.');
  const id = segment(resourceId ?? 'unused');
  const list = action === 'list';
  const page = { pageSize: '25', pageToken: cursor };
  switch (connector) {
    case 'google-drive': case 'google-docs': case 'google-sheets': case 'google-slides': case 'google-forms': {
      if (!list) {
        switch (connector) {
          case 'google-docs': return { url: endpoint('https://docs.googleapis.com', `/v1/documents/${id}`, {includeTabsContent:'true'}) };
          case 'google-sheets': return { url: endpoint('https://sheets.googleapis.com', `/v4/spreadsheets/${id}`, { includeGridData: 'true', ranges: query || 'A1:Z100' }) };
          case 'google-slides': return { url: endpoint('https://slides.googleapis.com', `/v1/presentations/${id}`) };
          case 'google-forms': return { url: endpoint('https://forms.googleapis.com', `/v1/forms/${id}`) };
          default: return { url: endpoint('https://www.googleapis.com', `/drive/v3/files/${id}`, { fields: 'id,name,mimeType,description,webViewLink,modifiedTime,size' }) };
        }
      }
      const mime = { 'google-drive': '', 'google-docs': 'document', 'google-sheets': 'spreadsheet', 'google-slides': 'presentation', 'google-forms': 'form' }[connector];
      const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const q = ['trashed = false', ...(mime ? [`mimeType = 'application/vnd.google-apps.${mime}'`] : []), ...(query ? [`name contains '${escaped}'`] : [])].join(' and ');
      return { url: endpoint('https://www.googleapis.com', '/drive/v3/files', { ...page, q, fields: 'nextPageToken,files(id,name,mimeType,webViewLink)' }) };
    }
    case 'google-calendar': return { url: list ? endpoint('https://www.googleapis.com', '/calendar/v3/users/me/calendarList', { maxResults: '25', pageToken: cursor }) : endpoint('https://www.googleapis.com', `/calendar/v3/calendars/${id}/events`, { maxResults: '25', pageToken: cursor, q: query, singleEvents: 'true', orderBy: 'startTime', timeMin: new Date().toISOString() }) };
    case 'google-contacts': return { url: list ? query ? endpoint('https://people.googleapis.com', '/v1/people:searchContacts', { query, readMask: 'names,emailAddresses,organizations', pageSize: '25' }) : endpoint('https://people.googleapis.com', '/v1/people/me/connections', { ...page, personFields: 'names,emailAddresses,organizations' }) : endpoint('https://people.googleapis.com', `/v1/people/${segment((resourceId ?? '').replace(/^people\//, ''))}`, { personFields: 'names,emailAddresses,organizations' }) };
    case 'google-tasks': return { url: list ? endpoint('https://tasks.googleapis.com', '/tasks/v1/users/@me/lists', { maxResults: '25', pageToken: cursor }) : endpoint('https://tasks.googleapis.com', `/tasks/v1/lists/${id}/tasks`, { maxResults: '25', pageToken: cursor }) };
    case 'google-classroom': return { url: list ? endpoint('https://classroom.googleapis.com', '/v1/courses', page) : endpoint('https://classroom.googleapis.com', `/v1/courses/${id}/${query === 'materials' ? 'courseWorkMaterials' : 'courseWork'}`, page) };
    case 'google-meet': return { url: endpoint('https://meet.googleapis.com', list ? '/v2/conferenceRecords' : `/v2/conferenceRecords/${segment((resourceId ?? '').replace(/^conferenceRecords\//, ''))}`, list ? page : {}) };
    case 'google-chat': return { url: list ? endpoint('https://chat.googleapis.com', '/v1/spaces', page) : endpoint('https://chat.googleapis.com', `/v1/spaces/${segment((resourceId ?? '').replace(/^spaces\//, ''))}/messages`, page) };
    case 'google-youtube': return { url: list ? query ? endpoint('https://www.googleapis.com', '/youtube/v3/search', { part: 'snippet', q: query, type: 'video', maxResults: '25', pageToken: cursor }) : endpoint('https://www.googleapis.com', '/youtube/v3/subscriptions', { part: 'snippet', mine: 'true', maxResults: '25', pageToken: cursor }) : endpoint('https://www.googleapis.com', '/youtube/v3/videos', { part: 'snippet,contentDetails,statistics', id: resourceId }) };
    case 'google-analytics': return list ? { url: endpoint('https://analyticsadmin.googleapis.com', '/v1beta/accountSummaries', page) } : { url: endpoint('https://analyticsdata.googleapis.com', `/v1beta/properties/${segment((resourceId ?? '').replace(/^properties\//, ''))}:runReport`), init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }], limit: '100' }) } };
    case 'google-search-console': {
      const end = new Date(); end.setUTCDate(end.getUTCDate() - 3); const start = new Date(end); start.setUTCDate(start.getUTCDate() - 27);
      return list ? { url: endpoint('https://www.googleapis.com', '/webmasters/v3/sites') } : { url: endpoint('https://www.googleapis.com', `/webmasters/v3/sites/${id}/searchAnalytics/query`), init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), dimensions: ['query'], rowLimit: 25 }) } };
    }
    case 'notion': throw new HttpError(400, 'Use the Notion reader.');
  }
}

export class Connectors {
  private readonly refreshing = new Map<ConnectorId, Promise<string>>();
  private readonly generations = new Map<ConnectorId, number>();
  constructor(private readonly store: Store, private readonly credentials: Pick<Credentials, 'get' | 'set'>) {}
  status() {
    return { connectors: connectorCatalog.map(item => this.store.state.settings.connectors.find(saved => saved.id === item.id) ?? { id: item.id, connected: false, canEdit: false, account: null, connectedAt: null }), googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID || this.store.state.settings.googleClientId) };
  }
  async connectNotion(token: string) {
    const profile = z.object({ bot: z.object({ workspace_name: z.string().nullable().optional() }).optional() }).parse(await remoteJson('https://api.notion.com/v1/users/me', token, { headers: notionHeaders }));
    await this.credentials.set('connector-notion', token);
    this.store.state.settings.connectors = this.store.state.settings.connectors.filter(item => item.id !== 'notion');
    this.store.state.settings.connectors.push({ id: 'notion', connected: true, canEdit: false, account: profile.bot?.workspace_name ?? 'Notion workspace', connectedAt: new Date().toISOString() });
    await this.store.save(); return { ok: true };
  }
  async disconnect(id: ConnectorId) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    await this.refreshing.get(id)?.catch(() => undefined);
    await this.credentials.set(`connector-${id}`, '');
    this.store.state.settings.connectors = this.store.state.settings.connectors.filter(item => item.id !== id);
    await this.store.save(); return { ok: true };
  }
  private async accessToken(id: ConnectorId): Promise<string> {
    const raw = await this.credentials.get(`connector-${id}`);
    if (!raw) throw new HttpError(401, 'Reconnect this service in Settings.');
    if (id === 'notion') return raw;
    const stored = storedTokenSchema.parse(JSON.parse(raw));
    if (stored.expires_at > Date.now() + 60000) return stored.access_token;
    const existing = this.refreshing.get(id); if (existing) return existing;
    const generation = this.generations.get(id) ?? 0;
    const refresh = (async () => {
      const secret = await this.credentials.get('googleClientSecret');
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: stored.client_id, refresh_token: stored.refresh_token, grant_type: 'refresh_token', ...(secret ? { client_secret: secret } : {}) }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new HttpError(401, 'Google access expired. Reconnect this service in Settings.');
      const token = googleTokenSchema.parse(await response.json());
      if ((this.generations.get(id) ?? 0) !== generation) throw new HttpError(401, 'This service was disconnected.');
      await this.credentials.set(`connector-${id}`, JSON.stringify({ ...stored, ...token, expires_at: Date.now() + token.expires_in * 1000 }));
      return token.access_token;
    })();
    this.refreshing.set(id, refresh);
    try { return await refresh; } finally { this.refreshing.delete(id); }
  }
  async edit(value: unknown): Promise<unknown> {
    const input = editConnectedFileSchema.parse(value);
    if (!this.status().connectors.some(item => item.id === input.connector && item.connected && item.canEdit)) throw new HttpError(403, 'Enable editing for this service in Settings first.');
    const token = await this.accessToken(input.connector);
    const id = segment(input.fileId);
    const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    switch (input.connector) {
      case 'google-docs': return remoteJson(`https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, token, json({ writeControl: { requiredRevisionId: input.revision }, requests: [{ replaceAllText: { containsText: { text: input.find, matchCase: true }, replaceText: input.replacement } }] }));
      case 'google-slides': return remoteJson(`https://slides.googleapis.com/v1/presentations/${id}:batchUpdate`, token, json({ writeControl: { requiredRevisionId: input.revision }, requests: [{ replaceAllText: { containsText: { text: input.find, matchCase: true }, replaceText: input.replacement } }] }));
      case 'google-sheets': return remoteJson(endpoint('https://sheets.googleapis.com', `/v4/spreadsheets/${id}/values/${segment(input.range)}`, { valueInputOption: input.valueInputOption }), token, json({ range: input.range, majorDimension: 'ROWS', values: input.values }, 'PUT'));
    }
  }
  async read(value: unknown): Promise<{ source: string; untrustedContent: unknown }> {
    const input = connectorReadSchema.parse(value);
    if (!this.status().connectors.some(item => item.id === input.connector && item.connected)) throw new HttpError(400, 'Connect this service in Settings first.');
    const token = await this.accessToken(input.connector);
    let result: unknown;
    if (input.connector === 'notion') {
      if (input.action === 'list') result = await remoteJson('https://api.notion.com/v1/search', token, { method: 'POST', headers: notionHeaders, body: JSON.stringify({ query: input.query, page_size: 25, ...(input.cursor ? { start_cursor: input.cursor } : {}) }) });
      else {
        if (!input.resourceId) throw new HttpError(400, 'A page or block ID is required.');
        const id = segment(input.resourceId);
        result = await remoteJson(endpoint('https://api.notion.com', `/v1/blocks/${id}/children`, { page_size: '50', start_cursor: input.cursor }), token, { headers: notionHeaders });
      }
    } else {
      const { url, init } = googleReadRequest(input); result = await remoteJson(url, token, init);
    }
    return { source: input.connector, untrustedContent: result };
  }
}
