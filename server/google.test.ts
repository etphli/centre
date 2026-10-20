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
    assert.equal((await originalFetch(await callbackFor())).status,200); assert.equal(store.state.settings.account?.email,'student@example.test');
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
