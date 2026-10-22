import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import {
  CLOUD_LIMITS,
  cloudMutationSchema,
  type CloudMutation,
  type CloudRecord,
} from "../shared/cloud";
import {
  CLOUD_ENTITY_KINDS,
  cloudAttachmentSchema,
  parseCloudEntity,
} from "../shared/cloud-entities";
import {
  interactiveResourceProgressId,
  interactiveResourceProgressSchema,
  mergeInteractiveResourceProgress,
} from "../shared/checklist-progress";
import {
  canShareChatAttachment,
  type ScopedChatLineage,
} from "../shared/chat-lineage";
import {
  chatSchema,
  messageSchema,
  memorySchema,
  type Chat,
} from "../shared/schema";
import { applyReviewEvidence, learningNeedSchema } from "../shared/practice";
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
export interface Env {
  DB: Database;
  GOOGLE_CLIENT_IDS?: string;
  GOOGLE_ALLOWED_SUBJECTS?: string;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  ORGANATO_ENCRYPTION_KEYS_JSON?: string;
  ORGANATO_KEY_VERSION?: string;
  ORGANATO_ALLOWED_ORIGINS?: string;
}
export interface Auth {
  workspaceId: string;
  deviceId: string;
}
export interface EntityStore {
  get(kind: string, id: string): Promise<CloudRecord | null>;
  put(mutation: CloudMutation): Promise<CloudRecord>;
  putMessage(mutation: CloudMutation, chatId: string): Promise<CloudRecord>;
  commit(mutations: CloudMutation[]): Promise<CloudRecord[]>;
  resolveReview(mutation: CloudMutation): Promise<CloudRecord[]>;
  getPracticeAttempt(sourceDraftId: string): Promise<CloudRecord | null>;
  listMessages(chatId: string, limit?: number): Promise<CloudRecord[]>;
  listLearningNeeds(): Promise<CloudRecord[]>;
}
export interface ExtensionContext {
  env: Env;
  auth: Auth;
  entities: EntityStore;
}
export interface WorkerOptions {
  googleKeyResolver?: JWTVerifyGetKey;
  now?: () => number;
  extension?: (
    request: Request,
    context: ExtensionContext,
  ) => Promise<Response | null>;
}
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public current?: CloudRecord | null,
  ) {
    super(message);
  }
}
function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}
const bytes = (s: string) => new TextEncoder().encode(s);
export async function sha256(value: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof value === "string" ? bytes(value) : new Uint8Array(value),
  );
  return Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
function secret(prefix = "") {
  return (
    prefix +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join("")
  );
}
const rowSchema = z.object({
  kind: z.string(),
  id: z.string(),
  version: z.number(),
  cursor: z.union([z.string(), z.number()]),
  created_cursor: z.union([z.string(), z.number()]).nullable().optional(),
  updated_at: z.string(),
  deleted: z.number(),
  data: z.string().nullable(),
});
function record(row: unknown): CloudRecord {
  const r = rowSchema.parse(row);
  return {
    kind: r.kind,
    id: r.id,
    schemaVersion: 1,
    version: r.version,
    cursor: String(r.cursor),
    createdCursor: String(r.created_cursor ?? r.cursor),
    updatedAt: r.updated_at,
    deleted: Boolean(r.deleted),
    data:
      r.data === null
        ? null
        : z.record(z.string(), z.unknown()).parse(JSON.parse(r.data)),
  };
}
async function body(
  request: Request,
  max = CLOUD_LIMITS.recordBytes,
): Promise<{ value: unknown; raw: string }> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    fail(400, "validation", "Use application/json.");
  if (Number(request.headers.get("Content-Length") ?? 0) > max)
    fail(413, "bounds", "Request is too large.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > max) {
        await reader.cancel();
        fail(413, "bounds", "Request is too large.");
      }
      chunks.push(next.value);
    }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { value: JSON.parse(raw), raw };
  } catch {
    return fail(400, "validation", "Invalid JSON payload.");
  }
}
function rejectExtraFields(input: unknown, parsed: unknown): void {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    input.forEach((value, index) => rejectExtraFields(value, parsed[index]));
    return;
  }
  if (
    input &&
    parsed &&
    typeof input === "object" &&
    typeof parsed === "object"
  ) {
    for (const key of Object.keys(input)) {
      if (!(key in parsed)) fail(400, "validation", "Unknown entity field.");
      rejectExtraFields(Reflect.get(input, key), Reflect.get(parsed, key));
    }
  }
}
async function rate(db: Database, key: string, now: number, limit: number) {
  const window = Math.floor(now / 60000);
  await db
    .prepare("DELETE FROM centre_rate WHERE window < ?")
    .bind(window - 2)
    .run();
  await db
    .prepare(
      "INSERT INTO centre_rate(key,window,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN centre_rate.window=excluded.window THEN centre_rate.count+1 ELSE 1 END",
    )
    .bind(key, window)
    .run();
  const count = z
    .object({ count: z.number() })
    .parse(
      await db
        .prepare("SELECT count FROM centre_rate WHERE key=?")
        .bind(key)
        .first(),
    ).count;
  if (count > limit) fail(429, "rate", "Request limit reached.");
}
async function dailyRate(
  db: Database,
  key: string,
  now: number,
  limit: number,
) {
  const day = new Date(now).toISOString().slice(0, 10);
  await db
    .prepare("DELETE FROM centre_daily WHERE day<?")
    .bind(new Date(now - 2 * 86400000).toISOString().slice(0, 10))
    .run();
  await db
    .prepare(
      "INSERT INTO centre_daily(day,key,count) VALUES(?,?,1) ON CONFLICT(day,key) DO UPDATE SET count=count+1",
    )
    .bind(day, key)
    .run();
  const row = z
    .object({ count: z.number() })
    .parse(
      await db
        .prepare("SELECT count FROM centre_daily WHERE day=? AND key=?")
        .bind(day, key)
        .first(),
    );
  if (row.count > limit)
    fail(429, "daily_limit", "Daily service limit reached.");
}
function entitiesFor(env: Env, auth: Auth, now: () => number) {
  const db = env.DB,
    w = auth.workspaceId;
  const get = async (kind: string, id: string) => {
    const row = await db
      .prepare(
        "SELECT kind,id,version,CAST(cursor AS TEXT) AS cursor,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_record.workspace AND initial.kind=centre_record.kind AND initial.id=centre_record.id) AS TEXT) AS created_cursor FROM centre_record WHERE workspace=? AND kind=? AND id=?",
      )
      .bind(w, kind, id)
      .first();
    return row ? record(row) : null;
  };
  const studyGoalConflict = async (
    mutation: CloudMutation,
  ): Promise<CloudRecord | null> => {
    if (mutation.kind !== "studyGoal" || mutation.deleted || !mutation.data)
      return null;
    const goal = z
      .object({ weekStart: z.string(), timeZone: z.string() })
      .parse(mutation.data);
    const row = await db
      .prepare(
        "SELECT kind,id,version,CAST(cursor AS TEXT) AS cursor,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_record.workspace AND initial.kind=centre_record.kind AND initial.id=centre_record.id) AS TEXT) AS created_cursor FROM centre_record WHERE workspace=? AND kind='studyGoal' AND deleted=0 AND id!=? AND json_extract(data,'$.weekStart')=? AND json_extract(data,'$.timeZone')=? LIMIT 1",
      )
      .bind(w, mutation.id, goal.weekStart, goal.timeZone)
      .first();
    return row ? record(row) : null;
  };
  const learningNeedConflict = async (
    mutation: CloudMutation,
  ): Promise<CloudRecord | null> => {
    if (
      mutation.kind !== "practice.learningNeed" ||
      mutation.deleted ||
      !mutation.data ||
      mutation.data.deletedAt !== null
    )
      return null;
    const need = z
      .object({
        subjectId: z.string().nullable(),
        topicId: z.string().nullable(),
        conceptKey: z.string(),
      })
      .parse(mutation.data);
    const row = await db
      .prepare(
        "SELECT kind,id,version,CAST(cursor AS TEXT) AS cursor,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_record.workspace AND initial.kind=centre_record.kind AND initial.id=centre_record.id) AS TEXT) AS created_cursor FROM centre_record WHERE workspace=? AND kind='practice.learningNeed' AND deleted=0 AND json_extract(data,'$.deletedAt') IS NULL AND id!=? AND COALESCE(json_extract(data,'$.subjectId'),'')=COALESCE(?,'') AND COALESCE(json_extract(data,'$.topicId'),'')=COALESCE(?,'') AND json_extract(data,'$.conceptKey')=? LIMIT 1",
      )
      .bind(w, mutation.id, need.subjectId, need.topicId, need.conceptKey)
      .first();
    return row ? record(row) : null;
  };
  const commitRaw = async (
    inputs: {
      mutation: CloudMutation;
      raw: string;
      parentMutationId?: string;
    }[],
    activeChatId?: string,
    reviewGuard?: { mutationId: string; bodyHash: string },
  ): Promise<CloudRecord[]> => {
    if (inputs.length < 1 || inputs.length > 50)
      fail(400, "validation", "Commit needs 1 to 50 mutations.");
    const prepared = await Promise.all(
      inputs.map(async ({ mutation: input, raw, parentMutationId }) => {
        const m = cloudMutationSchema.parse(input);
        if (!CLOUD_ENTITY_KINDS.includes(m.kind))
          fail(400, "validation", "Unsupported entity kind.");
        const hash = await sha256(raw);
        const existing = await db
          .prepare(
            "SELECT body_hash,CAST(seq AS TEXT) AS seq,kind,id,expected_version,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_mutation.workspace AND initial.kind=centre_mutation.kind AND initial.id=centre_mutation.id) AS TEXT) AS created_cursor FROM centre_mutation WHERE workspace=? AND mutation_id=?",
          )
          .bind(w, m.mutationId)
          .first();
        if (
          existing &&
          z.object({ body_hash: z.string() }).parse(existing).body_hash !== hash
        )
          fail(
            409,
            "idempotency_mismatch",
            "Mutation ID was already used with another body.",
          );
        if (existing) return { m, hash, parentMutationId };
        if (m.deleted) {
          if (m.data !== null)
            fail(400, "validation", "Tombstones require null data.");
        } else {
          if (m.data === null)
            fail(400, "validation", "Live records require data.");
          const parsed = parseCloudEntity(m.kind, m.data);
          rejectExtraFields(m.data, parsed);
          m.data = parsed;
          if (parsed.id !== undefined && parsed.id !== m.id)
            fail(400, "validation", "Record ID differs from payload.");
          if (m.kind === "preferences" && m.id !== "preferences")
            fail(400, "validation", "Preferences ID must be preferences.");
          if (m.kind === "interactiveProgress") {
            const progress = interactiveResourceProgressSchema.parse(parsed);
            const current = await get(m.kind, m.id);
            if ((current?.version ?? 0) !== m.expectedVersion)
              throw new HttpError(
                409,
                "conflict",
                "Cloud record changed.",
                current,
              );
            if (current && !current.deleted && current.data) {
              const merged = mergeInteractiveResourceProgress(
                current.data,
                progress,
              );
              if (merged.kind === "local" || merged.kind === "conflict")
                throw new HttpError(
                  409,
                  "conflict",
                  "Checklist progress has a newer or conflicting domain revision.",
                  current,
                );
              m.data = merged.value;
            }
            if (
              m.id !==
              (await interactiveResourceProgressId(
                progress.resourceId,
                progress.documentRevision,
              ))
            )
              fail(
                400,
                "validation",
                "Checklist progress ID must match its resource and document revision.",
              );
          }
          const existingGoal = await studyGoalConflict(m);
          if (existingGoal)
            throw new HttpError(
              409,
              "conflict",
              "A study goal already exists for this week and time zone.",
              existingGoal,
            );
          const existingNeed = await learningNeedConflict(m);
          if (existingNeed)
            throw new HttpError(
              409,
              "conflict",
              "A learning need already exists for this concept and subject/topic scope.",
              existingNeed,
            );
          if (m.kind === "attachment") {
            if ((await get("attachment", m.id))?.deleted)
              fail(409, "conflict", "Deleted attachment IDs cannot be reused.");
            const attachment = await db
              .prepare(
                "SELECT complete,metadata FROM centre_attachment WHERE workspace=? AND id=?",
              )
              .bind(w, m.id)
              .first();
            const a = z
              .object({ complete: z.number(), metadata: z.string() })
              .safeParse(attachment);
            if (
              !a.success ||
              a.data.complete !== 1 ||
              JSON.stringify(parsed) !== a.data.metadata
            )
              fail(400, "validation", "Attachment must be completed first.");
          }
        }
        if (bytes(raw).length > CLOUD_LIMITS.recordBytes)
          fail(413, "bounds", "Record is too large.");
        return { m, hash, parentMutationId };
      }),
    );
    try {
      await db.batch([
        ...(reviewGuard
          ? [
              db
                .prepare(
                  "INSERT INTO centre_review_guard(workspace,mutation_id,body_hash) VALUES(?,?,?)",
                )
                .bind(w, reviewGuard.mutationId, reviewGuard.bodyHash),
            ]
          : []),
        ...(activeChatId
          ? [
              db
                .prepare(
                  "INSERT INTO centre_active_chat_guard(workspace,chat_id) VALUES(?,?)",
                )
                .bind(w, activeChatId),
            ]
          : []),
        ...prepared.map(({ m, hash, parentMutationId }) =>
          db
            .prepare(
              "INSERT INTO centre_mutation(workspace,mutation_id,body_hash,kind,id,expected_version,updated_at,deleted,data,parent_mutation_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              w,
              m.mutationId,
              hash,
              m.kind,
              m.id,
              m.expectedVersion,
              new Date(now()).toISOString(),
              Number(m.deleted),
              m.data === null ? null : JSON.stringify(m.data),
              parentMutationId ?? null,
            ),
        ),
      ]);
    } catch (error) {
      const message = String(error);
      if (message.includes("centre_chat_inactive"))
        throw new HttpError(
          409,
          "conflict",
          "Chat is archived or unavailable.",
          activeChatId ? await get("chat", activeChatId) : null,
        );
      if (message.includes("centre_daily_quota"))
        fail(429, "daily_limit", "Daily mutation limit reached.");
      if (message.includes("centre_idempotency_mismatch"))
        fail(
          409,
          "idempotency_mismatch",
          "Mutation ID was already used with another body.",
        );
      if (
        !/centre_conflict|centre_immutable|centre_quota|centre_attachment_conflict|centre_chat_ancestor|UNIQUE constraint/.test(
          message,
        )
      )
        throw error;
      for (const { m } of prepared) {
        const existingGoal = await studyGoalConflict(m);
        if (existingGoal)
          throw new HttpError(
            409,
            "conflict",
            "A study goal already exists for this week and time zone.",
            existingGoal,
          );
      }
      for (const { m } of prepared) {
        const existingNeed = await learningNeedConflict(m);
        if (existingNeed)
          throw new HttpError(
            409,
            "conflict",
            "A learning need already exists for this concept and subject/topic scope.",
            existingNeed,
          );
      }
      if (message.includes("centre_quota"))
        fail(413, "quota", "Workspace record quota reached.");
      const candidate = prepared.find(({ m }) => m.expectedVersion >= 0);
      if (message.includes("centre_chat_ancestor"))
        throw new HttpError(
          409,
          "conflict",
          "Chats with persisted branches cannot be physically removed.",
          candidate ? await get(candidate.m.kind, candidate.m.id) : null,
        );
      throw new HttpError(
        409,
        "conflict",
        message.includes("centre_immutable")
          ? "Attempts are immutable."
          : "Cloud record changed.",
        candidate ? await get(candidate.m.kind, candidate.m.id) : null,
      );
    }
    return Promise.all(
      prepared.map(async ({ m, hash }) => {
        const r = z
          .object({
            body_hash: z.string(),
            seq: z.union([z.number(), z.string()]),
            kind: z.string(),
            id: z.string(),
            expected_version: z.number(),
            created_cursor: z.string(),
            updated_at: z.string(),
            deleted: z.number(),
            data: z.string().nullable(),
          })
          .parse(
            await db
              .prepare(
                "SELECT body_hash,CAST(seq AS TEXT) AS seq,kind,id,expected_version,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_mutation.workspace AND initial.kind=centre_mutation.kind AND initial.id=centre_mutation.id) AS TEXT) AS created_cursor FROM centre_mutation WHERE workspace=? AND mutation_id=?",
              )
              .bind(w, m.mutationId)
              .first(),
          );
        if (r.body_hash !== hash)
          fail(
            409,
            "idempotency_mismatch",
            "Mutation ID was already used with another body.",
          );
        return record({ ...r, version: r.expected_version + 1, cursor: r.seq });
      }),
    );
  };
  const reviewDerivedId = async (mutationId: string) => {
    const hex = await sha256("centre:reviewEvidence:v1\0" + mutationId),
      variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const reviewReceipt = async (mutationId: string) => {
    const row = await db
      .prepare(
        "SELECT body_hash,parent_mutation_id,CAST(seq AS TEXT) AS cursor,kind,id,expected_version+1 AS version,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_mutation.workspace AND initial.kind=centre_mutation.kind AND initial.id=centre_mutation.id) AS TEXT) AS created_cursor FROM centre_mutation WHERE workspace=? AND mutation_id=?",
      )
      .bind(w, mutationId)
      .first();
    return row
      ? {
          record: record(row),
          bodyHash: z.object({ body_hash: z.string() }).parse(row).body_hash,
          parentMutationId: z
            .object({ parent_mutation_id: z.string().nullable() })
            .parse(row).parent_mutation_id,
        }
      : null;
  };
  const reviewResult = async (
    mutationId: string,
    bodyHash: string,
  ): Promise<CloudRecord[]> => {
    const primary = await reviewReceipt(mutationId);
    if (!primary) throw new Error("Review receipt missing after commit.");
    if (primary.bodyHash !== bodyHash)
      fail(
        409,
        "idempotency_mismatch",
        "Mutation ID was already used with another body.",
      );
    const derived = await reviewReceipt(await reviewDerivedId(mutationId));
    return derived?.parentMutationId === mutationId
      ? [primary.record, derived.record]
      : [primary.record];
  };
  const resolveReviewRaw = async (
    input: CloudMutation,
    raw: string,
  ): Promise<CloudRecord[]> => {
    const mutation = cloudMutationSchema.parse(input);
    if (mutation.kind !== "reviewMemory")
      fail(400, "validation", "Review resolution requires a review memory.");
    if (bytes(raw).length > CLOUD_LIMITS.recordBytes)
      fail(413, "bounds", "Record is too large.");
    const bodyHash = await sha256(raw),
      existing = await reviewReceipt(mutation.mutationId);
    if (existing) return reviewResult(mutation.mutationId, bodyHash);
    const inputs: {
      mutation: CloudMutation;
      raw: string;
      parentMutationId?: string;
    }[] = [{ mutation, raw }];
    const current = await get("reviewMemory", mutation.id);
    if (
      !mutation.deleted &&
      mutation.data &&
      current &&
      !current.deleted &&
      current.data
    ) {
      const previous = memorySchema.parse(current.data),
        incoming = memorySchema.strict().parse(mutation.data);
      if (previous.resolvedAt === null && incoming.resolvedAt !== null) {
        const resolvedAt = z.string().datetime().parse(incoming.resolvedAt);
        mutation.data = {
          ...incoming,
          learningNeedId: previous.learningNeedId,
        };
        if (previous.learningNeedId) {
          const linked = await get(
            "practice.learningNeed",
            previous.learningNeedId,
          );
          if (linked && !linked.deleted && linked.data) {
            const need = learningNeedSchema.parse(linked.data);
            const result = applyReviewEvidence({
              learningNeeds: [need],
              learningNeedId: previous.learningNeedId,
              memoryId: previous.id,
              resourceId: previous.resourceId,
              now: resolvedAt,
              createId: () => crypto.randomUUID(),
            });
            if (
              result.updatedNeed &&
              result.updatedNeed.revision !== need.revision
            ) {
              const derived: CloudMutation = {
                mutationId: await reviewDerivedId(mutation.mutationId),
                kind: "practice.learningNeed",
                id: need.id,
                schemaVersion: 1,
                expectedVersion: linked.version,
                deleted: false,
                data: result.updatedNeed,
              };
              inputs.push({
                mutation: derived,
                raw: JSON.stringify(derived),
                parentMutationId: mutation.mutationId,
              });
            }
          }
        }
      }
    }
    try {
      await commitRaw(inputs, undefined, {
        mutationId: mutation.mutationId,
        bodyHash,
      });
    } catch (error) {
      if (String(error).includes("centre_review_replay"))
        return reviewResult(mutation.mutationId, bodyHash);
      throw error;
    }
    return reviewResult(mutation.mutationId, bodyHash);
  };
  const store: EntityStore = {
    get,
    resolveReview: (mutation) =>
      resolveReviewRaw(mutation, JSON.stringify(mutation)),
    put: async (m) =>
      (await commitRaw([{ mutation: m, raw: JSON.stringify(m) }]))[0],
    putMessage: async (mutation, chatId) => {
      z.string().min(1).max(200).parse(chatId);
      if (
        mutation.kind !== "message" ||
        mutation.deleted ||
        mutation.data?.chatId !== chatId
      )
        fail(400, "validation", "Message must belong to the active chat.");
      return (
        await commitRaw([{ mutation, raw: JSON.stringify(mutation) }], chatId)
      )[0];
    },
    commit: (ms) =>
      commitRaw(ms.map((m) => ({ mutation: m, raw: JSON.stringify(m) }))),
    listMessages: async (chatId, limit = 20) => {
      z.string().min(1).max(200).parse(chatId);
      z.number().int().min(1).max(20).parse(limit);
      const chat = await get("chat", chatId);
      if (!chat || chat.deleted || chat.data?.deletedAt !== null) return [];
      const rows = await db
        .prepare(
          "SELECT kind,id,version,CAST(cursor AS TEXT) AS cursor,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_record.workspace AND initial.kind=centre_record.kind AND initial.id=centre_record.id) AS TEXT) AS created_cursor FROM centre_record WHERE workspace=? AND kind='message' AND deleted=0 AND json_extract(data,'$.chatId')=? ORDER BY json_extract(data,'$.createdAt') DESC,CAST(created_cursor AS INTEGER) DESC LIMIT ?",
        )
        .bind(w, chatId, limit)
        .all();
      return rows.results.map(record).reverse();
    },
    listLearningNeeds: async () => {
      const rows = await db
        .prepare(
          "SELECT kind,id,version,CAST(cursor AS TEXT) AS cursor,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_record.workspace AND initial.kind=centre_record.kind AND initial.id=centre_record.id) AS TEXT) AS created_cursor FROM centre_record WHERE workspace=? AND kind='practice.learningNeed' ORDER BY json_extract(data,'$.needScore') DESC,json_extract(data,'$.updatedAt') DESC,id LIMIT 500",
        )
        .bind(w)
        .all();
      return rows.results.map(record);
    },
    getPracticeAttempt: async (source) => {
      const r = await db
        .prepare(
          "SELECT kind,id,version,CAST(cursor AS TEXT) AS cursor,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_record.workspace AND initial.kind=centre_record.kind AND initial.id=centre_record.id) AS TEXT) AS created_cursor FROM centre_record WHERE workspace=? AND kind='practice.attempt' AND json_extract(data,'$.sourceDraftId')=?",
        )
        .bind(w, source)
        .first();
      return r ? record(r) : null;
    },
  };
  return Object.assign(store, { commitRaw, resolveReviewRaw });
}
const deviceName = z.string().trim().min(1).max(100);
export function createWorker(options: WorkerOptions = {}) {
  const now = options.now ?? Date.now;
  async function session(env: Env, workspaceId: string, name: string) {
    await env.DB.prepare(
      "DELETE FROM centre_device WHERE workspace=? AND (expires_at<=? OR revoked_at IS NOT NULL)",
    )
      .bind(workspaceId, new Date(now()).toISOString())
      .run();
    const count = z
      .object({ count: z.number() })
      .parse(
        await env.DB.prepare(
          "SELECT count(*) AS count FROM centre_device WHERE workspace=?",
        )
          .bind(workspaceId)
          .first(),
      ).count;
    if (count >= 100) fail(413, "quota", "Device quota reached.");
    const token = secret("ctr_"),
      deviceId = crypto.randomUUID(),
      expiresAt = new Date(now() + 30 * 86400000).toISOString();
    await env.DB.prepare(
      "INSERT INTO centre_device(id,workspace,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        deviceId,
        workspaceId,
        await sha256(token),
        name,
        new Date(now()).toISOString(),
        expiresAt,
      )
      .run();
    return { token, deviceId, workspaceId, expiresAt };
  }
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const url = new URL(request.url),
          path = url.pathname,
          db = env.DB;
        await dailyRate(db, "requests:global", now(), 5000);
        if (path.startsWith("/v1/auth/")) {
          await rate(db, "auth:global", now(), 300);
          await rate(
            db,
            "auth:" +
              (await sha256(
                request.headers.get("CF-Connecting-IP") ?? "unknown",
              )),
            now(),
            20,
          );
          if (path === "/v1/auth/google" && request.method === "POST") {
            const clientIds = env.GOOGLE_CLIENT_IDS?.split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              subjects = env.GOOGLE_ALLOWED_SUBJECTS?.split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            if (!clientIds?.length || !subjects?.length)
              fail(503, "unconfigured", "Google sign-in is not configured.");
            const input = z
              .object({ idToken: z.string().min(1).max(16000), deviceName })
              .strict()
              .parse((await body(request)).value);
            let identity;
            try {
              identity = await jwtVerify(
                input.idToken,
                options.googleKeyResolver ?? googleKeys,
                {
                  algorithms: ["RS256"],
                  issuer: [
                    "https://accounts.google.com",
                    "accounts.google.com",
                  ],
                  audience: clientIds,
                  currentDate: new Date(now()),
                  requiredClaims: ["sub", "exp", "iat", "email_verified"],
                },
              );
            } catch {
              fail(401, "invalid_identity", "Invalid Google identity.");
            }
            if (
              !identity?.payload.sub ||
              identity.payload.email_verified !== true ||
              !subjects.includes(identity.payload.sub)
            )
              fail(403, "identity_denied", "Google account is not allowed.");
            return json(
              await session(
                env,
                "cw_" + (await sha256(identity.payload.sub)),
                input.deviceName,
              ),
            );
          }
          if (path === "/v1/auth/pair" && request.method === "POST") {
            const input = z
              .object({ code: z.string().regex(/^[a-f0-9]{64}$/), deviceName })
              .strict()
              .parse((await body(request)).value);
            const pairing = await db
              .prepare(
                "DELETE FROM centre_pairing WHERE code_hash=? AND expires_at>? AND EXISTS(SELECT 1 FROM centre_device WHERE id=centre_pairing.issuer_device AND revoked_at IS NULL AND expires_at>?) RETURNING workspace",
              )
              .bind(
                await sha256(input.code),
                new Date(now()).toISOString(),
                new Date(now()).toISOString(),
              )
              .first();
            if (!pairing)
              fail(
                401,
                "invalid_pairing",
                "Pairing code expired or was already used.",
              );
            return json(
              await session(
                env,
                z.object({ workspace: z.string() }).parse(pairing).workspace,
                input.deviceName,
              ),
            );
          }
          fail(404, "not_found", "Route not found.");
        }
        const bearer = request.headers
          .get("Authorization")
          ?.match(/^Bearer (ctr_[a-f0-9]{64})$/)?.[1];
        if (!bearer) fail(401, "unauthorized", "Sign in required.");
        const device = await db
          .prepare(
            "SELECT id,workspace FROM centre_device WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
          )
          .bind(await sha256(bearer), new Date(now()).toISOString())
          .first();
        if (!device)
          fail(401, "unauthorized", "Session expired or was revoked.");
        const d = z
            .object({ id: z.string(), workspace: z.string() })
            .parse(device),
          auth = { workspaceId: d.workspace, deviceId: d.id };
        await rate(db, "workspace:" + d.workspace, now(), 600);
        await dailyRate(db, "requests:" + d.workspace, now(), 1000);
        const entities = entitiesFor(env, auth, now);
        if (path === "/v1/bootstrap" && request.method === "GET")
          return json({
            schemaVersion: 1,
            ...auth,
            kinds: CLOUD_ENTITY_KINDS,
            limits: CLOUD_LIMITS,
          });
        if (path === "/v1/devices" && request.method === "GET")
          return json({
            devices: (
              await db
                .prepare(
                  "SELECT id AS deviceId,name,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt FROM centre_device WHERE workspace=? ORDER BY created_at",
                )
                .bind(d.workspace)
                .all()
            ).results,
          });
        if (path === "/v1/devices/revoke" && request.method === "POST") {
          const input = z
            .object({ deviceId: z.string().uuid() })
            .strict()
            .parse((await body(request)).value);
          await db
            .prepare(
              "UPDATE centre_device SET revoked_at=? WHERE workspace=? AND id=?",
            )
            .bind(new Date(now()).toISOString(), d.workspace, input.deviceId)
            .run();
          return json({ ok: true });
        }
        if (path === "/v1/pairings" && request.method === "POST") {
          z.object({})
            .strict()
            .parse((await body(request)).value);
          await rate(db, "pairing:" + d.workspace, now(), 10);
          await db
            .prepare("DELETE FROM centre_pairing WHERE expires_at<=?")
            .bind(new Date(now()).toISOString())
            .run();
          const code = secret(),
            expiresAt = new Date(now() + 300000).toISOString();
          await db
            .prepare(
              "INSERT INTO centre_pairing(code_hash,workspace,expires_at,issuer_device) VALUES(?,?,?,?)",
            )
            .bind(await sha256(code), d.workspace, expiresAt, d.id)
            .run();
          return json({ code, expiresAt });
        }
        if (path === "/v1/records" && request.method === "POST") {
          const input = await body(request),
            mutation = cloudMutationSchema.parse(input.value);
          return json({
            record: (
              await (mutation.kind === "reviewMemory"
                ? entities.resolveReviewRaw(mutation, input.raw)
                : entities.commitRaw([{ mutation, raw: input.raw }]))
            )[0],
          });
        }
        if (path === "/v1/changes" && request.method === "GET") {
          const cursor = z
            .string()
            .regex(/^(0|[1-9]\d{0,18})$/)
            .parse(url.searchParams.get("cursor") ?? "0");
          if (BigInt(cursor) > 9223372036854775807n)
            fail(400, "validation", "Invalid cursor.");
          const limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(500)
            .parse(url.searchParams.get("limit") ?? 100);
          const rows = (
            await db
              .prepare(
                "SELECT kind,id,version,CAST(cursor AS TEXT) AS cursor,updated_at,deleted,data,CAST((SELECT min(seq) FROM centre_mutation AS initial WHERE initial.workspace=centre_record.workspace AND initial.kind=centre_record.kind AND initial.id=centre_record.id) AS TEXT) AS created_cursor FROM centre_record WHERE workspace=? AND cursor>CAST(? AS INTEGER) ORDER BY centre_record.cursor LIMIT ?",
              )
              .bind(d.workspace, cursor, limit + 1)
              .all()
          ).results;
          const records = rows.slice(0, limit).map(record);
          return json({
            records,
            cursor: records.at(-1)?.cursor ?? cursor,
            hasMore: rows.length > limit,
          });
        }
        const attachmentMatch = path.match(
          /^\/v1\/attachments\/([a-fA-F0-9-]+)(?:\/(complete|chunks\/\d+))?$/,
        );
        if (attachmentMatch)
          return await handleAttachment(
            request,
            env,
            auth,
            entities,
            attachmentMatch[1],
            attachmentMatch[2],
          );
        const extension = await options.extension?.(request, {
          env,
          auth,
          entities,
        });
        if (extension) return extension;
        return json(
          { error: { code: "not_found", message: "Route not found." } },
          404,
        );
      } catch (error) {
        if (String(error).includes("centre_quota"))
          return json(
            { error: { code: "quota", message: "Workspace quota reached." } },
            413,
          );
        if (error instanceof HttpError)
          return json(
            {
              error: { code: error.code, message: error.message },
              ...(error.current !== undefined
                ? { current: error.current }
                : {}),
            },
            error.status,
          );
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return json(
            {
              error: {
                code: "validation",
                message: "Invalid request payload.",
              },
            },
            400,
          );
        return json(
          {
            error: {
              code: "unavailable",
              message: "Service temporarily unavailable.",
            },
          },
          503,
        );
      }
    },
  };
}
async function persistedChats(
  env: Env,
  workspaceId: string,
): Promise<ScopedChatLineage[]> {
  const rows = await env.DB.prepare(
    "SELECT kind,id,data FROM centre_record AS current WHERE workspace=? AND kind IN ('chat','message') AND deleted=0 ORDER BY json_extract(data,'$.createdAt'),(SELECT min(seq) FROM centre_mutation WHERE workspace=current.workspace AND kind=current.kind AND id=current.id) LIMIT 20000",
  )
    .bind(workspaceId)
    .all();
  const chats: Record<string, unknown>[] = [];
  const messages = new Map<string, Chat["messages"]>();
  for (const row of rows.results) {
    const value = z
      .object({ kind: z.enum(["chat", "message"]), data: z.string() })
      .parse(row);
    const data = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(value.data));
    if (value.kind === "chat") chats.push(data);
    else {
      const chatId = z.string().parse(data.chatId);
      const list = messages.get(chatId),
        message = messageSchema.parse(data);
      if (list) list.push(message);
      else messages.set(chatId, [message]);
    }
  }
  return chats.map((data) => ({
    workspaceId,
    chat: chatSchema.parse({
      ...data,
      messages: messages.get(z.string().parse(data.id)) ?? [],
    }),
  }));
}
async function handleAttachment(
  request: Request,
  env: Env,
  auth: Auth,
  entities: EntityStore,
  id: string,
  suffix: string | undefined,
): Promise<Response> {
  z.string().uuid().parse(id);
  const db = env.DB,
    w = auth.workspaceId;
  const current = await entities.get("attachment", id);
  let stored = await db
    .prepare(
      "SELECT metadata,size,complete,owner_chat_id FROM centre_attachment WHERE workspace=? AND id=?",
    )
    .bind(w, id)
    .first();
  let completionId: string | undefined;
  if (suffix === "complete" && request.method === "POST") {
    completionId = z
      .object({ mutationId: z.string().uuid() })
      .strict()
      .parse((await body(request)).value).mutationId;
    const receipt = await db
      .prepare(
        "SELECT body_hash FROM centre_mutation WHERE workspace=? AND mutation_id=?",
      )
      .bind(w, completionId)
      .first();
    if (receipt && stored) {
      const metadata = cloudAttachmentSchema.parse(
        JSON.parse(z.object({ metadata: z.string() }).parse(stored).metadata),
      );
      return json({
        record: await entities.put({
          mutationId: completionId,
          kind: "attachment",
          id,
          schemaVersion: 1,
          expectedVersion: 0,
          deleted: false,
          data: metadata,
        }),
      });
    }
  }
  if (current?.deleted) fail(404, "not_found", "Attachment not found.");
  if (!suffix && request.method === "PUT") {
    const input = z
      .object({
        name: z.string().min(1).max(200),
        mimeType: z.string().min(1).max(200),
        size: z.number().int().positive().max(CLOUD_LIMITS.attachmentBytes),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceChatId: z.string().min(1).max(200),
        chatId: z.string().min(1).max(200),
      })
      .strict()
      .parse((await body(request)).value);
    const { sourceChatId, chatId, ...fields } = input;
    const publicMetadata = cloudAttachmentSchema.parse({ id, ...fields });
    const metadata = JSON.stringify(publicMetadata);
    if (
      stored &&
      z.object({ owner_chat_id: z.string() }).parse(stored).owner_chat_id !==
        sourceChatId
    )
      fail(409, "conflict", "Attachment owner binding is immutable.");
    const chats = await persistedChats(env, w);
    if (
      !canShareChatAttachment(
        chats,
        id,
        { workspaceId: w, chatId: sourceChatId },
        { workspaceId: w, chatId },
      )
    )
      fail(404, "not_found", "Attachment chat association not found.");
    if (stored) {
      if (
        z.object({ metadata: z.string() }).parse(stored).metadata !== metadata
      )
        fail(409, "conflict", "Attachment IDs are immutable.");
      return json(publicMetadata);
    }
    try {
      await db
        .prepare(
          "INSERT INTO centre_attachment(workspace,id,metadata,size,owner_chat_id) VALUES(?,?,?,?,?)",
        )
        .bind(w, id, metadata, input.size, sourceChatId)
        .run();
    } catch (error) {
      if (String(error).includes("centre_attachment_conflict"))
        fail(409, "conflict", "Attachment IDs are immutable.");
      if (String(error).includes("centre_quota"))
        fail(413, "quota", "Attachment workspace quota reached.");
      throw error;
    }
    return json(publicMetadata);
  }
  if (!stored) fail(404, "not_found", "Attachment not found.");
  const attachment = z
    .object({
      metadata: z.string(),
      size: z.number(),
      complete: z.number(),
      owner_chat_id: z.string(),
    })
    .parse(stored);
  const metadata = cloudAttachmentSchema.parse(JSON.parse(attachment.metadata));
  if (request.method === "GET") {
    const target = new URL(request.url).searchParams.get("chatId");
    if (
      !target ||
      target.length > 200 ||
      !canShareChatAttachment(
        await persistedChats(env, w),
        id,
        { workspaceId: w, chatId: attachment.owner_chat_id },
        { workspaceId: w, chatId: target },
      )
    )
      fail(404, "not_found", "Attachment not found.");
  }
  if (!suffix && request.method === "GET") {
    if (!attachment.complete)
      fail(404, "not_found", "Attachment is incomplete.");
    return json(metadata);
  }
  if (suffix?.startsWith("chunks/")) {
    const index = z.coerce.number().int().min(0).max(79).parse(suffix.slice(7));
    if (index >= Math.ceil(attachment.size / CLOUD_LIMITS.chunkBytes))
      fail(400, "validation", "Chunk index exceeds attachment.");
    if (request.method === "PUT") {
      const input = z
        .object({
          data: z
            .string()
            .max(Math.ceil(CLOUD_LIMITS.chunkBytes / 3) * 4)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        })
        .strict()
        .parse((await body(request, 400000)).value);
      const binary = atob(input.data),
        canonicalData = btoa(binary);
      const decoded = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const expected = Math.min(
        CLOUD_LIMITS.chunkBytes,
        attachment.size - index * CLOUD_LIMITS.chunkBytes,
      );
      if (decoded.length !== expected)
        fail(400, "validation", "Invalid chunk size.");
      const previous = await db
        .prepare(
          "SELECT data FROM centre_chunk WHERE workspace=? AND id=? AND chunk_index=?",
        )
        .bind(w, id, index)
        .first();
      if (
        previous &&
        z.object({ data: z.string() }).parse(previous).data !== canonicalData
      )
        fail(409, "conflict", "Chunks are immutable.");
      try {
        await db
          .prepare(
            "INSERT OR IGNORE INTO centre_chunk(workspace,id,chunk_index,data,size) VALUES(?,?,?,?,?)",
          )
          .bind(w, id, index, canonicalData, decoded.length)
          .run();
      } catch (error) {
        if (String(error).includes("centre_chunk_conflict"))
          fail(409, "conflict", "Chunks are immutable.");
        throw error;
      }
      return json({ ok: true });
    }
    if (request.method === "GET") {
      if (!attachment.complete)
        fail(404, "not_found", "Attachment is incomplete.");
      const chunk = await db
        .prepare(
          "SELECT data FROM centre_chunk WHERE workspace=? AND id=? AND chunk_index=?",
        )
        .bind(w, id, index)
        .first();
      if (!chunk) fail(404, "not_found", "Chunk not found.");
      return json(chunk);
    }
  }
  if (suffix === "complete" && request.method === "POST") {
    if (!completionId) fail(400, "validation", "Missing completion mutation.");
    const chunks = z
      .array(z.object({ chunk_index: z.number(), data: z.string() }))
      .parse(
        (
          await db
            .prepare(
              "SELECT chunk_index,data FROM centre_chunk WHERE workspace=? AND id=? ORDER BY chunk_index",
            )
            .bind(w, id)
            .all()
        ).results,
      );
    if (chunks.length !== Math.ceil(attachment.size / CLOUD_LIMITS.chunkBytes))
      fail(400, "validation", "Attachment has missing chunks.");
    const content = new Uint8Array(attachment.size);
    for (const [index, chunk] of chunks.entries()) {
      if (chunk.chunk_index !== index)
        fail(400, "validation", "Attachment has missing chunks.");
      content.set(
        Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)),
        index * CLOUD_LIMITS.chunkBytes,
      );
    }
    if ((await sha256(content)) !== metadata.sha256)
      fail(400, "validation", "Attachment digest differs.");
    await db
      .prepare(
        "UPDATE centre_attachment SET complete=1 WHERE workspace=? AND id=?",
      )
      .bind(w, id)
      .run();
    return json({
      record: await entities.put({
        mutationId: completionId,
        kind: "attachment",
        id,
        schemaVersion: 1,
        expectedVersion: 0,
        deleted: false,
        data: metadata,
      }),
    });
  }
  fail(404, "not_found", "Route not found.");
}
export default createWorker();
