import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { googleConnectors, googleScopes, type GoogleConnectorId } from '../shared/connectors';
import { googleTokenSchema } from './connectors';
import { accountSchema } from '../shared/schema';
import type { Store } from './store';
import type { Credentials } from './credentials';
import { HttpError } from './errors';

export class GoogleLogin {
  private listener: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  constructor(private readonly store: Store, private readonly credentials: Pick<Credentials, 'get' | 'set'>, private readonly cloudIdentity?: (idToken:string)=>Promise<unknown>) {}
  async start(connector?: GoogleConnectorId, editable = false, cloud = false) {
    const definition = googleConnectors.find(item => item.id === connector);
    const requestedScopes = connector ? googleScopes(connector, editable) : [];
    const clientId = this.store.state.settings.googleClientId || process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new HttpError(400, 'Google sign-in is not configured in this build. Install the configured Centre desktop app.');
    this.close();
    const generation = this.generation;
    const verifier = randomBytes(48).toString('base64url'); const state = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let used = false;
    const listener = createServer((request, response) => {
      void (async () => {
        response.setHeader('Cache-Control','no-store'); response.setHeader('Content-Type','text/plain; charset=utf-8'); response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method !== 'GET' || url.pathname !== '/oauth/callback') { response.writeHead(404).end('Not found.'); return; }
        const received = url.searchParams.get('state') ?? '';
        if (Buffer.byteLength(received) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received),Buffer.from(state))) { response.writeHead(400).end('Sign-in state did not match. Return to Centre and try again.'); return; }
        if (used) { response.writeHead(409).end('This sign-in link has already been used.'); return; }
        used = true;
        try {
          if (url.searchParams.has('error')) throw new Error('Google sign-in was declined. Return to Centre to try again.');
          const code = url.searchParams.get('code'); if (!code) throw new Error('Google did not return an authorization code.');
          const secret = await this.credentials.get('googleClientSecret');
          if (generation !== this.generation) throw new Error('This Google sign-in was cancelled.');
          const parameters = new URLSearchParams({ code, client_id: clientId, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier, ...(secret ? { client_secret: secret } : {}) });
          const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method:'POST', body: parameters, signal: AbortSignal.timeout(30000) });
          if (!tokenResponse.ok) throw new Error(`Google token exchange failed (${tokenResponse.status}). Check your Desktop OAuth credentials.`);
          const tokenValue:unknown = await tokenResponse.json();
          const token = googleTokenSchema.parse(tokenValue);
          if (definition && (!token.refresh_token || !requestedScopes.every(scope => token.scope?.split(' ').includes(scope)))) throw new Error('Google did not grant all requested permissions or offline access. Reconnect and approve the requested access.');
          if (generation !== this.generation) throw new Error('This Google sign-in was cancelled.');
          const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000) });
          if (!profileResponse.ok) throw new Error(`Google account lookup failed (${profileResponse.status}).`);
          const profile = z.object({ name: z.string().optional(), email: z.email(), email_verified: z.boolean(), picture: z.url().optional() }).parse(await profileResponse.json());
          if (!profile.email_verified) throw new Error('Google has not verified this email address.');
          if (generation !== this.generation) throw new Error('This Google sign-in was cancelled. Return to Centre to start again.');
          if (cloud) {
            if (!this.cloudIdentity) throw new Error('Centre cloud is unavailable.');
            const {id_token} = z.object({id_token:z.string().min(1)}).parse(tokenValue);
            await this.cloudIdentity(id_token);
            if (generation !== this.generation) throw new Error('This cloud sign-in was cancelled.');
          }
          if (definition) {
            await this.credentials.set(`connector-${definition.id}`, JSON.stringify({ ...token, expires_at: Date.now() + token.expires_in * 1000, client_id: clientId }));
            if (generation !== this.generation) { await this.credentials.set(`connector-${definition.id}`, ''); throw new Error('This connection was cancelled.'); }
            this.store.state.settings.connectors = this.store.state.settings.connectors.filter(item => item.id !== definition.id);
            this.store.state.settings.connectors.push({ id: definition.id, connected: true, canEdit: editable, account: profile.email, connectedAt: new Date().toISOString() });
          } else this.store.state.settings.account = accountSchema.parse({ name: profile.name ?? profile.email, email: profile.email, ...(profile.picture ? { picture: profile.picture } : {}) });
          await this.store.save();
          if (generation !== this.generation) throw new Error('This Google sign-in was cancelled.');
          response.writeHead(200).end('You are signed in to Centre. You can close this window and return to the app.');
        } catch (error) { response.writeHead(400).end(error instanceof Error ? error.message : 'Google sign-in failed.'); }
        finally { if (this.listener === listener) this.close(); }
      })().catch(() => { if (!response.writableEnded) response.writeHead(500).end('Google sign-in failed.'); if (this.listener === listener) this.close(); });
    });
    await new Promise<void>((resolve,reject) => { listener.once('error',reject); listener.listen(0,'127.0.0.1',resolve); });
    this.listener = listener;
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Could not start Google sign-in callback.');
    const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    this.timer = setTimeout(() => this.close(), 5 * 60000); this.timer.unref();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type:'code', scope:['openid', 'email', 'profile', ...requestedScopes].join(' '), code_challenge:challenge, code_challenge_method:'S256', state, prompt:definition ? 'consent select_account' : 'select_account', ...(definition ? { access_type:'offline' } : {}) }).toString();
    return { url: url.href };
  }
  async logout() { this.close(); this.store.state.settings.account = null; await this.store.save(); return { ok:true }; }
  close() { this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = null; this.listener?.close(); this.listener = null; }
}
