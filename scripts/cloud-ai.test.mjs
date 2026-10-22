import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AI_MODEL, handleAiRequest } from "../cloud-ai/index.ts";
import { LocalD1 } from "./test-support/sqlite-d1.mjs";

const migration = readFileSync(new URL("../cloud-ai/migrations/0001_centre_ai.sql", import.meta.url), "utf8");
const fixtureLabel = "TEST FIXTURE — local stub, not hosted Workers AI";

function record(kind, id, data, deleted = false) {
  return { kind, id, schemaVersion: 1, version: 1, cursor: "1", updatedAt: "2026-01-01T00:00:00.000Z", deleted, data };
}

function makeContext({ db = new LocalD1(), workspaceId = "workspace-a", ai, putBehavior } = {}) {
  db.sqlite.exec(migration);
  const records = new Map();
  const mutations = new Map();
  const putCalls = [];
  const chatId = `chat-${workspaceId}`;
  const messageId = `message-${workspaceId}`;
  records.set(`${workspaceId}:chat:${chatId}`, record("chat", chatId, {
    id: chatId, title: "Study chat", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  records.set(`${workspaceId}:message:${messageId}`, record("message", messageId, {
    id: messageId, chatId, role: "user", content: "Explain cellular respiration.",
    createdAt: "2026-01-01T00:00:00.000Z", responseDurationMs: null, resourceIds: [], attachmentIds: [],
    requestContext: { page: "chat", topicId: "biology" },
  }));

  const context = {
    env: { DB: db, ...(ai === undefined ? {} : { AI: ai }) },
    auth: { workspaceId, deviceId: `device-${workspaceId}` },
    entities: {
      async get(kind, id) {
        return records.get(`${workspaceId}:${kind}:${id}`) ?? null;
      },
      async put(mutation) {
        putCalls.push(structuredClone(mutation));
        const previous = mutations.get(mutation.mutationId);
        if (previous) return previous;
        const written = record(mutation.kind, mutation.id, structuredClone(mutation.data));
        records.set(`${workspaceId}:${mutation.kind}:${mutation.id}`, written);
        mutations.set(mutation.mutationId, written);
        if (putBehavior) await putBehavior({ mutation, record: written, call: putCalls.length });
        return written;
      },
    },
  };
  return { context, db, records, mutations, putCalls, chatId, messageId };
}

class FailOnceResultWriteD1 extends LocalD1 {
  constructor() {
    super();
    this.failResultWrite = true;
  }

  prepare(query) {
    const statement = super.prepare(query);
    if (!query.includes("SET result_text=?")) return statement;
    const wrapper = {
      bind(...values) { statement.bind(...values); return wrapper; },
      first() { return statement.first(); },
      async run() {
        if (this.owner.failResultWrite) {
          this.owner.failResultWrite = false;
          throw new Error("simulated D1 reply failure");
        }
        return statement.run();
      },
      owner: this,
    };
    return wrapper;
  }
}

function postRequest({ id = randomUUID(), chatId, messageId, body } = {}) {
  const payload = body ?? { id, chatId, messageId };
  return new Request("https://centre.test/v1/ai/runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

function getRequest(id) {
  return new Request(`https://centre.test/v1/ai/runs/${id}`);
}

async function responseJson(response) {
  return response.json();
}

test(`${fixtureLabel}: successful run persists exact result and stable assistant mutation`, async () => {
  const calls = [];
  const ai = { async run(model, input) { calls.push({ model, input }); return { response: "Mitochondria release usable energy from glucose through cellular respiration." }; } };
  const { context, db, chatId, messageId, putCalls, records } = makeContext({ ai });
  const id = randomUUID();
  const response = await handleAiRequest(postRequest({ id, chatId, messageId }), context);
  assert.equal(response.status, 200);
  const { run } = await responseJson(response);
  assert.equal(run.status, "completed");
  assert.equal(run.result, "Mitochondria release usable energy from glucose through cellular respiration.");
  assert.equal(run.provider, "cloudflare-ai");
  assert.equal(run.model, AI_MODEL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, AI_MODEL);
  assert.deepEqual(calls[0].input.messages.map((message) => message.role), ["system", "user"]);
  assert.equal(calls[0].input.messages[1].content, "Explain cellular respiration.");
  assert.equal(calls[0].input.max_tokens, 1024);
  assert.equal(calls[0].input.stream, false);
  assert.equal(putCalls.length, 1);
  assert.deepEqual(Object.keys(putCalls[0].data).sort(), [
    "attachmentIds", "chatId", "content", "createdAt", "id", "requestContext", "resourceIds", "responseDurationMs", "role",
  ]);
  assert.deepEqual(putCalls[0].data.requestContext, { page: "chat", topicId: "biology" });
  assert.equal(putCalls[0].data.role, "assistant");
  assert.equal(putCalls[0].data.chatId, chatId);
  assert.equal(records.get(`workspace-a:message:${run.assistantMessageId}`).data.content, run.result);
  assert.equal((await responseJson(await handleAiRequest(postRequest({ id, chatId, messageId }), context))).run.status, "completed");
  assert.equal(calls.length, 1, "exact replay must not call the provider again");
  assert.equal(putCalls.length, 1, "completed replay must not write another assistant message");
  db.close();
});

test("changed identity conflicts and another workspace cannot read a run", async () => {
  const ai = { async run() { return { response: "Answer." }; } };
  const first = makeContext({ ai });
  const id = randomUUID();
  await handleAiRequest(postRequest({ id, chatId: first.chatId, messageId: first.messageId }), first.context);
  const mismatch = await handleAiRequest(postRequest({ id, chatId: first.chatId, messageId: "another-message" }), first.context);
  assert.equal(mismatch.status, 409);

  const other = makeContext({ db: first.db, workspaceId: "workspace-b", ai });
  const hidden = await handleAiRequest(getRequest(id), other.context);
  assert.equal(hidden.status, 404);
  first.db.close();
});

test("request validation and missing bindings fail before provider use", async () => {
  const ai = { async run() { assert.fail("provider must not be called"); } };
  const fixture = makeContext({ ai });
  const invalid = await handleAiRequest(postRequest({ body: { id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId, model: "untrusted" } }), fixture.context);
  assert.equal(invalid.status, 400);
  const missingAi = makeContext();
  const unconfigured = await handleAiRequest(postRequest({ id: randomUUID(), chatId: missingAi.chatId, messageId: missingAi.messageId }), missingAi.context);
  assert.equal(unconfigured.status, 503);
  const missingDb = await handleAiRequest(
    postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }),
    { ...fixture.context, env: { AI: ai } },
  );
  assert.equal(missingDb.status, 503);
  fixture.db.close();
  missingAi.db.close();
});

test("too-long persisted user text is rejected before admission", async () => {
  const ai = { async run() { assert.fail("provider must not be called"); } };
  const fixture = makeContext({ ai });
  const saved = fixture.records.get(`workspace-a:message:${fixture.messageId}`);
  saved.data.content = "x".repeat(8_001);
  const response = await handleAiRequest(postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
  assert.equal(response.status, 413);
  assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) count FROM centre_ai_runs").get().count, 0);
  fixture.db.close();
});

test("provider output is capped at 20,000 characters before persistence", async () => {
  const ai = { async run() { return { response: "x".repeat(20_500) }; } };
  const fixture = makeContext({ ai });
  const response = await handleAiRequest(postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
  const { run } = await responseJson(response);
  assert.equal(run.status, "completed");
  assert.equal(run.result.length, 20_000);
  assert.equal(fixture.putCalls[0].data.content.length, 20_000);
  fixture.db.close();
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("The controlled test operation did not reach its expected state.");
}

function pausedProvider() {
  const waiting = [];
  return {
    waiting,
    ai: { run() { return new Promise((resolve) => waiting.push(resolve)); } },
    finish() { waiting.splice(0).forEach((resolve) => resolve({ response: "Done." })); },
  };
}

test("concurrent runs reserve at most two active slots per authenticated workspace", async () => {
  const provider = pausedProvider();
  const fixture = makeContext({ ai: provider.ai });
  const requests = Array.from({ length: 2 }, () => handleAiRequest(postRequest({
    id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId,
  }), fixture.context));
  try {
    await waitFor(() => provider.waiting.length === 2);
    const overflow = await handleAiRequest(postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
    assert.equal(overflow.status, 429);
    assert.equal(provider.waiting.length, 2, "denied admission must not call inference");
    assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) count FROM centre_ai_runs WHERE status='running'").get().count, 2);
    provider.finish();
    const accepted = await Promise.all(requests);
    assert.equal(accepted.filter((response) => response.status === 200).length, 2);
    assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) count FROM centre_ai_runs WHERE status='completed'").get().count, 2);
  } finally {
    provider.finish();
    await Promise.all(requests);
    fixture.db.close();
  }
});

test("distinct authenticated workspaces atomically share the global 16-run active limit", async () => {
  const db = new LocalD1();
  const provider = pausedProvider();
  const fixtures = Array.from({ length: 17 }, (_, index) => makeContext({ db, workspaceId: `active-workspace-${index}`, ai: provider.ai }));
  const requests = fixtures.slice(0, 16).map((fixture) => handleAiRequest(postRequest({
    id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId,
  }), fixture.context));
  try {
    await waitFor(() => provider.waiting.length === 16);
    const overflowFixture = fixtures[16];
    const overflow = await handleAiRequest(postRequest({ id: randomUUID(), chatId: overflowFixture.chatId, messageId: overflowFixture.messageId }), overflowFixture.context);
    assert.equal(overflow.status, 429);
    assert.equal(provider.waiting.length, 16, "global overflow must not call inference");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM centre_ai_runs WHERE status='running'").get().count, 16);
    provider.finish();
    const accepted = await Promise.all(requests);
    assert.equal(accepted.filter((response) => response.status === 200).length, 16);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM centre_ai_runs WHERE status='completed'").get().count, 16);
  } finally {
    provider.finish();
    await Promise.all(requests);
    db.close();
  }
});

test("per-workspace daily admission stops at 20 runs", async () => {
  const ai = { async run() { return { response: "Done." }; } };
  const fixture = makeContext({ ai });
  for (let index = 0; index < 20; index++) {
    const response = await handleAiRequest(postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
    assert.equal(response.status, 200);
  }
  const limited = await handleAiRequest(postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
  assert.equal(limited.status, 429);
  assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) count FROM centre_ai_runs").get().count, 20);
  fixture.db.close();
});

test("global daily admission stops at 120 runs across workspaces", async () => {
  const db = new LocalD1();
  let providerCalls = 0;
  const ai = { async run() { providerCalls++; return { response: "Done." }; } };
  const workspaces = Array.from({ length: 6 }, (_, index) => makeContext({ db, workspaceId: `workspace-${index}`, ai }));
  for (const fixture of workspaces) {
    for (let index = 0; index < 20; index++) {
      const response = await handleAiRequest(postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
      assert.equal(response.status, 200);
    }
  }
  const overflow = makeContext({ db, workspaceId: "workspace-6", ai });
  const limited = await handleAiRequest(postRequest({ id: randomUUID(), chatId: overflow.chatId, messageId: overflow.messageId }), overflow.context);
  assert.equal(limited.status, 429);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM centre_ai_runs").get().count, 120);
  assert.equal(providerCalls, 120);
  db.close();
});

for (const replayMethod of ["GET", "POST"]) {
test(`a saved output ${replayMethod} replays an ambiguous entity write with no AI binding or second inference`, async () => {
  let throwAfterCommit = true;
  const aiCalls = [];
  const ai = { async run() { aiCalls.push(1); return { response: "Saved answer." }; } };
  const fixture = makeContext({
    ai,
    putBehavior: async () => {
      if (throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error("simulated lost put reply");
      }
    },
  });
  const id = randomUUID();
  const started = await handleAiRequest(postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
  assert.equal(started.status, 202);
  assert.equal((await responseJson(started)).run.status, "running");
  assert.equal(aiCalls.length, 1);
  const withoutAi = { ...fixture.context, env: { DB: fixture.db } };
  const replayRequest = replayMethod === "GET" ? getRequest(id) : postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId });
  const recovered = await handleAiRequest(replayRequest, withoutAi);
  assert.equal(recovered.status, 200);
  assert.equal((await responseJson(recovered)).run.status, "completed");
  assert.equal((await responseJson(await handleAiRequest(getRequest(id), fixture.context))).run.result, "Saved answer.");
  assert.equal(aiCalls.length, 1);
  assert.equal(fixture.putCalls.length, 2);
  assert.deepEqual(fixture.putCalls[0], fixture.putCalls[1], "stable mutation must replay the identical body");
  fixture.db.close();
});
}

test("a transient D1 result-write failure retries the same known result", async () => {
  const db = new FailOnceResultWriteD1();
  let providerCalls = 0;
  const ai = { async run() { providerCalls++; return { response: "Known result." }; } };
  const fixture = makeContext({ db, ai });
  const response = await handleAiRequest(postRequest({ id: randomUUID(), chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
  assert.equal(response.status, 200);
  assert.equal((await responseJson(response)).run.result, "Known result.");
  assert.equal(providerCalls, 1);
  assert.equal(fixture.putCalls.length, 1);
  db.close();
});

test("completed run GET and POST replays work with no AI binding", async () => {
  let calls = 0;
  const fixture = makeContext({ ai: { async run() { calls++; return { response: "Already saved." }; } } });
  const id = randomUUID();
  const request = () => postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId });
  try {
    const completed = await responseJson(await handleAiRequest(request(), fixture.context));
    assert.equal(completed.run.status, "completed");
    const withoutAi = { ...fixture.context, env: { DB: fixture.db } };
    for (const replayRequest of [getRequest(id), request()]) {
      const replay = await handleAiRequest(replayRequest, withoutAi);
      assert.equal(replay.status, 200);
      assert.deepEqual(await responseJson(replay), completed);
    }
    assert.equal(calls, 1);
    assert.equal(fixture.putCalls.length, 1);
  } finally {
    fixture.db.close();
  }
});

test("a resolved wrong assistant ACK becomes terminal failed instead of completed", async () => {
  let calls = 0;
  const fixture = makeContext({ ai: { async run() { calls++; return { response: "Expected answer." }; } } });
  fixture.context.entities.put = async (mutation) => {
    fixture.putCalls.push(structuredClone(mutation));
    return record("message", mutation.id, { ...mutation.data, content: "Conflicting content." });
  };
  const id = randomUUID();
  const request = () => postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId });
  try {
    for (const replayRequest of [request(), getRequest(id), request()]) {
      const response = await handleAiRequest(replayRequest, fixture.context);
      assert.equal(response.status, 200);
      const { run } = await responseJson(response);
      assert.equal(run.status, "failed");
      assert.equal(run.errorCode, "assistant_persistence_conflict");
      assert.equal(run.result, null);
    }
    assert.equal(calls, 1);
    assert.equal(fixture.putCalls.length, 1, "terminal conflict must not replay the assistant write");
    assert.equal(fixture.db.sqlite.prepare("SELECT status FROM centre_ai_runs WHERE workspace_id=? AND run_id=?").get("workspace-a", id).status, "failed");
  } finally {
    fixture.db.close();
  }
});

test("provider deadline is terminal and late resolution cannot write or infer again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const provider = pausedProvider();
  const fixture = makeContext({ ai: { run() { calls++; return provider.ai.run(); } } });
  const id = randomUUID();
  const request = () => postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId });
  try {
    const started = handleAiRequest(request(), fixture.context);
    await waitFor(() => provider.waiting.length === 1);
    t.mock.timers.tick(45_000);
    const response = await started;
    assert.equal(response.status, 200);
    const { run } = await responseJson(response);
    assert.equal(run.status, "interrupted");
    assert.equal(run.errorCode, "provider_outcome_unknown");
    assert.equal(run.result, null);
    assert.equal(fixture.putCalls.length, 0);

    provider.finish();
    await new Promise((resolve) => setImmediate(resolve));
    for (const replayRequest of [getRequest(id), request()]) {
      const replay = await handleAiRequest(replayRequest, fixture.context);
      assert.equal(replay.status, 200);
      assert.equal((await responseJson(replay)).run.status, "interrupted");
    }
    assert.equal(calls, 1, "a provider timeout never authorizes a second inference");
    assert.equal(fixture.putCalls.length, 0, "a late provider result cannot create an assistant");
    assert.equal(fixture.db.sqlite.prepare("SELECT result_text FROM centre_ai_runs WHERE workspace_id=? AND run_id=?").get("workspace-a", id).result_text, null);
  } finally {
    provider.finish();
    t.mock.timers.reset();
    fixture.db.close();
  }
});

test("provider errors are stored safely and an exact retry does not regenerate", async () => {
  let calls = 0;
  const ai = { async run() { calls++; throw new Error("provider token=must-not-leak"); } };
  const fixture = makeContext({ ai });
  const id = randomUUID();
  const request = () => postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId });
  const first = await handleAiRequest(request(), fixture.context);
  const firstJson = await responseJson(first);
  assert.equal(firstJson.run.status, "interrupted");
  assert.equal(firstJson.run.errorCode, "provider_outcome_unknown");
  assert.equal(JSON.stringify(firstJson).includes("must-not-leak"), false);
  const retry = await handleAiRequest(request(), fixture.context);
  assert.equal((await responseJson(retry)).run.status, "interrupted");
  assert.equal(calls, 1);
  fixture.db.close();
});

test("expired running run becomes interrupted and is never regenerated", async () => {
  const calls = [];
  const ai = { async run() { calls.push(1); return { response: "New answer." }; } };
  const fixture = makeContext({ ai });
  const id = randomUUID();
  const provider = pausedProvider();
  const inFlight = handleAiRequest(postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId }), {
    ...fixture.context,
    env: { ...fixture.context.env, AI: { run() { calls.push(1); return provider.ai.run(); } } },
  });
  await waitFor(() => provider.waiting.length === 1);
  assert.ok(fixture.db.sqlite.prepare("SELECT 1 FROM centre_ai_runs WHERE workspace_id=? AND run_id=? AND status='running'").get("workspace-a", id));
  fixture.db.sqlite.prepare("UPDATE centre_ai_runs SET lease_expires_at_ms=? WHERE workspace_id=? AND run_id=?").run(Date.now() - 1, "workspace-a", id);
  const firstRead = await handleAiRequest(getRequest(id), fixture.context);
  assert.equal((await responseJson(firstRead)).run.status, "interrupted");
  const replay = await handleAiRequest(postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
  assert.equal((await responseJson(replay)).run.status, "interrupted");
  assert.equal(calls.length, 1, "only the original provider attempt should exist");
  provider.finish();
  assert.equal((await responseJson(await inFlight)).run.status, "interrupted");
  assert.equal(fixture.putCalls.length, 0, "a late result after lease expiry must not write an assistant");
  fixture.db.close();
});

test("completed run survives closing and reopening D1", async () => {
  const path = join(tmpdir(), `centre-ai-${randomUUID()}.sqlite`);
  const db = new LocalD1(path);
  const ai = { async run() { return { response: "Durable answer." }; } };
  const fixture = makeContext({ db, ai });
  const id = randomUUID();
  const done = await handleAiRequest(postRequest({ id, chatId: fixture.chatId, messageId: fixture.messageId }), fixture.context);
  assert.equal((await responseJson(done)).run.status, "completed");
  db.close();

  const reopenedDb = new LocalD1(path);
  const reopened = makeContext({ db: reopenedDb, workspaceId: "workspace-a", ai });
  const loaded = await handleAiRequest(getRequest(id), reopened.context);
  assert.equal((await responseJson(loaded)).run.result, "Durable answer.");
  assert.equal((await responseJson(await handleAiRequest(postRequest({ id, chatId: reopened.chatId, messageId: reopened.messageId }), reopened.context))).run.status, "completed");
  reopenedDb.close();
  rmSync(path, { force: true });
});

test("unmatched route returns null and wrong methods receive 405", async () => {
  const fixture = makeContext({ ai: { async run() { return { response: "unused" }; } } });
  assert.equal(await handleAiRequest(new Request("https://centre.test/other"), fixture.context), null);
  const wrongMethod = await handleAiRequest(new Request("https://centre.test/v1/ai/runs"), fixture.context);
  assert.equal(wrongMethod.status, 405);
  fixture.db.close();
});
