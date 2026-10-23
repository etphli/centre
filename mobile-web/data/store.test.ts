import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { createCloudTestHarness } from "../../cloud/test-support";
import { syncedChatSchema, syncedMessageSchema } from "../../shared/chat-sync";
import { cloudChangesSchema, cloudMutationSchema } from "../../shared/cloud";
import { studySessionSchema } from "../../shared/study-log";
import {
  MobileRequestError,
  MobileStore,
  type PersistedMobileState,
  type Persistence,
} from "./store";

const origin = "https://centre.test";
const now = Date.parse("2026-10-22T00:00:00.000Z");

function emptyState(): PersistedMobileState {
  return {
    schemaVersion: 1,
    origin: "",
    revision: 0,
    activeWorkspaceId: null,
    lastWorkspaceId: null,
    workspaces: {},
  };
}

class MemoryPersistence implements Persistence {
  private value: PersistedMobileState | null = null;
  private tail: Promise<void> = Promise.resolve();
  transactionCount = 0;
  private nextTransactionFailure: Error | null = null;

  failNextTransaction(error = new Error("simulated durable commit failure")): void {
    this.nextTransactionFailure = error;
  }

  async read(): Promise<PersistedMobileState> {
    return structuredClone(this.value ?? emptyState());
  }

  async transact<T>(
    update: (current: PersistedMobileState) => { state: PersistedMobileState; result: T },
  ): Promise<T> {
    this.transactionCount++;
    const previous = this.tail;
    let release = () => {};
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => turn);
    await previous;
    try {
      const changed = update(structuredClone(this.value ?? emptyState()));
      if (this.nextTransactionFailure) {
        const error = this.nextTransactionFailure;
        this.nextTransactionFailure = null;
        throw error;
      }
      this.value = structuredClone(changed.state);
      return structuredClone(changed.result);
    } finally {
      release();
    }
  }
}

type Harness = Awaited<ReturnType<typeof createCloudTestHarness>>;

async function worker(t: TestContext): Promise<Harness> {
  const cloud = await createCloudTestHarness();
  t.after(() => cloud.db.sqlite.close());
  return cloud;
}

async function invitation(cloud: Harness, owner = "alice"): Promise<string> {
  const account = z.object({ token: z.string() }).parse(await cloud.login(owner));
  const response = await cloud.call("/v1/pairings", "POST", {}, account.token);
  assert.equal(response.status, 200);
  return z.object({ code: z.string() }).parse(response.value).code;
}

function makeStore(
  cloud: Harness,
  persistence = new MemoryPersistence(),
  fetcher: typeof fetch = cloud.fetch,
) {
  return new MobileStore({ origin, fetch: fetcher, persistence, now: () => now });
}

async function pairStore(
  cloud: Harness,
  persistence = new MemoryPersistence(),
  fetcher: typeof fetch = cloud.fetch,
) {
  const store = makeStore(cloud, persistence, fetcher);
  await store.open();
  await store.pair(await invitation(cloud));
  return { store, persistence };
}

function topic(id: string, name: string) {
  return { id, subjectId: "maths", name, description: "" };
}

function syncedChat(id: string) {
  return syncedChatSchema.parse({
    id,
    title: "Atomic chat",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    deletedAt: null,
    pinnedAt: null,
    folderId: null,
    sortOrder: 0,
    modelSelection: null,
    lineage: { schemaVersion: 1, kind: "root" },
  });
}

function syncedMessage(id: string, chatId: string) {
  return syncedMessageSchema.parse({
    id,
    chatId,
    role: "user",
    content: "Atomic message",
    createdAt: new Date(now).toISOString(),
    responseDurationMs: null,
    resourceIds: [],
    attachmentIds: [],
    requestContext: null,
  });
}

function studySession(id: string, revision: number, title: string, running = false) {
  return studySessionSchema.parse({
    schemaVersion: 1,
    id,
    revision,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    deletedAt: null,
    subjectId: null,
    taskId: null,
    title,
    notes: "",
    timeZone: "UTC",
    source: "timer",
    segments: [],
    state: running
      ? {
          kind: "running",
          since: "2026-10-21T23:59:00.000Z",
          checkpointAt: "2026-10-22T00:00:00.000Z",
          lastActivityAt: "2026-10-22T00:00:00.000Z",
          confirmedAt: "2026-10-21T23:59:00.000Z",
        }
      : { kind: "paused", reason: "user" },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

test("pairing uses the same-origin HTTPS API and requests remain bearer-only and bounded", async (t) => {
  const cloud = await worker(t);
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: requestUrl(input), init: init ?? {} });
    return cloud.fetch(input, init);
  };
  const store = makeStore(cloud, new MemoryPersistence(), fetcher);
  await store.open();

  assert.throws(
    () => new MobileStore({ origin: "http://example.com" }),
    /HTTPS origin/,
  );
  await assert.rejects(store.pair("too-short"), /32 to 200 ASCII/);
  assert.equal(calls.length, 0);

  await store.pair(await invitation(cloud));
  await assert.rejects(store.saveLocal("too-big", "x".repeat(256 * 1024 + 1)), /record limit/);
  const pairCall = calls[0];
  assert.equal(pairCall.url.origin, origin);
  assert.equal(pairCall.url.pathname, "/v1/auth/pair");
  assert.equal(pairCall.init.credentials, "omit");
  assert.equal(pairCall.init.redirect, "error");
  assert.equal(pairCall.init.cache, "no-store");
  assert.equal(new Headers(pairCall.init.headers).has("Authorization"), false);
  assert.deepEqual(JSON.parse(String(pairCall.init.body)), {
    code: JSON.parse(String(pairCall.init.body)).code,
    deviceName: "Centre iPhone web",
  });

  await store.request("/v1/bootstrap");
  const bootstrapCall = calls.at(-1);
  assert.ok(bootstrapCall);
  assert.equal(bootstrapCall.init.credentials, "omit");
  assert.equal(bootstrapCall.init.redirect, "error");
  assert.equal(bootstrapCall.init.cache, "no-store");
  assert.equal(new Headers(bootstrapCall.init.headers).get("Authorization"), `Bearer ${store.getSnapshot().session?.token}`);

  const callCount = calls.length;
  await assert.rejects(store.request("https://example.com/v1/bootstrap"), MobileRequestError);
  await assert.rejects(store.request("/v1/bootstrap?access_token=private"), MobileRequestError);
  await assert.rejects(store.request("/v1/records", { method: "POST", body: "{}" }), /managed by the durable/);
  await assert.rejects(store.request("/v1/bootstrap", { method: "POST", body: "x".repeat(256 * 1024 + 1) }), /record limit/);
  await assert.rejects(store.request("/v1/no-such-route"), (error) => {
    assert.ok(error instanceof MobileRequestError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found");
    return true;
  });
  assert.equal(calls.length, callCount + 1);
});

test("save atomically persists a validated local projection and immutable mutation before sync", async (t) => {
  const cloud = await worker(t);
  const { store, persistence } = await pairStore(cloud);
  const id = randomUUID();
  await store.save("topic", id, topic(id, "Algebra"));

  const before = store.getSnapshot();
  assert.equal(before.entities[0]?.version, 0);
  assert.equal(before.pending, 1);
  const stored = await persistence.read();
  const workspace = Object.values(stored.workspaces)[0];
  assert.ok(workspace);
  assert.equal(workspace.outbox.length, 1);
  const mutation = cloudMutationSchema.parse(workspace.outbox[0]?.mutation);
  assert.equal(mutation.expectedVersion, 0);
  assert.deepEqual(mutation.data, topic(id, "Algebra"));

  await store.sync();
  const after = store.getSnapshot();
  assert.equal(after.pending, 0);
  assert.equal(after.entities[0]?.version, 1);
  assert.equal(after.entities[0]?.data?.name, "Algebra");
  assert.equal(after.phase, "ready");
});

test("saveBatch validates before writing and commits chat, message, and local journals atomically", async (t) => {
  const cloud = await worker(t);
  const { store, persistence } = await pairStore(cloud);
  const chatId = randomUUID();
  const messageId = randomUUID();
  const batch = [
    { kind: "chat", id: chatId, data: syncedChat(chatId) },
    { kind: "message", id: messageId, data: syncedMessage(messageId, chatId) },
  ];
  const localValues = {
    "chat-run:send-1": { chatId, userMessageId: messageId, state: "sending" },
    "composer:active": null,
  };
  const initial = await persistence.read();
  const initialTransactions = persistence.transactionCount;

  await assert.rejects(
    store.saveBatch([
      batch[0]!,
      { kind: "not-a-cloud-kind", id: randomUUID(), data: { id: randomUUID() } },
    ], localValues),
    /Unsupported Centre cloud record kind/,
  );
  assert.equal(persistence.transactionCount, initialTransactions);
  assert.deepEqual(await persistence.read(), initial);
  await assert.rejects(
    store.saveBatch(batch, { invalid: () => "not JSON" } as unknown as Record<string, unknown>),
    /JSON serializable/,
  );
  assert.equal(persistence.transactionCount, initialTransactions);
  assert.deepEqual(await persistence.read(), initial);

  persistence.failNextTransaction();
  await assert.rejects(store.saveBatch(batch, localValues), /simulated durable commit failure/);
  assert.deepEqual(await persistence.read(), initial);

  await store.saveBatch(batch, localValues);
  const committed = await persistence.read();
  const workspace = Object.values(committed.workspaces)[0];
  assert.ok(workspace);
  assert.equal(committed.revision, initial.revision + 1);
  assert.equal(persistence.transactionCount, initialTransactions + 2);
  assert.deepEqual(
    workspace.outbox.map(({ mutation }) => [mutation.kind, mutation.id]),
    [["chat", chatId], ["message", messageId]],
  );
  assert.equal(workspace.entities[`e:${JSON.stringify(["chat", chatId])}`]?.version, 0);
  assert.equal(workspace.entities[`e:${JSON.stringify(["message", messageId])}`]?.version, 0);
  assert.deepEqual(workspace.localValues["v:chat-run:send-1"], localValues["chat-run:send-1"]);
  assert.equal(workspace.localValues["v:composer:active"], null);
});

test("saveBatch rejects more than 25 items before opening a durable transaction", async (t) => {
  const cloud = await worker(t);
  const { store, persistence } = await pairStore(cloud);
  const transactionCount = persistence.transactionCount;
  const items = Array.from({ length: 26 }, (_, index) => {
    const id = randomUUID();
    return { kind: "topic", id, data: topic(id, `Topic ${index}`) };
  });

  await assert.rejects(store.saveBatch(items), /at most 25/);
  assert.equal(persistence.transactionCount, transactionCount);
});

test("a lost write acknowledgment replays the exact stored mutation body", async (t) => {
  const cloud = await worker(t);
  let dropAcknowledgment = true;
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const response = await cloud.fetch(input, init);
    if (requestUrl(input).pathname === "/v1/records" && init?.method === "POST") {
      bodies.push(String(init.body));
      if (dropAcknowledgment) {
        dropAcknowledgment = false;
        throw new TypeError("The connection closed after the server committed.");
      }
    }
    return response;
  };
  const { store } = await pairStore(cloud, new MemoryPersistence(), fetcher);
  const id = randomUUID();
  await store.save("topic", id, topic(id, "Factors"));

  await store.sync();
  assert.equal(store.getSnapshot().phase, "offline");
  assert.equal(store.getSnapshot().pending, 1);
  await store.sync();

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(store.getSnapshot().pending, 0);
  const sessionToken = store.getSnapshot().session?.token;
  assert.ok(sessionToken);
  const latest = await cloud.call("/v1/changes?cursor=0&limit=100", "GET", undefined, sessionToken);
  const records = cloudChangesSchema.parse(latest.value).records;
  assert.equal(records.filter((record) => record.kind === "topic" && record.id === id).length, 1);
});

test("100 edits coalesce behind an immutable uncertain head and replay before the latest projection", async (t) => {
  const cloud = await worker(t);
  const persistence = new MemoryPersistence();
  const bodies: string[] = [];
  let firstWriteDeliveryAtFetch: string | undefined;
  let dropFirstAcknowledgment = true;
  const fetcher: typeof fetch = async (input, init) => {
    const isWrite = requestUrl(input).pathname === "/v1/records" && init?.method === "POST";
    if (isWrite) {
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        const state = await persistence.read();
        firstWriteDeliveryAtFetch = Object.values(state.workspaces)[0]?.outbox[0]?.delivery;
      }
    }
    const response = await cloud.fetch(input, init);
    if (isWrite && dropFirstAcknowledgment) {
      dropFirstAcknowledgment = false;
      throw new TypeError("The connection closed after the first write committed.");
    }
    return response;
  };
  const { store } = await pairStore(cloud, persistence, fetcher);
  const id = randomUUID();
  await store.saveBatch([{ kind: "topic", id, data: topic(id, "Draft 0") }]);
  const beforeSync = await persistence.read();
  const workspaceBeforeSync = Object.values(beforeSync.workspaces)[0];
  assert.ok(workspaceBeforeSync);
  const originalMutation = structuredClone(workspaceBeforeSync.outbox[0]?.mutation);
  assert.ok(originalMutation);

  await store.sync();
  assert.equal(store.getSnapshot().phase, "offline");
  assert.equal(store.getSnapshot().pending, 1);
  assert.equal(firstWriteDeliveryAtFetch, "uncertain");

  for (let revision = 1; revision <= 100; revision++) {
    await store.saveBatch([{ kind: "topic", id, data: topic(id, `Draft ${revision}`) }]);
  }

  const whileOffline = await persistence.read();
  const offlineWorkspace = Object.values(whileOffline.workspaces)[0];
  assert.ok(offlineWorkspace);
  assert.equal(offlineWorkspace.outbox.length, 2);
  assert.equal(offlineWorkspace.outbox[0]?.delivery, "uncertain");
  assert.deepEqual(offlineWorkspace.outbox[0]?.mutation, originalMutation);
  assert.equal(offlineWorkspace.outbox[1]?.delivery, "queued");
  assert.equal(offlineWorkspace.outbox[1]?.mutation.expectedVersion, 1);
  assert.equal(offlineWorkspace.entities[`e:${JSON.stringify(["topic", id])}`]?.data?.name, "Draft 100");

  await store.sync();

  assert.equal(bodies.length, 3);
  assert.equal(bodies[0], bodies[1]);
  const latestMutation = cloudMutationSchema.parse(JSON.parse(bodies[2] ?? "null"));
  assert.equal(latestMutation.expectedVersion, 1);
  assert.equal(latestMutation.data?.name, "Draft 100");
  assert.equal(store.getSnapshot().pending, 0);
  assert.equal(store.getSnapshot().conflicts.length, 0);
  const saved = store.getSnapshot().entities.find((entity) => entity.id === id);
  assert.equal(saved?.version, 2);
  assert.equal(saved?.data?.name, "Draft 100");
});

test("a save during receipt replay counts the refreshed cloud version only once", async (t) => {
  const cloud = await worker(t);
  const bodies: string[] = [];
  let dropFirstAcknowledgment = true;
  let saveBeforeReplay: (() => Promise<void>) | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const isWrite = requestUrl(input).pathname === "/v1/records" && init?.method === "POST";
    if (isWrite) {
      bodies.push(String(init?.body));
      if (bodies.length === 2) await saveBeforeReplay?.();
    }
    const response = await cloud.fetch(input, init);
    if (isWrite && dropFirstAcknowledgment) {
      dropFirstAcknowledgment = false;
      throw new TypeError("The connection closed after the first write committed.");
    }
    return response;
  };
  const { store } = await pairStore(cloud, new MemoryPersistence(), fetcher);
  const id = randomUUID();
  saveBeforeReplay = () => store.save("topic", id, topic(id, "Edit during replay"));
  await store.save("topic", id, topic(id, "Initial edit"));

  await store.sync();
  assert.equal(store.getSnapshot().phase, "offline");
  await store.sync();

  assert.equal(bodies.length, 3);
  const latestMutation = cloudMutationSchema.parse(JSON.parse(bodies[2] ?? "null"));
  assert.equal(latestMutation.expectedVersion, 1);
  assert.equal(latestMutation.data?.name, "Edit during replay");
  assert.equal(store.getSnapshot().pending, 0);
  assert.equal(store.getSnapshot().conflicts.length, 0);
  const saved = store.getSnapshot().entities.find((entity) => entity.id === id);
  assert.equal(saved?.version, 2);
  assert.equal(saved?.data?.name, "Edit during replay");
});

test("an older acknowledgment keeps a later local edit and its queued version", async (t) => {
  const cloud = await worker(t);
  let releaseFirst: () => void = () => {};
  let markStarted: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let writeCount = 0;
  let entityAtSecondSend: unknown;
  const store = makeStore(cloud, new MemoryPersistence(), async (input, init) => {
    if (requestUrl(input).pathname === "/v1/records" && init?.method === "POST") {
      writeCount++;
      const response = await cloud.fetch(input, init);
      if (writeCount === 1) {
        markStarted();
        await firstGate;
        return response;
      }
      if (writeCount === 2) {
        entityAtSecondSend = store.getSnapshot().entities.find((entity) => entity.id === id)?.data?.name;
      }
      return response;
    }
    return cloud.fetch(input, init);
  });
  await store.open();
  await store.pair(await invitation(cloud));
  const id = randomUUID();
  const journalKey = "chat-run:send-1";
  await store.saveBatch(
    [{ kind: "topic", id, data: topic(id, "First") }],
    { [journalKey]: { stage: "sending" } },
  );
  const syncing = store.sync();
  await firstStarted;
  await store.saveBatch(
    [{ kind: "topic", id, data: topic(id, "Later edit") }],
    { [journalKey]: { stage: "response-streaming" } },
  );
  releaseFirst();
  await syncing;

  assert.equal(entityAtSecondSend, "Later edit");
  assert.equal(store.getSnapshot().entities.find((entity) => entity.id === id)?.data?.name, "Later edit");
  assert.deepEqual(await store.getLocal(journalKey), { stage: "response-streaming" });
  assert.equal(store.getSnapshot().pending, 0);
  assert.equal(writeCount, 2);
});

test("a concurrent cloud edit creates an explicit conflict and Keep Local bumps the domain revision", async (t) => {
  const cloud = await worker(t);
  const local = await pairStore(cloud);
  const remote = await pairStore(cloud);
  const id = randomUUID();

  await local.store.save("studySession", id, studySession(id, 1, "Original"));
  await local.store.sync();
  await remote.store.sync();

  await local.store.save("studySession", id, studySession(id, 2, "First local edit"));
  await remote.store.save("studySession", id, studySession(id, 3, "Cloud edit"));
  await remote.store.sync();
  await local.store.sync();

  const conflict = local.store.getSnapshot().conflicts[0];
  assert.ok(conflict);
  assert.equal(conflict.local.data?.title, "First local edit");
  assert.equal(conflict.remote?.version, 2);
  await local.store.save("studySession", id, studySession(id, 5, "Latest local edit"));
  const beforeResolution = await local.persistence.read();
  const beforeWorkspace = Object.values(beforeResolution.workspaces)[0];
  assert.ok(beforeWorkspace);
  const originalMutationId = beforeWorkspace.outbox[0]?.mutation.mutationId;

  await local.store.resolveConflict(conflict.key, "local");
  const resolved = await local.persistence.read();
  const workspace = Object.values(resolved.workspaces)[0];
  assert.ok(workspace);
  const replacement = workspace.outbox[0]?.mutation;
  assert.ok(replacement);
  assert.notEqual(replacement.mutationId, originalMutationId);
  assert.equal(replacement.expectedVersion, 2);
  assert.equal(replacement.data?.revision, 6);
  assert.equal(replacement.data?.title, "Latest local edit");

  await local.store.sync();
  const final = local.store.getSnapshot().entities.find((entity) => entity.id === id);
  assert.equal(final?.version, 3);
  assert.equal(final?.data?.revision, 6);
  assert.equal(final?.data?.title, "Latest local edit");
  assert.equal(local.store.getSnapshot().conflicts.length, 0);
});

test("remote running study imports pause at the checkpoint; local running timers pause on restart", async (t) => {
  const cloud = await worker(t);
  const device = await pairStore(cloud);
  const remoteId = randomUUID();
  const account = z.object({ token: z.string() }).parse(await cloud.login("alice"));
  const remoteMutation = cloudMutationSchema.parse({
    mutationId: randomUUID(),
    kind: "studySession",
    id: remoteId,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: studySession(remoteId, 1, "Remote running", true),
  });
  assert.equal((await cloud.call("/v1/records", "POST", remoteMutation, account.token)).status, 200);

  await device.store.sync();
  const imported = device.store.getSnapshot().entities.find((entity) => entity.id === remoteId);
  assert.equal(imported?.version, 2);
  assert.deepEqual(imported?.data?.state, { kind: "paused", reason: "recovery" });
  assert.deepEqual(imported?.data?.segments, [
    { start: "2026-10-21T23:59:00.000Z", end: "2026-10-22T00:00:00.000Z" },
  ]);

  const localId = randomUUID();
  await device.store.save("studySession", localId, studySession(localId, 1, "Local running", true));
  await device.store.sync();
  const persisted = await device.persistence.read();
  const workspace = Object.values(persisted.workspaces)[0];
  assert.ok(workspace);
  const restarted = makeStore(cloud, device.persistence);
  await restarted.open();
  const recovered = restarted.getSnapshot().entities.find((entity) => entity.id === localId);
  assert.deepEqual(recovered?.data?.state, { kind: "paused", reason: "recovery" });
  assert.equal(recovered?.data?.revision, 2);
  const recoveredSession = studySessionSchema.parse(recovered?.data);
  assert.equal(recoveredSession.segments.length, 1);
  assert.equal(restarted.getSnapshot().pending, 1);
});

test("disconnect hides the current library without losing pending edits or workspace-local values", async (t) => {
  const cloud = await worker(t);
  const { store } = await pairStore(cloud);
  const id = randomUUID();
  await store.save("topic", id, topic(id, "Kept offline"));
  await store.saveLocal("grade-run", { id: "grading-1", state: "running" });
  await store.disconnect();
  assert.equal(store.getSnapshot().session, null);
  assert.equal(store.getSnapshot().entities.length, 0);
  assert.equal(store.getSnapshot().pending, 0);

  await store.pair(await invitation(cloud, "bob"));
  assert.equal(store.getSnapshot().entities.length, 0);
  assert.equal(store.getSnapshot().pending, 0);
  assert.equal(await store.getLocal("grade-run"), undefined);

  await store.disconnect();
  await store.pair(await invitation(cloud, "alice"));
  assert.equal(store.getSnapshot().entities.find((entity) => entity.id === id)?.data?.name, "Kept offline");
  assert.equal(store.getSnapshot().pending, 1);
  assert.deepEqual(await store.getLocal("grade-run"), { id: "grading-1", state: "running" });
});

test("concurrent tabs preserve each other's atomic local writes", async (t) => {
  const cloud = await worker(t);
  const persistence = new MemoryPersistence();
  const first = await pairStore(cloud, persistence);
  const second = await pairStore(cloud, persistence);
  const firstId = randomUUID();
  const secondId = randomUUID();

  await Promise.all([
    first.store.save("topic", firstId, topic(firstId, "First tab")),
    second.store.save("topic", secondId, topic(secondId, "Second tab")),
  ]);

  const state = await persistence.read();
  const workspace = Object.values(state.workspaces)[0];
  assert.ok(workspace);
  assert.equal(workspace.outbox.length, 2);
  assert.equal(Object.values(workspace.entities).length, 2);
});

test("unknown cloud kinds remain opaque and large decimal cursors are preserved exactly", async () => {
  const persistence = new MemoryPersistence();
  const session = {
    token: `ctr_${"a".repeat(64)}`,
    workspaceId: "unknown-kind-workspace",
    deviceId: randomUUID(),
    expiresAt: "2026-11-21T00:00:00.000Z",
  };
  let cursor = "0";
  const fetcher: typeof fetch = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/v1/auth/pair") return Response.json(session);
    if (url.pathname === "/v1/changes") {
      cursor = "9007199254740993";
      return Response.json({
        records: [{
          kind: "future.kind",
          id: "opaque-record",
          schemaVersion: 1,
          version: 1,
          cursor,
          createdCursor: cursor,
          updatedAt: "2026-10-22T00:00:00.000Z",
          deleted: false,
          data: { shapeOwnedByFutureClient: true },
        }],
        cursor,
        hasMore: false,
      });
    }
    throw new Error(`Unexpected test route ${url.pathname}`);
  };
  const store = new MobileStore({ origin, fetch: fetcher, persistence, now: () => now });
  await store.open();
  await store.pair("a".repeat(64));
  await store.sync();

  assert.equal(store.getSnapshot().entities[0]?.kind, "future.kind");
  assert.deepEqual(store.getSnapshot().entities[0]?.data, { shapeOwnedByFutureClient: true });
  const state = await persistence.read();
  const workspace = Object.values(state.workspaces)[0];
  assert.ok(workspace);
  assert.equal(workspace.cursor, "9007199254740993");
});

test("pair response after disconnect cannot restore an old session", async () => {
  const persistence = new MemoryPersistence();
  let finishFetch: (response: Response) => void = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pendingResponse = new Promise<Response>((resolve) => {
    finishFetch = resolve;
  });
  const session = {
    token: `ctr_${"b".repeat(64)}`,
    workspaceId: "late-pair-workspace",
    deviceId: randomUUID(),
    expiresAt: "2026-11-21T00:00:00.000Z",
  };
  const fetcher: typeof fetch = async () => {
    markStarted();
    return pendingResponse;
  };
  const store = new MobileStore({ origin, fetch: fetcher, persistence, now: () => now });
  await store.open();
  const pairing = store.pair("b".repeat(64));
  await started;
  await store.disconnect();
  finishFetch(Response.json(session));
  await assert.rejects(pairing, /account changed/);
  assert.equal(store.getSnapshot().session, null);
  assert.equal(store.getSnapshot().phase, "unpaired");
});

test("a late pairing response cannot replace authority established in another tab", async () => {
  const persistence = new MemoryPersistence();
  let finishFetch: (response: Response) => void = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pendingResponse = new Promise<Response>((resolve) => {
    finishFetch = resolve;
  });
  const staleSession = {
    token: `ctr_${"c".repeat(64)}`,
    workspaceId: "stale-workspace",
    deviceId: randomUUID(),
    expiresAt: "2026-11-21T00:00:00.000Z",
  };
  const currentSession = {
    token: `ctr_${"d".repeat(64)}`,
    workspaceId: "current-workspace",
    deviceId: randomUUID(),
    expiresAt: "2026-11-21T00:00:00.000Z",
  };
  const staleFetcher: typeof fetch = async () => {
    markStarted();
    return pendingResponse;
  };
  const currentFetcher: typeof fetch = async () => Response.json(currentSession);
  const staleTab = new MobileStore({ origin, fetch: staleFetcher, persistence, now: () => now });
  const currentTab = new MobileStore({ origin, fetch: currentFetcher, persistence, now: () => now });
  await staleTab.open();
  await currentTab.open();

  const stalePairing = staleTab.pair("c".repeat(64));
  await started;
  await currentTab.pair("d".repeat(64));
  finishFetch(Response.json(staleSession));

  await assert.rejects(stalePairing, /account changed/);
  const persisted = await persistence.read();
  assert.equal(persisted.activeWorkspaceId, currentSession.workspaceId);
  assert.equal(persisted.workspaces[`w:${currentSession.workspaceId}`]?.session?.token, currentSession.token);
});
