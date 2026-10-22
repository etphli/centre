import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "./worker";
import { interactiveResourceProgressId } from "../shared/checklist-progress";
import { cloudMutationSchema, type CloudMutation } from "../shared/cloud";
import { createCloudTestHarness as harness, object } from "./test-support";
async function seedAttachmentOwner(
  h: Awaited<ReturnType<typeof harness>>,
  token: string,
  id: string,
  chatId = "owner-" + id,
) {
  const time = "2026-10-22T00:00:00.000Z";
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          mutationId: crypto.randomUUID(),
          kind: "chat",
          id: chatId,
          schemaVersion: 1,
          expectedVersion: 0,
          deleted: false,
          data: {
            id: chatId,
            title: "Attachment owner",
            createdAt: time,
            updatedAt: time,
            deletedAt: null,
          },
        },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          mutationId: crypto.randomUUID(),
          kind: "message",
          id: chatId + "-message",
          schemaVersion: 1,
          expectedVersion: 0,
          deleted: false,
          data: {
            id: chatId + "-message",
            chatId,
            role: "user",
            content: "Attached",
            createdAt: time,
            attachmentIds: [id],
            requestContext: null,
          },
        },
        token,
      )
    ).status,
    200,
  );
  return { sourceChatId: chatId, chatId };
}
function mutation(
  id = "topic-1",
  expectedVersion = 0,
  name = "Algebra",
): CloudMutation {
  return {
    mutationId: crypto.randomUUID(),
    kind: "topic",
    id,
    schemaVersion: 1,
    expectedVersion,
    deleted: false,
    data: { id, subjectId: "math", name, description: "" },
  };
}
test("verified Google identity, fail-closed configuration, opaque tokens, pairing and device revocation", async () => {
  const h = await harness();
  for (const options of [
    { aud: "wrong" },
    { wrongKey: true },
    { expired: true },
  ])
    assert.equal(
      (
        await h.call("/v1/auth/google", "POST", {
          idToken: await h.identity("alice", options),
          deviceName: "Mac",
        })
      ).status,
      401,
    );
  for (const [sub, options] of [
    ["denied", {}],
    ["alice", { verified: false }],
  ] as const)
    assert.equal(
      (
        await h.call("/v1/auth/google", "POST", {
          idToken: await h.identity(sub, options),
          deviceName: "Mac",
        })
      ).status,
      403,
    );
  const a = await h.login("alice"),
    token = String(a.token);
  assert.match(token, /^ctr_[a-f0-9]{64}$/);
  assert.notEqual(
    h.db.sqlite.prepare("SELECT token_hash FROM centre_device").get()
      ?.token_hash,
    token,
  );
  assert.equal(
    (await h.call("/v1/bootstrap", "GET", undefined, "ctr_" + "0".repeat(64)))
      .status,
    401,
  );
  const pairing = await h.call("/v1/pairings", "POST", {}, token);
  assert.equal(pairing.status, 200);
  assert.match(String(pairing.value.code), /^[a-f0-9]{64}$/);
  const paired = await h.call("/v1/auth/pair", "POST", {
    code: pairing.value.code,
    deviceName: "iPhone",
  });
  assert.equal(paired.status, 200);
  assert.equal(paired.value.workspaceId, a.workspaceId);
  assert.equal(
    (
      await h.call("/v1/auth/pair", "POST", {
        code: pairing.value.code,
        deviceName: "again",
      })
    ).status,
    401,
  );
  const devices = await h.call("/v1/devices", "GET", undefined, token);
  assert.equal(JSON.stringify(devices.value).includes("token"), false);
  await h.call(
    "/v1/devices/revoke",
    "POST",
    { deviceId: paired.value.deviceId },
    token,
  );
  assert.equal(
    (
      await h.call(
        "/v1/bootstrap",
        "GET",
        undefined,
        String(paired.value.token),
      )
    ).status,
    401,
  );
  h.setTime(Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(
    (await h.call("/v1/bootstrap", "GET", undefined, token)).status,
    401,
  );
  h.env.GOOGLE_ALLOWED_SUBJECTS = "";
  assert.equal(
    (
      await h.call("/v1/auth/google", "POST", {
        idToken: await h.identity("alice"),
        deviceName: "Mac",
      })
    ).status,
    503,
  );
});
test("three workspaces, CAS, exact retry receipts, numeric cursors and durable tombstones", async () => {
  const h = await harness();
  const [a, b, c] = await Promise.all(
    ["alice", "bob", "charlie"].map((s) => h.login(s)),
  );
  const token = String(a.token);
  const m = mutation();
  const initial = await h.call("/v1/records", "POST", m, token);
  assert.equal(initial.status, 200);
  assert.equal(object(initial.value.record).version, 1);
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        mutation("topic-1", 0, "stale"),
        token,
      )
    ).status,
    409,
  );
  const edit = await h.call(
    "/v1/records",
    "POST",
    mutation("topic-1", 1, "Edited"),
    token,
  );
  assert.equal(edit.status, 200);
  assert.deepEqual(await h.call("/v1/records", "POST", m, token), initial);
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        { ...m, data: { ...m.data, name: "different" } },
        token,
      )
    ).status,
    409,
  );
  assert.equal(
    (await h.call("/v1/records", "POST", JSON.stringify(m, null, 2), token))
      .status,
    409,
  );
  for (let i = 2; i <= 12; i++)
    assert.equal(
      (await h.call("/v1/records", "POST", mutation("topic-" + i), token))
        .status,
      200,
    );
  for (const account of [b, c]) {
    const result = await h.call(
      "/v1/changes",
      "GET",
      undefined,
      String(account.token),
    );
    assert.deepEqual(result.value.records, []);
    assert.equal(
      (await h.call("/v1/records", "POST", mutation(), String(account.token)))
        .status,
      200,
    );
  }
  const tombstone = { ...mutation("topic-1", 2), deleted: true, data: null };
  assert.equal(
    (await h.call("/v1/records", "POST", tombstone, token)).status,
    200,
  );
  const records: Record<string, unknown>[] = [];
  let cursor = "0";
  for (let i = 0; i < 10; i++) {
    const page = await h.call(
      "/v1/changes?limit=3&cursor=" + cursor,
      "GET",
      undefined,
      token,
    );
    for (const value of page.value.records as unknown[])
      records.push(object(value));
    cursor = String(page.value.cursor);
    if (!page.value.hasMore) break;
  }
  assert.equal(records.length, 12);
  assert.equal(records.at(-1)?.deleted, true);
  assert.ok(
    records.every(
      (r, i) =>
        i === 0 ||
        BigInt(String(r.cursor)) > BigInt(String(records[i - 1].cursor)),
    ),
  );
  for (const invalid of [
    { ...mutation(), kind: "secrets" },
    { ...mutation(), schemaVersion: 2 },
    {
      ...mutation(),
      data: {
        id: "topic-1",
        subjectId: "math",
        name: "safe",
        password: "secret",
      },
    },
    { ...mutation(), workspaceId: b.workspaceId },
  ])
    assert.equal(
      (await h.call("/v1/records", "POST", invalid, token)).status,
      400,
    );
  assert.equal(
    (
      await h.call(
        "/v1/changes?cursor=9223372036854775808",
        "GET",
        undefined,
        token,
      )
    ).status,
    400,
  );
});
test("trusted commits roll back in SQL and practice draft identity is unique", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token);
  await h.call("/v1/extension", "GET", undefined, token);
  const ctx = h.context();
  assert.ok(ctx);
  await assert.rejects(
    ctx.entities.commit([mutation("atomic"), mutation("missing", 1)]),
  );
  assert.equal(await ctx.entities.get("topic", "atomic"), null);
  assert.equal(
    h.db.sqlite.prepare("SELECT count(*) AS count FROM centre_mutation").get()
      ?.count,
    0,
  );
  const sourceDraftId = crypto.randomUUID();
  const attempt = (id: string): CloudMutation => ({
    mutationId: crypto.randomUUID(),
    kind: "practice.attempt",
    id,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id,
      schemaVersion: 1,
      revision: 1,
      sourceDraftId,
      resourceId: "quiz",
      answers: {},
      result: { score: 0, total: 0, feedback: [] },
      createdAt: "2026-10-22T00:00:00.000Z",
    },
  });
  const first = await ctx.entities.put(attempt(crypto.randomUUID()));
  assert.equal(
    (await ctx.entities.getPracticeAttempt(sourceDraftId))?.id,
    first.id,
  );
  await assert.rejects(
    ctx.entities.commit([
      mutation("rolled-back"),
      attempt(crypto.randomUUID()),
    ]),
  );
  assert.equal(await ctx.entities.get("topic", "rolled-back"), null);
  await assert.rejects(
    ctx.entities.put({ ...attempt(first.id), expectedVersion: 1 }),
  );
});
test("attachment staging, digest validation, immutable retries, workspace scope and tombstones", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    b = await h.login("bob"),
    token = String(a.token),
    id = crypto.randomUUID(),
    data = btoa("hello");
  const metadata = {
    name: "note.txt",
    mimeType: "text/plain",
    size: 5,
    sha256: await sha256("hello"),
    ...(await seedAttachmentOwner(h, token, id)),
  };
  assert.equal(
    (await h.call("/v1/attachments/" + id, "PUT", metadata, token)).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "?chatId=" + metadata.chatId,
        "GET",
        undefined,
        token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0",
        "PUT",
        { data },
        String(b.token),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/complete",
        "POST",
        { mutationId: crypto.randomUUID() },
        token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0",
        "PUT",
        { data },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0",
        "PUT",
        { data: btoa("other") },
        token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0",
        "PUT",
        { data },
        token,
      )
    ).status,
    200,
  );
  const complete = { mutationId: crypto.randomUUID() };
  const result = await h.call(
    "/v1/attachments/" + id + "/complete",
    "POST",
    complete,
    token,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    await h.call(
      "/v1/attachments/" + id + "/complete",
      "POST",
      complete,
      token,
    ),
    result,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0?chatId=" + metadata.chatId,
        "GET",
        undefined,
        token,
      )
    ).value.data,
    data,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0",
        "PUT",
        { data },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "?chatId=" + metadata.chatId,
        "GET",
        undefined,
        String(b.token),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          mutationId: crypto.randomUUID(),
          kind: "attachment",
          id,
          schemaVersion: 1,
          expectedVersion: 1,
          deleted: true,
          data: null,
        },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0?chatId=" + metadata.chatId,
        "GET",
        undefined,
        token,
      )
    ).status,
    404,
  );
  for (let i = 0; i < 6; i++) {
    const quotaId = crypto.randomUUID(),
      owner = await seedAttachmentOwner(h, token, quotaId);
    assert.equal(
      (
        await h.call(
          "/v1/attachments/" + quotaId,
          "PUT",
          { ...metadata, ...owner, size: 20 * 1024 * 1024 },
          token,
        )
      ).status,
      i < 5 ? 200 : 413,
    );
  }
  const badId = crypto.randomUUID();
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + badId,
        "PUT",
        { ...metadata, size: 21 * 1024 * 1024 },
        token,
      )
    ).status,
    400,
  );
});
test("payload, rate, receipt-storage bounds and expired pairing are enforced by handlers", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token);
  const huge = {
    ...mutation("large"),
    data: { id: "large", subjectId: "math", name: "x".repeat(256 * 1024) },
  };
  assert.equal((await h.call("/v1/records", "POST", huge, token)).status, 413);
  const pairing = await h.call("/v1/pairings", "POST", {}, token);
  h.setTime(Date.parse("2026-10-22T00:06:00Z"));
  assert.equal(
    (
      await h.call("/v1/auth/pair", "POST", {
        code: pairing.value.code,
        deviceName: "expired",
      })
    ).status,
    401,
  );
  assert.equal(
    (await h.call("/v1/records", "POST", mutation("one"), token)).status,
    200,
  );
  h.db.sqlite
    .prepare(
      "UPDATE centre_workspace_usage SET receipt_bytes=? WHERE workspace=?",
    )
    .run(100 * 1024 * 1024, String(a.workspaceId));
  assert.equal(
    (await h.call("/v1/records", "POST", mutation("two"), token)).status,
    413,
  );
  assert.equal(
    h.db.sqlite
      .prepare("SELECT count(*) AS count FROM centre_record WHERE id='two'")
      .get()?.count,
    0,
  );
  h.db.sqlite
    .prepare("UPDATE centre_rate SET count=600 WHERE key=?")
    .run("workspace:" + String(a.workspaceId));
  assert.equal(
    (await h.call("/v1/bootstrap", "GET", undefined, token)).status,
    429,
  );
});
test("portable chat fields exclude execution state and nested unknown data", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token),
    time = "2026-10-22T00:00:00.000Z";
  const chat: CloudMutation = {
    mutationId: crypto.randomUUID(),
    kind: "chat",
    id: "chat",
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id: "chat",
      title: "branch",
      createdAt: time,
      updatedAt: time,
      lineage: {
        schemaVersion: 1,
        kind: "branch",
        operation: "continue",
        parentChatId: "parent",
        sourceMessageId: "prompt",
        checkpointMessageId: null,
      },
    },
  };
  const saved = await h.call("/v1/records", "POST", chat, token);
  assert.equal(saved.status, 200);
  assert.equal(
    object(object(saved.value.record).data).codexThreadId,
    undefined,
  );
  for (const field of ["codexThreadId", "activity", "messages"])
    assert.equal(
      (
        await h.call(
          "/v1/records",
          "POST",
          {
            ...chat,
            mutationId: crypto.randomUUID(),
            id: "new",
            data: { ...chat.data, id: "new", [field]: "private" },
          },
          token,
        )
      ).status,
      400,
    );
  const msg: CloudMutation = {
    mutationId: crypto.randomUUID(),
    kind: "message",
    id: "msg",
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id: "msg",
      chatId: "chat",
      role: "assistant",
      content: "hi",
      createdAt: time,
      requestContext: { page: "resources", localPath: "/private" },
    },
  };
  assert.equal((await h.call("/v1/records", "POST", msg, token)).status, 400);
  const resource: CloudMutation = {
    mutationId: crypto.randomUUID(),
    kind: "resource",
    id: "resource",
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id: "resource",
      subjectId: null,
      topicId: null,
      title: "Quiz",
      kind: "quiz",
      createdAt: time,
      updatedAt: time,
      content: "",
      questions: [
        { id: "q", prompt: "Question", answer: "a", secret: "not portable" },
      ],
    },
  };
  assert.equal(
    (await h.call("/v1/records", "POST", resource, token)).status,
    400,
  );
});
test("large numeric cursors stay decimal strings beyond JavaScript safe integers", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token);
  h.db.sqlite
    .prepare(
      "INSERT INTO sqlite_sequence(name,seq) VALUES('centre_mutation',9007199254740992)",
    )
    .run();
  const saved = await h.call("/v1/records", "POST", mutation(), token);
  assert.equal(saved.status, 200);
  assert.equal(object(saved.value.record).cursor, "9007199254740993");
  const changes = await h.call(
    "/v1/changes?cursor=9007199254740992",
    "GET",
    undefined,
    token,
  );
  assert.equal(changes.status, 200);
  assert.equal(changes.value.cursor, "9007199254740993");
});
test("malformed content, database failure, atomic replay mismatch and aggregate attachment digest", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token);
  const badType = await h.worker.fetch(
    new Request("https://centre.test/v1/records", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(mutation()),
    }),
    h.env,
  );
  assert.equal(badType.status, 400);
  assert.equal(
    (await h.call("/v1/records", "POST", "{broken", token)).status,
    400,
  );
  await h.call("/v1/extension", "GET", undefined, token);
  const context = h.context();
  assert.ok(context);
  const m = mutation("same-id");
  await assert.rejects(
    context.entities.commit([
      m,
      { ...m, data: { ...m.data, name: "different" } },
    ]),
  );
  assert.equal(await context.entities.get("topic", "same-id"), null);
  const id = crypto.randomUUID(),
    content = new Uint8Array(256 * 1024 + 3).fill(97);
  const binary = (data: Uint8Array) =>
    Array.from(data, (n) => String.fromCharCode(n)).join("");
  await h.call(
    "/v1/attachments/" + id,
    "PUT",
    {
      name: "chunks.bin",
      mimeType: "application/octet-stream",
      size: content.length,
      sha256: "0".repeat(64),
      ...(await seedAttachmentOwner(h, token, id)),
    },
    token,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0",
        "PUT",
        { data: btoa(binary(content.subarray(0, 256 * 1024))) },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/1",
        "PUT",
        { data: btoa("aaa") },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/complete",
        "POST",
        { mutationId: crypto.randomUUID() },
        token,
      )
    ).status,
    400,
  );
  assert.equal(await context.entities.get("attachment", id), null);
  h.env.DB = {
    prepare() {
      throw new Error("D1 service unavailable");
    },
    async batch() {
      throw new Error("D1 service unavailable");
    },
  };
  assert.equal(
    (await h.call("/v1/bootstrap", "GET", undefined, token)).status,
    503,
  );
});
test("daily ceilings apply globally and by workspace while receipt replay remains free", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    b = await h.login("bob"),
    token = String(a.token),
    m = mutation("daily");
  assert.equal((await h.call("/v1/records", "POST", m, token)).status, 200);
  h.db.sqlite
    .prepare("UPDATE centre_daily SET count=1000 WHERE key='mutations:global'")
    .run();
  assert.equal(
    (await h.call("/v1/records", "POST", mutation("blocked"), String(b.token)))
      .status,
    429,
  );
  assert.equal((await h.call("/v1/records", "POST", m, token)).status, 200);
  h.db.sqlite
    .prepare("UPDATE centre_daily SET count=1000 WHERE key=?")
    .run("requests:" + String(a.workspaceId));
  assert.equal(
    (await h.call("/v1/bootstrap", "GET", undefined, token)).status,
    429,
  );
  h.db.sqlite
    .prepare("UPDATE centre_daily SET count=5000 WHERE key='requests:global'")
    .run();
  assert.equal(
    (await h.call("/v1/bootstrap", "GET", undefined, String(b.token))).status,
    429,
  );
});
test("revocation invalidates issuer pairing and attachment tombstones release bytes without resurrection", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token);
  const pairing = await h.call("/v1/pairings", "POST", {}, token);
  await h.call("/v1/devices/revoke", "POST", { deviceId: a.deviceId }, token);
  assert.equal(
    (
      await h.call("/v1/auth/pair", "POST", {
        code: pairing.value.code,
        deviceName: "denied",
      })
    ).status,
    401,
  );
  const b = await h.login("bob"),
    bt = String(b.token),
    id = crypto.randomUUID(),
    metadata = {
      name: "tiny",
      mimeType: "text/plain",
      size: 1,
      sha256: await sha256("a"),
      ...(await seedAttachmentOwner(h, bt, id)),
    };
  await h.call("/v1/attachments/" + id, "PUT", metadata, bt);
  await h.call(
    "/v1/attachments/" + id + "/chunks/0",
    "PUT",
    { data: btoa("a") },
    bt,
  );
  const completion = { mutationId: crypto.randomUUID() },
    result = await h.call(
      "/v1/attachments/" + id + "/complete",
      "POST",
      completion,
      bt,
    );
  assert.equal(result.status, 200);
  const tombstone = {
    mutationId: crypto.randomUUID(),
    kind: "attachment",
    id,
    schemaVersion: 1,
    expectedVersion: 1,
    deleted: true,
    data: null,
  };
  assert.equal(
    (await h.call("/v1/records", "POST", tombstone, bt)).status,
    200,
  );
  assert.deepEqual(
    await h.call("/v1/attachments/" + id + "/complete", "POST", completion, bt),
    result,
  );
  assert.equal(
    h.db.sqlite
      .prepare("SELECT count(*) AS count FROM centre_chunk WHERE id=?")
      .get(id)?.count,
    0,
  );
  assert.equal(
    h.db.sqlite
      .prepare(
        "SELECT attachment_bytes FROM centre_workspace_usage WHERE workspace=?",
      )
      .get(String(b.workspaceId))?.attachment_bytes,
    0,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          mutationId: crypto.randomUUID(),
          kind: "attachment",
          id,
          schemaVersion: 1,
          expectedVersion: 2,
          deleted: false,
          data: object(result.value.record).data,
        },
        bt,
      )
    ).status,
    409,
  );
  assert.equal(
    (await h.call("/v1/attachments/" + id, "PUT", metadata, bt)).status,
    404,
  );
});
test("learner-memory restoration cannot bypass the active-record quota", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token);
  await h.call("/v1/extension", "GET", undefined, token);
  const context = h.context();
  assert.ok(context);
  const memory = (id: string, expectedVersion = 0): CloudMutation => ({
    mutationId: crypto.randomUUID(),
    kind: "learnerMemory",
    id,
    schemaVersion: 1,
    expectedVersion,
    deleted: false,
    data: {
      id,
      key: id,
      content: "memory",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
    },
  });
  const mutations = Array.from({ length: 50 }, () =>
    memory(crypto.randomUUID()),
  );
  await context.entities.commit(mutations);
  const first = mutations[0];
  await context.entities.put({
    ...first,
    mutationId: crypto.randomUUID(),
    expectedVersion: 1,
    deleted: true,
    data: null,
  });
  await context.entities.put(memory(crypto.randomUUID()));
  await assert.rejects(context.entities.put(memory(first.id, 2)));
  assert.equal(
    h.db.sqlite
      .prepare(
        "SELECT count(*) AS count FROM centre_record WHERE kind='learnerMemory' AND deleted=0",
      )
      .get()?.count,
    50,
  );
});
test("learning-need quota retains all 500 records while permitting existing-record updates", async () => {
  const h = await harness(),
    a = await h.login("alice");
  await h.call("/v1/extension", "GET", undefined, String(a.token));
  const context = h.context();
  assert.ok(context);
  const time = "2026-10-22T00:00:00.000Z";
  const need = (
    id: string,
    concept: string,
    expectedVersion = 0,
    deletedAt: string | null = null,
  ): CloudMutation => ({
    mutationId: crypto.randomUUID(),
    kind: "practice.learningNeed",
    id,
    schemaVersion: 1,
    expectedVersion,
    deleted: false,
    data: {
      schemaVersion: 1,
      id,
      revision: expectedVersion + 1,
      subjectId: null,
      topicId: null,
      conceptKey: concept,
      conceptLabel: concept,
      needScore: 1,
      evidence: [],
      createdAt: time,
      updatedAt: time,
      deletedAt,
    },
  });
  const records = Array.from({ length: 500 }, (_, index) =>
    need(crypto.randomUUID(), "concept-" + index),
  );
  for (let index = 0; index < 500; index += 50)
    await context.entities.commit(records.slice(index, index + 50));
  h.setTime(Date.parse("2026-10-23T00:00:00Z"));
  const first = records[0];
  await context.entities.put({
    ...first,
    mutationId: crypto.randomUUID(),
    expectedVersion: 1,
    deleted: true,
    data: null,
  });
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        need(crypto.randomUUID(), "replacement"),
        String(a.token),
      )
    ).status,
    413,
  );
  await context.entities.put(need(first.id, "concept-0", 2));
  const second = records[1];
  await context.entities.put(need(second.id, "concept-1", 1, time));
  await assert.rejects(
    context.entities.put(need(crypto.randomUUID(), "replacement-2")),
  );
  await context.entities.put(need(second.id, "concept-1", 2));
  assert.equal(
    h.db.sqlite
      .prepare(
        "SELECT count(*) AS count FROM centre_record WHERE kind='practice.learningNeed'",
      )
      .get()?.count,
    500,
  );
});
test("trusted history helpers are bounded and workspace filtered; expired devices do not lock future login", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    b = await h.login("bob"),
    token = String(a.token);
  await h.call("/v1/extension", "GET", undefined, token);
  const context = h.context();
  assert.ok(context);
  await seedAttachmentOwner(h, token, crypto.randomUUID(), "chat");
  const messages: CloudMutation[] = Array.from({ length: 25 }, (_, index) => ({
    mutationId: crypto.randomUUID(),
    kind: "message",
    id: "message-" + index,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id: "message-" + index,
      chatId: "chat",
      role: "user",
      content: "message " + index,
      requestContext: null,
      createdAt: new Date(
        Date.parse("2026-10-22T00:00:00Z") + index * 1000,
      ).toISOString(),
    },
  }));
  await context.entities.commit(messages);
  await context.entities.put({
    ...messages[0],
    mutationId: crypto.randomUUID(),
    id: "other-chat",
    data: { ...messages[0].data, id: "other-chat", chatId: "other" },
  });
  const latest = await context.entities.listMessages("chat");
  assert.equal(latest.length, 20);
  assert.equal(latest[0].id, "message-5");
  assert.equal(latest.at(-1)?.id, "message-24");
  await assert.rejects(context.entities.listMessages("chat", 21));
  assert.deepEqual(await context.entities.listLearningNeeds(), []);
  await h.call("/v1/extension", "GET", undefined, String(b.token));
  assert.deepEqual(await h.context()?.entities.listMessages("chat"), []);
  const insert = h.db.sqlite.prepare(
    "INSERT INTO centre_device(id,workspace,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)",
  );
  for (let index = 0; index < 99; index++)
    insert.run(
      crypto.randomUUID(),
      String(a.workspaceId),
      "expired-" + index,
      "old",
      "2020-01-01T00:00:00Z",
      "2020-01-02T00:00:00Z",
    );
  assert.equal(
    h.db.sqlite
      .prepare("SELECT count(*) AS count FROM centre_device WHERE workspace=?")
      .get(String(a.workspaceId))?.count,
    100,
  );
  assert.ok((await h.login("alice")).token);
  assert.equal(
    h.db.sqlite
      .prepare("SELECT count(*) AS count FROM centre_device WHERE workspace=?")
      .get(String(a.workspaceId))?.count,
    2,
  );
});
test("same-week study goals conflict across devices, release on tombstone and report the winner after SQL races", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    secondDevice = await h.login("alice"),
    token = String(a.token),
    otherToken = String(secondDevice.token);
  const goal = (
    id: string,
    weekStart = "2026-10-19",
    expectedVersion = 0,
  ): CloudMutation => ({
    mutationId: crypto.randomUUID(),
    kind: "studyGoal",
    id,
    schemaVersion: 1,
    expectedVersion,
    deleted: false,
    data: {
      schemaVersion: 1,
      id,
      revision: expectedVersion + 1,
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      deletedAt: null,
      weekStart,
      timeZone: "Australia/Sydney",
      targetMinutes: 120,
    },
  });
  const first = goal(crypto.randomUUID()),
    challenger = goal(crypto.randomUUID());
  const saved = await h.call("/v1/records", "POST", first, token);
  assert.equal(saved.status, 200);
  const conflict = await h.call("/v1/records", "POST", challenger, otherToken);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.value.current, saved.value.record);
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          ...first,
          mutationId: crypto.randomUUID(),
          expectedVersion: 1,
          deleted: true,
          data: null,
        },
        token,
      )
    ).status,
    200,
  );
  const replacement = await h.call(
    "/v1/records",
    "POST",
    challenger,
    otherToken,
  );
  assert.equal(replacement.status, 200);
  const restore = await h.call(
    "/v1/records",
    "POST",
    goal(first.id, "2026-10-19", 2),
    token,
  );
  assert.equal(restore.status, 409);
  assert.deepEqual(restore.value.current, replacement.value.record);
  const winner = goal(crypto.randomUUID(), "2026-10-26"),
    racing = goal(crypto.randomUUID(), "2026-10-26");
  const base = h.env.DB;
  let inject = true;
  h.env.DB = {
    prepare: (sql) => base.prepare(sql),
    async batch(statements) {
      if (inject) {
        inject = false;
        await base.batch([
          base
            .prepare(
              "INSERT INTO centre_mutation(workspace,mutation_id,body_hash,kind,id,expected_version,updated_at,deleted,data) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              String(a.workspaceId),
              winner.mutationId,
              "race-winner",
              winner.kind,
              winner.id,
              0,
              "2026-10-22T00:00:00.000Z",
              0,
              JSON.stringify(winner.data),
            ),
        ]);
      }
      return base.batch(statements);
    },
  };
  const raced = await h.call("/v1/records", "POST", racing, token);
  assert.equal(raced.status, 409);
  assert.equal(object(raced.value.current).id, winner.id);
  const changes = await h.call("/v1/changes", "GET", undefined, token);
  assert.equal(
    (changes.value.records as unknown[])
      .map(object)
      .some((record) => record.id === racing.id),
    false,
  );
});
test("learning-need concept conflicts report the scoped winner across devices and SQL races", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    other = await h.login("alice"),
    b = await h.login("bob"),
    token = String(a.token);
  const need = (
    id: string,
    conceptKey = "fractions",
    subjectId: string | null = null,
    topicId: string | null = null,
    expectedVersion = 0,
  ): CloudMutation => ({
    mutationId: crypto.randomUUID(),
    kind: "practice.learningNeed",
    id,
    schemaVersion: 1,
    expectedVersion,
    deleted: false,
    data: {
      schemaVersion: 1,
      id,
      revision: expectedVersion + 1,
      subjectId,
      topicId,
      conceptKey,
      conceptLabel: conceptKey,
      needScore: 3,
      evidence: [],
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      deletedAt: null,
    },
  });
  const first = need(crypto.randomUUID()),
    challenger = need(crypto.randomUUID());
  const saved = await h.call("/v1/records", "POST", first, token);
  assert.equal(saved.status, 200);
  const conflict = await h.call(
    "/v1/records",
    "POST",
    challenger,
    String(other.token),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.value.current, saved.value.record);
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        need(crypto.randomUUID(), "fractions", "math", "algebra"),
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        need(crypto.randomUUID()),
        String(b.token),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          ...first,
          mutationId: crypto.randomUUID(),
          expectedVersion: 1,
          deleted: true,
          data: null,
        },
        token,
      )
    ).status,
    200,
  );
  const replacement = await h.call(
    "/v1/records",
    "POST",
    challenger,
    String(other.token),
  );
  assert.equal(replacement.status, 200);
  const restore = await h.call(
    "/v1/records",
    "POST",
    need(first.id, "fractions", null, null, 2),
    token,
  );
  assert.equal(restore.status, 409);
  assert.deepEqual(restore.value.current, replacement.value.record);
  const winner = need(crypto.randomUUID(), "race", "science", "physics"),
    racing = need(crypto.randomUUID(), "race", "science", "physics"),
    base = h.env.DB;
  let inject = true;
  h.env.DB = {
    prepare: (sql) => base.prepare(sql),
    async batch(statements) {
      if (inject) {
        inject = false;
        await base.batch([
          base
            .prepare(
              "INSERT INTO centre_mutation(workspace,mutation_id,body_hash,kind,id,expected_version,updated_at,deleted,data) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              String(a.workspaceId),
              winner.mutationId,
              "race-winner",
              winner.kind,
              winner.id,
              0,
              "2026-10-22T00:00:00.000Z",
              0,
              JSON.stringify(winner.data),
            ),
        ]);
      }
      return base.batch(statements);
    },
  };
  const raced = await h.call("/v1/records", "POST", racing, token);
  assert.equal(raced.status, 409);
  assert.equal(object(raced.value.current).id, winner.id);
  assert.equal(
    h.db.sqlite
      .prepare(
        "SELECT count(*) AS count FROM centre_record WHERE workspace=? AND id=?",
      )
      .get(String(a.workspaceId), racing.id)?.count,
    0,
  );
});
test("checklist progress requires the canonical resource/document UUID and converges across devices", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    other = await h.login("alice"),
    token = String(a.token),
    documentRevision = await sha256("checklist document"),
    id = await interactiveResourceProgressId("resource", documentRevision);
  const progress: CloudMutation = {
    mutationId: crypto.randomUUID(),
    kind: "interactiveProgress",
    id,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      schemaVersion: 1,
      id,
      revision: 1,
      resourceId: "resource",
      documentRevision,
      checkedItemIds: ["first"],
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      deletedAt: null,
    },
  };
  const wrongId = crypto.randomUUID();
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        { ...progress, id: wrongId, data: { ...progress.data, id: wrongId } },
        token,
      )
    ).status,
    400,
  );
  const saved = await h.call("/v1/records", "POST", progress, token);
  assert.equal(saved.status, 200);
  assert.equal(object(saved.value.record).id, id);
  const conflict = await h.call(
    "/v1/records",
    "POST",
    {
      ...progress,
      mutationId: crypto.randomUUID(),
      data: { ...progress.data, checkedItemIds: ["second"] },
    },
    String(other.token),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.value.current, saved.value.record);
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          ...progress,
          mutationId: crypto.randomUUID(),
          expectedVersion: 1,
          data: {
            ...progress.data,
            documentRevision: await sha256("different document"),
          },
        },
        token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          ...progress,
          mutationId: crypto.randomUUID(),
          expectedVersion: 1,
          data: { ...progress.data, resourceId: "different resource" },
        },
        token,
      )
    ).status,
    400,
  );
});
test("attachment reads enforce immutable owner ancestry through archived parents across devices and accounts", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    replica = await h.login("alice"),
    foreign = await h.login("bob"),
    token = String(a.token),
    id = crypto.randomUUID(),
    time = "2026-10-22T00:00:00.000Z";
  const parent = {
      id: "parent",
      title: "Parent",
      createdAt: time,
      updatedAt: time,
      deletedAt: null,
    },
    child = {
      id: "child",
      title: "Child",
      createdAt: time,
      updatedAt: time,
      deletedAt: null,
      lineage: {
        schemaVersion: 1,
        kind: "branch",
        operation: "continue",
        parentChatId: "parent",
        sourceMessageId: "parent-answer",
        checkpointMessageId: "parent-answer",
        promptMessageId: null,
      },
    };
  const write = (
    kind: string,
    id: string,
    data: Record<string, unknown> | null,
    expectedVersion = 0,
    deleted = false,
  ) =>
    h.call(
      "/v1/records",
      "POST",
      {
        mutationId: crypto.randomUUID(),
        kind,
        id,
        schemaVersion: 1,
        expectedVersion,
        deleted,
        data,
      },
      token,
    );
  assert.equal((await write("chat", "parent", parent)).status, 200);
  assert.equal((await write("chat", "child", child)).status, 200);
  const user = {
      id: "parent-prompt",
      chatId: "parent",
      role: "user",
      content: "Attachment",
      createdAt: time,
      attachmentIds: [id],
      resourceIds: [],
      requestContext: null,
    },
    assistant = {
      id: "parent-answer",
      chatId: "parent",
      role: "assistant",
      content: "Done",
      createdAt: time,
      attachmentIds: [],
      resourceIds: [],
      requestContext: null,
    };
  const promptSaved = await write("message", user.id, user);
  assert.equal(promptSaved.status, 200);
  assert.equal((await write("message", assistant.id, assistant)).status, 200);
  assert.equal(
    (
      await write("message", "child-prompt", {
        ...user,
        id: "child-prompt",
        chatId: "child",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await write("message", "child-answer", {
        ...assistant,
        id: "child-answer",
        chatId: "child",
      })
    ).status,
    200,
  );
  const metadata = {
    name: "file.txt",
    mimeType: "text/plain",
    size: 1,
    sha256: await sha256("a"),
    sourceChatId: "parent",
    chatId: "parent",
  };
  assert.equal(
    (await h.call("/v1/attachments/" + id, "PUT", metadata, token)).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0",
        "PUT",
        { data: btoa("a") },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/complete",
        "POST",
        { mutationId: crypto.randomUUID() },
        token,
      )
    ).status,
    200,
  );
  const updatedPrompt = await write(
    "message",
    user.id,
    { ...user, responseDurationMs: 1 },
    1,
  );
  assert.equal(updatedPrompt.status, 200);
  assert.equal(
    object(updatedPrompt.value.record).createdCursor,
    object(promptSaved.value.record).createdCursor,
  );
  assert.notEqual(
    object(updatedPrompt.value.record).cursor,
    object(promptSaved.value.record).cursor,
  );
  const archive = { ...parent, deletedAt: time };
  assert.equal((await write("chat", "parent", archive, 1)).status, 200);
  const changes = await h.call(
      "/v1/changes",
      "GET",
      undefined,
      String(replica.token),
    ),
    records = (changes.value.records as unknown[]).map(object);
  const retainedParent = records.find(
    (record) => record.kind === "chat" && record.id === "parent",
  );
  assert.ok(retainedParent);
  assert.equal(retainedParent.deleted, false);
  assert.equal(object(retainedParent.data).deletedAt, time);
  assert.ok(records.some((record) => record.id === user.id));
  assert.ok(records.some((record) => record.id === assistant.id));
  const freshParentMessages = records
    .filter(
      (record) =>
        record.kind === "message" && object(record.data).chatId === "parent",
    )
    .sort((left, right) => {
      const a = object(left.data),
        b = object(right.data);
      return (
        String(a.createdAt).localeCompare(String(b.createdAt)) ||
        (BigInt(String(left.createdCursor)) <
        BigInt(String(right.createdCursor))
          ? -1
          : 1)
      );
    });
  assert.deepEqual(
    freshParentMessages.map((record) => record.id),
    [user.id, assistant.id],
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "?chatId=child",
        "GET",
        undefined,
        String(replica.token),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "/chunks/0?chatId=child",
        "GET",
        undefined,
        String(replica.token),
      )
    ).value.data,
    btoa("a"),
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "?chatId=parent",
        "GET",
        undefined,
        token,
      )
    ).status,
    404,
  );
  assert.equal(
    (await h.call("/v1/attachments/" + id, "GET", undefined, token)).status,
    404,
  );
  await seedAttachmentOwner(h, token, id, "unrelated");
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "?chatId=unrelated",
        "GET",
        undefined,
        token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id,
        "PUT",
        { ...metadata, sourceChatId: "unrelated", chatId: "unrelated" },
        token,
      )
    ).status,
    409,
  );
  await seedAttachmentOwner(h, String(foreign.token), id, "child");
  assert.equal(
    (
      await h.call(
        "/v1/attachments/" + id + "?chatId=child",
        "GET",
        undefined,
        String(foreign.token),
      )
    ).status,
    404,
  );
  assert.equal((await write("chat", "parent", null, 2, true)).status, 409);
  assert.equal(
    (await write("chat", "child", { ...child, deletedAt: time }, 1)).status,
    200,
  );
  assert.equal((await write("chat", "parent", null, 2, true)).status, 409);
  assert.equal(
    h.db.sqlite
      .prepare(
        "SELECT owner_chat_id FROM centre_attachment WHERE workspace=? AND id=?",
      )
      .get(String(a.workspaceId), id)?.owner_chat_id,
    "parent",
  );
});
test("trusted assistant writes atomically reject archive races without blocking historical replica messages", async () => {
  const h = await harness({
      extension: async (request, context) => {
        if (new URL(request.url).pathname !== "/v1/test/assistant") return null;
        return Response.json({
          record: await context.entities.putMessage(
            cloudMutationSchema.parse(await request.json()),
            "guard-chat",
          ),
        });
      },
    }),
    a = await h.login("alice"),
    token = String(a.token);
  await seedAttachmentOwner(h, token, crypto.randomUUID(), "guard-chat");
  const assistant = (id: string): CloudMutation => ({
    mutationId: crypto.randomUUID(),
    kind: "message",
    id,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id,
      chatId: "guard-chat",
      role: "assistant",
      content: "Answer",
      createdAt: "2026-10-22T00:00:01.000Z",
      requestContext: null,
    },
  });
  assert.equal(
    (
      await h.call(
        "/v1/test/assistant",
        "POST",
        assistant("active-answer"),
        token,
      )
    ).status,
    200,
  );
  const base = h.env.DB;
  let inject = true;
  h.env.DB = {
    prepare: (sql) => base.prepare(sql),
    async batch(statements) {
      if (inject) {
        inject = false;
        const row = object(
          h.db.sqlite
            .prepare(
              "SELECT data FROM centre_record WHERE workspace=? AND kind='chat' AND id='guard-chat'",
            )
            .get(String(a.workspaceId)),
        );
        const chat = object(JSON.parse(String(row.data)));
        assert.equal(
          (
            await h.call(
              "/v1/records",
              "POST",
              {
                mutationId: crypto.randomUUID(),
                kind: "chat",
                id: "guard-chat",
                schemaVersion: 1,
                expectedVersion: 1,
                deleted: false,
                data: { ...chat, deletedAt: "2026-10-22T00:01:00.000Z" },
              },
              token,
            )
          ).status,
          200,
        );
      }
      return base.batch(statements);
    },
  };
  const raced = await h.call(
    "/v1/test/assistant",
    "POST",
    assistant("blocked-answer"),
    token,
  );
  assert.equal(raced.status, 409);
  assert.equal(object(raced.value.error).code, "conflict");
  assert.equal(
    h.db.sqlite
      .prepare(
        "SELECT count(*) AS count FROM centre_record WHERE id='blocked-answer'",
      )
      .get()?.count,
    0,
  );
  assert.equal(
    h.db.sqlite
      .prepare("SELECT count(*) AS count FROM centre_active_chat_guard")
      .get()?.count,
    0,
  );
  assert.equal(
    (await h.call("/v1/records", "POST", assistant("historical-answer"), token))
      .status,
    200,
  );
  assert.deepEqual(await h.context()?.entities.listMessages("guard-chat"), []);
});
function reviewNeed(id: string, score = 10): CloudMutation {
  return {
    mutationId: crypto.randomUUID(),
    kind: "practice.learningNeed",
    id,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      schemaVersion: 1,
      id,
      revision: 1,
      subjectId: null,
      topicId: null,
      conceptKey: id,
      conceptLabel: "Concept",
      needScore: score,
      evidence: [],
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      deletedAt: null,
    },
  };
}
function reviewMemory(
  id: string,
  learningNeedId: string | null,
): CloudMutation {
  return {
    mutationId: crypto.randomUUID(),
    kind: "reviewMemory",
    id,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id,
      learningNeedId,
      subjectId: null,
      topicId: null,
      resourceId: "quiz",
      question: "Question",
      note: "Review",
      createdAt: "2026-10-22T00:00:00.000Z",
      nextReviewAt: "2026-10-23T00:00:00.000Z",
      resolvedAt: null,
    },
  };
}
test("review resolution atomically applies linked canonical evidence, replays original results and isolates two workspaces", async () => {
  const h = await harness({
      extension: async (request, context) =>
        new URL(request.url).pathname === "/v1/test/review"
          ? Response.json({
              records: await context.entities.resolveReview(
                cloudMutationSchema.parse(await request.json()),
              ),
            })
          : null,
    }),
    a = await h.login("alice"),
    b = await h.login("bob"),
    token = String(a.token),
    needId = crypto.randomUUID(),
    otherNeedId = crypto.randomUUID(),
    memoryId = crypto.randomUUID();
  const initial = reviewNeed(needId);
  initial.data = {
    ...initial.data,
    evidence: Array.from({ length: 8 }, (_, index) => ({
      id: crypto.randomUUID(),
      source: "grade",
      attemptId: crypto.randomUUID(),
      resourceId: "quiz",
      questionId: "q" + index,
      outcome: "incorrect",
      score: 0,
      maxScore: 1,
      feedback: "Practice",
      recordedAt: "2026-10-22T00:00:00.000Z",
    })),
  };
  assert.equal(
    (await h.call("/v1/records", "POST", initial, token)).status,
    200,
  );
  assert.equal(
    (await h.call("/v1/records", "POST", reviewNeed(otherNeedId), token))
      .status,
    200,
  );
  const memory = reviewMemory(memoryId, needId);
  assert.equal(
    (await h.call("/v1/records", "POST", memory, token)).status,
    200,
  );
  const resolution = {
    ...memory,
    mutationId: crypto.randomUUID(),
    expectedVersion: 1,
    data: {
      ...memory.data,
      learningNeedId: otherNeedId,
      resolvedAt: "2026-10-22T00:01:00.000Z",
    },
  };
  const saved = await h.call("/v1/records", "POST", resolution, token);
  assert.equal(saved.status, 200);
  assert.equal(object(saved.value.record).version, 2);
  assert.equal(object(object(saved.value.record).data).learningNeedId, needId);
  await h.call("/v1/extension", "GET", undefined, token);
  const entities = h.context()?.entities;
  assert.ok(entities);
  const updated = await entities.get("practice.learningNeed", needId);
  assert.ok(updated?.data);
  assert.equal(updated.data.needScore, 8);
  assert.equal((updated.data.evidence as unknown[]).length, 8);
  assert.equal(
    object((updated.data.evidence as unknown[]).at(-1)).memoryId,
    memoryId,
  );
  assert.equal(
    (await entities.get("practice.learningNeed", otherNeedId))?.data?.needScore,
    10,
  );
  const hook = await h.call("/v1/test/review", "POST", resolution, token);
  assert.equal(hook.status, 200);
  const originalRecords = (hook.value.records as unknown[]).map(object);
  assert.equal(originalRecords.length, 2);
  assert.equal(originalRecords[1].version, 2);
  await entities.put({
    ...reviewNeed(needId),
    expectedVersion: 2,
    data: { ...updated.data, revision: 3, needScore: 4 },
  });
  const editedMemory = {
    ...resolution,
    mutationId: crypto.randomUUID(),
    expectedVersion: 2,
    data: { ...object(saved.value.record).data, note: "Later edit" },
  };
  assert.equal(
    (await h.call("/v1/records", "POST", editedMemory, token)).status,
    200,
  );
  assert.deepEqual(
    await h.call("/v1/records", "POST", resolution, token),
    saved,
  );
  assert.deepEqual(
    await h.call("/v1/test/review", "POST", resolution, token),
    hook,
  );
  assert.equal(
    (await entities.get("practice.learningNeed", needId))?.data?.needScore,
    4,
  );
  assert.equal(
    (await h.call("/v1/records", "POST", reviewNeed(needId), String(b.token)))
      .status,
    200,
  );
  assert.equal(
    (await h.call("/v1/records", "POST", memory, String(b.token))).status,
    200,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          ...resolution,
          data: { ...memory.data, resolvedAt: "2026-10-22T00:01:00.000Z" },
        },
        String(b.token),
      )
    ).status,
    200,
  );
  await h.call("/v1/extension", "GET", undefined, String(b.token));
  assert.equal(
    (await h.context()?.entities.get("practice.learningNeed", needId))?.data
      ?.needScore,
    8,
  );
  assert.equal(
    (await entities.get("practice.learningNeed", needId))?.data?.needScore,
    4,
  );
  assert.equal(
    h.db.sqlite
      .prepare("SELECT count(*) AS count FROM centre_review_guard")
      .get()?.count,
    0,
  );
});
test("review linked-need CAS races roll back the memory and permit exact failed-request retry", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token),
    needId = crypto.randomUUID(),
    memory = reviewMemory(crypto.randomUUID(), needId);
  await h.call("/v1/records", "POST", reviewNeed(needId), token);
  await h.call("/v1/records", "POST", memory, token);
  const resolution = {
    ...memory,
    mutationId: crypto.randomUUID(),
    expectedVersion: 1,
    data: { ...memory.data, resolvedAt: "2026-10-22T00:01:00.000Z" },
  };
  const base = h.env.DB;
  let inject = true;
  h.env.DB = {
    prepare: (sql) => base.prepare(sql),
    async batch(statements) {
      if (inject) {
        inject = false;
        const need = reviewNeed(needId);
        assert.equal(
          (
            await h.call(
              "/v1/records",
              "POST",
              {
                ...need,
                expectedVersion: 1,
                data: { ...need.data, revision: 2, needScore: 9 },
              },
              token,
            )
          ).status,
          200,
        );
      }
      return base.batch(statements);
    },
  };
  const failed = await h.call("/v1/records", "POST", resolution, token);
  assert.equal(failed.status, 409);
  assert.equal(object(object(failed.value.current).data).resolvedAt, null);
  assert.equal(
    h.db.sqlite
      .prepare(
        "SELECT count(*) AS count FROM centre_mutation WHERE workspace=? AND mutation_id=?",
      )
      .get(String(a.workspaceId), resolution.mutationId)?.count,
    0,
  );
  const retry = await h.call("/v1/records", "POST", resolution, token);
  assert.equal(retry.status, 200);
  await h.call("/v1/extension", "GET", undefined, token);
  assert.equal(
    (await h.context()?.entities.get("practice.learningNeed", needId))?.data
      ?.needScore,
    7,
  );
});
test("Review skips null or missing links, already-resolved memory and trusted grade-cleanup commits", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token),
    needId = crypto.randomUUID();
  await h.call("/v1/records", "POST", reviewNeed(needId, 5), token);
  await h.call("/v1/extension", "GET", undefined, token);
  const entities = h.context()?.entities;
  assert.ok(entities);
  for (const link of [null, crypto.randomUUID()]) {
    const memory = reviewMemory(crypto.randomUUID(), link);
    await h.call("/v1/records", "POST", memory, token);
    assert.equal(
      (
        await h.call(
          "/v1/records",
          "POST",
          {
            ...memory,
            mutationId: crypto.randomUUID(),
            expectedVersion: 1,
            data: { ...memory.data, resolvedAt: "2026-10-22T00:01:00.000Z" },
          },
          token,
        )
      ).status,
      200,
    );
  }
  const memory = reviewMemory(crypto.randomUUID(), needId);
  await h.call("/v1/records", "POST", memory, token);
  await entities.commit([
    {
      ...memory,
      mutationId: crypto.randomUUID(),
      expectedVersion: 1,
      data: { ...memory.data, resolvedAt: "2026-10-22T00:01:00.000Z" },
    },
  ]);
  assert.equal(
    (await entities.get("practice.learningNeed", needId))?.data?.needScore,
    5,
  );
  assert.equal(
    (
      await h.call(
        "/v1/records",
        "POST",
        {
          ...memory,
          mutationId: crypto.randomUUID(),
          expectedVersion: 2,
          data: { ...memory.data, resolvedAt: "2026-10-22T00:02:00.000Z" },
        },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await entities.get("practice.learningNeed", needId))?.data?.needScore,
    5,
  );
});
test("concurrent exact Review retry returns the first result without applying evidence twice", async () => {
  const h = await harness(),
    a = await h.login("alice"),
    token = String(a.token),
    needId = crypto.randomUUID(),
    memory = reviewMemory(crypto.randomUUID(), needId);
  await h.call("/v1/records", "POST", reviewNeed(needId), token);
  await h.call("/v1/records", "POST", memory, token);
  const resolution = {
    ...memory,
    mutationId: crypto.randomUUID(),
    expectedVersion: 1,
    data: { ...memory.data, resolvedAt: "2026-10-22T00:01:00.000Z" },
  };
  const base = h.env.DB;
  let inject = true;
  let first: { status: number; value: Record<string, unknown> } | undefined;
  h.env.DB = {
    prepare: (sql) => base.prepare(sql),
    async batch(statements) {
      if (inject) {
        inject = false;
        first = await h.call("/v1/records", "POST", resolution, token);
        assert.equal(first.status, 200);
      }
      return base.batch(statements);
    },
  };
  const retry = await h.call("/v1/records", "POST", resolution, token);
  assert.deepEqual(retry, first);
  await h.call("/v1/extension", "GET", undefined, token);
  const need = await h.context()?.entities.get("practice.learningNeed", needId);
  assert.equal(need?.data?.needScore, 8);
  assert.equal((need?.data?.evidence as unknown[]).length, 1);
});
