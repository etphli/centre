import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { proxyRequest, proxyRequestForIpc } from './proxy';
import { unwrapDesktopResponse } from '../shared/desktop-response';

test('desktop polling sends validators, skips unchanged payloads, and isolates connections', async () => {
  let version = 1;
  const server = createServer((request,response) => {
    assert.equal(request.headers.authorization,'Bearer poll-token');
    const etag = `"state-${version}"`;
    response.setHeader('etag',etag);
    if (request.url === '/api/state/poll' && request.headers['if-none-match'] === etag) response.writeHead(304).end();
    else response.end(JSON.stringify({ version }));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = { port:address.port,token:'poll-token' };
  try {
    assert.deepEqual(await proxyRequest(connection,'GET','/state',undefined),{ version:1 });
    assert.equal(await proxyRequest(connection,'GET','/state/poll',undefined),null);
    version = 2;
    // An independent full read must not consume an update meant for the poller.
    assert.deepEqual(await proxyRequest(connection,'GET','/state',undefined),{ version:2 });
    assert.deepEqual(await proxyRequest(connection,'GET','/state/poll',undefined),{ version:2 });
    assert.equal(await proxyRequest(connection,'GET','/state/poll',undefined),null);
    assert.deepEqual(await proxyRequest({ ...connection },'GET','/state/poll',undefined),{ version:2 });
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('desktop proxy adds its private token and blocks redirects and forbidden routes', async () => {
  let requests = 0;
  let redirectTargetRequests = 0;
  let body = '';
  const server = createServer(async (request, response) => {
    requests += 1;
    assert.equal(request.headers.authorization, 'Bearer private-service-token');
    if (request.url === '/api/topics') {
      response.writeHead(302, { location: '/redirect-target' });
      response.end();
    } else if (request.url === '/redirect-target') {
      redirectTargetRequests += 1;
      response.end('{}');
    } else if (request.url === '/api/chats') {
      for await (const chunk of request) body += chunk.toString();
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'A turn is already running.' }));
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ working: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = { port: address.port, token: 'private-service-token' };
  try {
    assert.deepEqual(await proxyRequest(connection, 'GET', '/state', undefined), { working: true });
    assert.deepEqual(await proxyRequest(connection, 'GET', '/api/state', undefined), { working: true });
    await assert.rejects(proxyRequest(connection, 'POST', '/chats', { title: 'Study' }), /A turn is already running/);
    assert.equal(body, JSON.stringify({ title: 'Study' }));
    assert.deepEqual(unwrapDesktopResponse(await proxyRequestForIpc(connection, 'GET', '/state', undefined)), { working: true });
    const failure = await proxyRequestForIpc(connection, 'POST', '/chats', { title: 'Study' });
    assert.deepEqual(failure, { ok: false, error: 'A turn is already running.' });
    assert.throws(() => unwrapDesktopResponse(failure), /A turn is already running/);
    assert.throws(() => unwrapDesktopResponse({ ok: true, error: 'Forged result' }));
    await assert.rejects(proxyRequest(connection, 'POST', '/topics', {}), /fetch failed/);
    assert.equal(redirectTargetRequests, 0);
    const accepted = requests;
    await assert.rejects(proxyRequest(connection, 'GET', 'https://example.com/api/state', undefined));
    await assert.rejects(proxyRequest(connection, 'GET', '/state?url=https://example.com', undefined));
    await assert.rejects(proxyRequest(connection, 'DELETE', '/state', undefined));
    assert.equal(requests, accepted);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
