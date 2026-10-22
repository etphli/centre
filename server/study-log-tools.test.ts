import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createService } from './index';
import { chatSchema } from '../shared/schema';
import { studyLogSchema } from '../shared/study-log';

// Only model reasoning is substituted; the real protocol, tool, HTTP and disk run.
test('AI Log tools save through active chats, persist across restart and enforce actual-time boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-ai-study-'));
  const originalBin = process.env.CENTRE_CODEX_BIN, originalInput = process.env.CENTRE_STUDY_TOOL_INPUT;
  process.env.CENTRE_CODEX_BIN = fileURLToPath(new URL('./fixtures/study-log-codex.mjs', import.meta.url));
  const configPath = join(directory, 'tool-input.json'); process.env.CENTRE_STUDY_TOOL_INPUT = configPath;
  let service = await createService({ dataDir: directory });
  const input = { id: randomUUID(), confirmedByUser: true, title: 'Paper algebra', notes: 'Away from the computer', subjectId: null, taskId: null, timeZone: 'Australia/Sydney', segments: [{ start: '2026-01-19T23:30', end: '2026-01-20T01:00' }] };
  const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${service.port}/api${path}`, { method, headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: unknown = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const disk = async () => studyLogSchema.parse(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).studyLog);
  try {
    const chat = chatSchema.parse(await request('/chats', 'POST', {}));
    const run = async (configuration: unknown) => {
      await writeFile(configPath, JSON.stringify(configuration));
      return chatSchema.parse(await request(`/chats/${chat.id}/messages`, 'POST', { content: 'Log my paper algebra study from 19 Jan 2026 at 11:30 pm to 20 Jan at 1 am in Sydney.', context: { page: 'chat' } }));
    };
    const saved = await run({ input });
    assert.match(saved.messages.at(-1)?.content ?? '', /Logged completed/);
    assert.ok(saved.messages.at(-1)?.activity.some(item => item.text === 'Logging completed study' && item.state === 'done'));
    let log = await disk(); assert.equal(log.sessions.length, 1);
    assert.equal(log.sessions[0].source, 'manual'); assert.equal(log.sessions[0].state.kind, 'completed');
    assert.deepEqual(log.sessions[0].segments, [{ start: '2026-01-19T12:30:00.000Z', end: '2026-01-19T14:00:00.000Z' }]);
    const definition = JSON.parse(await readFile(configPath + '.thread', 'utf8'));
    assert.ok(definition.dynamicTools.some((tool: { name: string }) => tool.name === 'centre_log_study'));
    assert.ok(definition.dynamicTools.some((tool: { name: string }) => tool.name === 'centre_get_study_log'));
    assert.match(definition.developerInstructions, /never invent an interval from a duration alone/);
    await run({ input }); assert.equal((await disk()).sessions.length, 1, 'exact retry is idempotent');
    const baseline = JSON.stringify((await disk()).sessions);
    for (const invalid of [
      { ...input, confirmedByUser: false },
      { ...input, confirmedByUser: undefined },
      { ...input, id: randomUUID() }, // Overlap, different UUID.
      { ...input, id: randomUUID(), subjectId: 'unknown-subject' },
      { ...input, id: randomUUID(), state: { kind: 'running' } },
      { ...input, id: randomUUID(), segments: [{ start: '2099-01-01T12:00', end: '2099-01-01T13:00' }] },
      { ...input, id: randomUUID(), segments: [{ start: '2026-04-05T02:15', end: '2026-04-05T03:15' }] },
      { ...input, id: randomUUID(), segments: [{ start: '2026-10-04T02:15', end: '2026-10-04T03:15' }] },
      { ...input, id: randomUUID(), segments: [{ start: '2026-01-19T12:00Z', end: '2026-01-19T13:00Z' }] },
    ]) {
      assert.match((await run({ input: invalid })).messages.at(-1)?.content ?? '', /not saved/);
      assert.equal(JSON.stringify((await disk()).sessions), baseline);
    }
    assert.match((await run({ input: { ...input, id: randomUUID() }, inactive: true })).messages.at(-1)?.content ?? '', /not saved/);
    assert.equal(JSON.stringify((await disk()).sessions), baseline);
    await service.close(); service = await createService({ dataDir: directory });
    await run({ readOnly: true });
    const results = (await readFile(configPath + '.results', 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const lastRead = results.at(-1);
    log = studyLogSchema.parse(JSON.parse(lastRead.result.contentItems[0].text));
    assert.equal(log.sessions[0].id, input.id); assert.equal(log.sessions.length, 1);
  } finally {
    await service.close();
    if (originalBin === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = originalBin;
    if (originalInput === undefined) delete process.env.CENTRE_STUDY_TOOL_INPUT; else process.env.CENTRE_STUDY_TOOL_INPUT = originalInput;
    await rm(directory, { recursive: true, force: true });
  }
});
