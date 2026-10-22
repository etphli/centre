import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createService } from './index';
import { Store } from './store';

test('shutdown lets an accepted save finish and delivers its response before closing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-shutdown-'));
  const service = await createService({ dataDir: directory });
  let shutdown: Promise<void> | undefined;
  try {
    const body = JSON.stringify({ nickname: 'Saved during quit' });
    const write = request({ hostname: '127.0.0.1', port: service.port, path: '/api/settings', method: 'PATCH', headers: {
      Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body), Expect: '100-continue',
    } });
    const result = new Promise<number | undefined>((resolve, reject) => {
      write.on('error', reject);
      write.on('response', response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
        response.on('error', reject);
      });
    });
    write.flushHeaders();
    await once(write, 'continue');
    write.write(body.slice(0, 8));
    const close = shutdown = service.close();
    const finishBody = setTimeout(20).then(() => write.end(body.slice(8)));
    const [status] = await Promise.all([result, close, finishBody]);
    assert.equal(status, 200);
    assert.equal((await Store.open(directory)).state.settings.nickname, 'Saved during quit');
  } finally {
    try { await (shutdown ?? service.close()); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
