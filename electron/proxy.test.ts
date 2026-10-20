import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { proxyRequest } from './proxy';

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
