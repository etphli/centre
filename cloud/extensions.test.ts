import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCloudExtension } from "./extensions";
import { createCloudTestHarness, object } from "./test-support";
import type { CloudMutation } from "../shared/cloud";

async function seed(
  h: Awaited<ReturnType<typeof createCloudTestHarness>>,
  token: string,
  kind: string,
  id: string,
  data: Record<string, unknown>,
) {
  const mutation: CloudMutation = {
    mutationId: crypto.randomUUID(),
    kind,
    id,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data,
  };
  const result = await h.call("/v1/records", "POST", mutation, token);
  assert.equal(result.status, 200, JSON.stringify(result.value));
}

test("mounted tutoring uses authenticated workspace storage and SIMULATED inference once", async () => {
  const h = await createCloudTestHarness({ extension: handleCloudExtension }),
    alice = await h.login("alice"),
    bob = await h.login("bob"),
    token = String(alice.token),
    chatId = crypto.randomUUID(),
    messageId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    now = new Date().toISOString();
  let calls = 0;
  h.env.AI = {
    async run(model, input) {
      calls++;
      assert.ok(model.startsWith("@cf/"));
      assert.ok(Array.isArray(object(input).messages));
      return { response: "SIMULATED inference: one half equals 0.5." };
    },
  };
  const request = { id, chatId, messageId };
  assert.equal((await h.call("/v1/ai/runs", "POST", request)).status, 401);
  assert.equal(calls, 0);
  await seed(h, token, "chat", chatId, {
    id: chatId,
    title: "Fractions",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  await seed(h, token, "message", messageId, {
    id: messageId,
    chatId,
    role: "user",
    content: "Explain one half.",
    createdAt: now,
    requestContext: null,
  });
  assert.equal(
    (await h.call("/v1/ai/runs", "POST", request, String(bob.token))).status,
    404,
  );
  assert.equal(calls, 0);
  const result = await h.call("/v1/ai/runs", "POST", request, token);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const run = object(result.value.run);
  assert.equal(run.status, "completed");
  assert.equal(run.result, "SIMULATED inference: one half equals 0.5.");
  assert.equal(calls, 1);
  const replay = await h.call("/v1/ai/runs", "POST", request, token);
  assert.deepEqual(replay, result);
  assert.equal(calls, 1);
  assert.equal(
    (await h.call("/v1/ai/runs/" + id, "GET", undefined, String(bob.token)))
      .status,
    404,
  );
  const changes = await h.call("/v1/changes", "GET", undefined, token),
    records = (changes.value.records as unknown[]).map(object),
    assistant = records.find((record) => record.id === run.assistantMessageId);
  assert.ok(assistant);
  assert.equal(object(assistant.data).role, "assistant");
  assert.equal(object(assistant.data).content, run.result);
  assert.equal(
    h.db.sqlite
      .prepare("SELECT count(*) AS count FROM centre_active_chat_guard")
      .get()?.count,
    0,
  );
});

test("mounted grading atomically commits one source-draft attempt with SIMULATED inference and replays it", async () => {
  const h = await createCloudTestHarness({ extension: handleCloudExtension }),
    alice = await h.login("alice"),
    bob = await h.login("bob"),
    token = String(alice.token),
    resourceId = crypto.randomUUID(),
    draftId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    now = new Date().toISOString();
  let calls = 0;
  h.env.AI = {
    async run() {
      calls++;
      return {
        response: JSON.stringify({
          feedback: [
            {
              questionId: "q1",
              concept: "Fractions",
              score: 0,
              maxScore: 1,
              feedback: "SIMULATED feedback: one half is 0.5.",
              needsReview: true,
            },
          ],
        }),
      };
    },
  };
  await seed(h, token, "resource", resourceId, {
    id: resourceId,
    subjectId: null,
    topicId: null,
    title: "Fractions",
    kind: "quiz",
    createdAt: now,
    updatedAt: now,
    content: "",
    questionTypes: ["short_response"],
    questions: [
      {
        id: "q1",
        responseType: "short_response",
        prompt: "Write one half as a decimal.",
        answer: "0.5",
        explanation: "Divide one by two.",
        marks: 1,
      },
    ],
  });
  await seed(h, token, "practice.draft", draftId, {
    schemaVersion: 1,
    id: draftId,
    revision: 1,
    resourceId,
    answers: { q1: "2" },
    currentQuestion: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  const request = { id, resourceId, draftId, expectedDraftRevision: 1 };
  assert.equal((await h.call("/v1/ai/grades", "POST", request)).status, 401);
  assert.equal(
    (await h.call("/v1/ai/grades", "POST", request, String(bob.token))).status,
    404,
  );
  assert.equal(calls, 0);
  const result = await h.call("/v1/ai/grades", "POST", request, token);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.status, "completed");
  const attempt = object(result.value.attempt);
  assert.equal(attempt.sourceDraftId, draftId);
  assert.equal(calls, 1);
  assert.deepEqual(
    await h.call("/v1/ai/grades", "POST", request, token),
    result,
  );
  const newRun = await h.call(
    "/v1/ai/grades",
    "POST",
    { ...request, id: crypto.randomUUID() },
    token,
  );
  assert.equal(newRun.status, 200);
  assert.equal(object(newRun.value.attempt).id, attempt.id);
  assert.equal(calls, 1);
  assert.equal(
    (await h.call("/v1/ai/grades/" + id, "GET", undefined, String(bob.token)))
      .status,
    404,
  );
  const changes = await h.call("/v1/changes", "GET", undefined, token),
    records = (changes.value.records as unknown[]).map(object);
  assert.equal(
    records.filter((record) => record.kind === "practice.attempt").length,
    1,
  );
  const draft = records.find((record) => record.kind === "practice.draft");
  assert.ok(draft);
  assert.equal(draft.version, 2);
  assert.ok(object(draft.data).deletedAt);
  const needs = records.filter(
    (record) => record.kind === "practice.learningNeed",
  );
  assert.equal(needs.length, 1);
  assert.equal(
    object((object(needs[0].data).evidence as unknown[])[0]).attemptId,
    attempt.id,
  );
});

test("mounted Organato connection authenticates, encrypts credentials and excludes them from client records", async (t) => {
  const h = await createCloudTestHarness({ extension: handleCloudExtension }),
    alice = await h.login("alice"),
    bob = await h.login("bob"),
    token = String(alice.token),
    apiKey = "SIMULATED-organato-private-token",
    key = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  let remoteCalls = 0;
  h.env.ORGANATO_ENCRYPTION_KEYS_JSON = JSON.stringify({ v1: key });
  h.env.ORGANATO_KEY_VERSION = "v1";
  h.env.ORGANATO_ALLOWED_ORIGINS = "https://organato.test";
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      remoteCalls++;
      const request = new Request(input, init);
      assert.equal(request.url, "https://organato.test/api/v1/subjects");
      assert.equal(request.headers.get("Authorization"), "Bearer " + apiKey);
      assert.equal(request.redirect, "error");
      return Response.json({ subjects: [] });
    },
  );
  assert.equal((await h.call("/v1/organato/connection")).status, 401);
  assert.equal(remoteCalls, 0);
  assert.equal(
    (await h.call("/v1/organato/connection", "GET", undefined, token)).value
      .state,
    "unconfigured",
  );
  const connected = await h.call(
    "/v1/organato/connection",
    "POST",
    { apiKey, baseUrl: "https://organato.test/api/v1" },
    token,
  );
  assert.equal(connected.status, 200, JSON.stringify(connected.value));
  assert.equal(connected.value.state, "connected");
  assert.equal(remoteCalls, 1);
  const row = object(
    h.db.sqlite
      .prepare("SELECT * FROM centre_organato_connections WHERE workspace_id=?")
      .get(String(alice.workspaceId)),
  );
  assert.notEqual(row.ciphertext, apiKey);
  assert.equal(row.key_version, "v1");
  assert.equal(JSON.stringify(row).includes(apiKey), false);
  const status = await h.call(
      "/v1/organato/connection",
      "GET",
      undefined,
      token,
    ),
    bootstrap = await h.call("/v1/bootstrap", "GET", undefined, token),
    changes = await h.call("/v1/changes", "GET", undefined, token);
  const publicData = JSON.stringify([connected, status, bootstrap, changes]);
  for (const secret of [apiKey, key, String(row.ciphertext), String(row.iv)])
    assert.equal(publicData.includes(secret), false);
  assert.deepEqual(changes.value.records, []);
  assert.equal(
    (
      await h.call(
        "/v1/organato/connection",
        "GET",
        undefined,
        String(bob.token),
      )
    ).value.state,
    "unconfigured",
  );
  assert.equal(
    (
      await h.call(
        "/v1/organato/connection/remove",
        "POST",
        {},
        String(bob.token),
      )
    ).status,
    200,
  );
  assert.equal(
    (await h.call("/v1/organato/connection", "GET", undefined, token)).value
      .state,
    "connected",
  );
});
