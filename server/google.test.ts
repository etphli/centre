import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { GoogleLogin } from './google';
import { Credentials } from './credentials';
import { Store } from './store';

// Provider HTTP is stubbed because real Google OAuth requires a configured desktop client and browser consent.
// The loopback listener, PKCE, state validation, cancellation and persistence use production code.
test('Google desktop PKCE login persists a real-shaped provider profile and logout defeats an in-flight callback',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-oauth-test-'));
  const store = await Store.open(directory); store.state.settings.googleClientId = 'fixture.apps.googleusercontent.com';
  const login = new GoogleLogin(store,new Credentials(directory));
  const originalFetch = globalThis.fetch; const previousSecret = process.env.GOOGLE_CLIENT_SECRET; process.env.GOOGLE_CLIENT_SECRET = 'fixture-desktop-secret';
  let expectedChallenge = '';
  let delayTokens = false;
  let tokenStarted: (() => void) | undefined;
  let releaseTokens: (() => void) | undefined;
  let profiles = 0;
  globalThis.fetch = async (input,init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.ok(init?.body instanceof URLSearchParams);
      const verifier = init.body.get('code_verifier'); assert.ok(verifier);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'),expectedChallenge);
      assert.equal(init.body.get('client_secret'),'fixture-desktop-secret');
      if (delayTokens) await new Promise<void>(resolve => { releaseTokens = resolve; tokenStarted?.(); });
      return Response.json({ access_token:'fixture-access-token' });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') { profiles++; return Response.json({ name:'Test student',email:'student@example.test',email_verified:true }); }
    return originalFetch(input,init);
  };
  const callbackFor = async () => {
    const authorization = new URL((await login.start()).url); expectedChallenge = authorization.searchParams.get('code_challenge') ?? '';
    const callback = new URL(authorization.searchParams.get('redirect_uri') ?? ''); callback.searchParams.set('state',authorization.searchParams.get('state') ?? ''); callback.searchParams.set('code','fixture-authorization-code'); return callback;
  };
  try {
    const completed = await originalFetch(await callbackFor());
    assert.equal(completed.status,200);
    assert.match(completed.headers.get('content-type') ?? '', /text\/html/);
    const page = await completed.text();
    assert.ok(page.includes('You can go back to Centre.'));
    assert.ok(page.includes('href="centre://action/app.settings"'));
    assert.ok(page.includes('history.replaceState'));
    assert.equal(page.includes('fixture-access-token'), false);
    assert.equal(store.state.settings.account?.email,'student@example.test');
    const saved = await readFile(join(directory,'state.json'),'utf8'); assert.ok(!saved.includes('fixture-access-token')); assert.ok(!saved.includes('fixture-desktop-secret'));
    await login.logout();
    delayTokens = true;
    const started = new Promise<void>(resolve => { tokenStarted = resolve; });
    const response = originalFetch(await callbackFor());
    await started; await login.logout(); releaseTokens?.();
    assert.equal((await response).status,400); assert.equal(store.state.settings.account,null); assert.equal((await Store.open(directory)).state.settings.account,null); assert.equal(profiles,1);
  } finally {
    releaseTokens?.(); login.close(); globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = previousSecret;
    await rm(directory,{ recursive:true,force:true });
  }
});

test('a failed cloud callback shows retry guidance without claiming success or exposing provider details', async t => {
  const directory = await mkdtemp(join(tmpdir(),'centre-oauth-failure-'));
  const store = await Store.open(directory); store.state.settings.googleClientId = 'fixture.apps.googleusercontent.com';
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token:'private-access-token', id_token:'private-id-token' });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({email:'fixture@example.test',email_verified:true});
    return realFetch(input,init);
  });
  const login = new GoogleLogin(store,{get:async()=>'',set:async()=>{}},async()=>{
    throw new TypeError('fetch failed', {cause:new Error('private provider diagnostic')});
  });
  try {
    const authorization = new URL((await login.start(undefined,false,true)).url);
    const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('state',authorization.searchParams.get('state') ?? '');callback.searchParams.set('code','private-authorization-code');
    const response = await realFetch(callback), page = await response.text();
    assert.equal(response.status,400);
    assert.match(response.headers.get('content-type') ?? '',/text\/html/);
    assert.ok(page.includes('Sign-in couldn&#39;t be completed.'));
    assert.ok(page.includes('Back to Centre'));
    for (const secret of ['fetch failed','private-access-token','private-id-token','private-authorization-code','private provider diagnostic']) assert.equal(page.includes(secret),false);
    assert.equal(store.state.settings.account,null);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    const nonce = /script-src 'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    assert.ok(nonce);assert.ok(page.includes(`nonce="${nonce}"`));
  } finally {login.close();await rm(directory,{recursive:true,force:true});}
});
