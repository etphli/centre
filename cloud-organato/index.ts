import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import {
  calendarEventSchema,
  calendarTimeSchema,
  eventSchema,
  subjectSchema,
  assignmentSchema,
  type CalendarEvent,
  type StudyEvent,
} from "../shared/schema";
import { calendarStartInstant, calendarTimeKey } from "../shared/calendar-time";

/** D1-compatible subset. Authentication and workspace authorization belong to the host. */
export interface Database {
  prepare(sql: string): Statement;
}
export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export const cloudRecordSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  cursor: z.string().regex(/^\d+$/),
  updatedAt: z.iso.datetime(),
  deleted: z.boolean(),
  data: z.unknown(),
});
export type CloudRecord = z.infer<typeof cloudRecordSchema>;
export type MaybePromise<T> = T | Promise<T>;
export interface Mutation {
  mutationId: string;
  kind: string;
  id: string;
  schemaVersion: 1;
  expectedVersion: number;
  deleted: boolean;
  data: unknown;
}
export interface OrganatoContext {
  env: {
    DB: Database;
    ORGANATO_ENCRYPTION_KEYS_JSON?: string;
    ORGANATO_KEY_VERSION?: string;
    ORGANATO_ALLOWED_ORIGINS?: string;
  };
  auth: { workspaceId: string; deviceId: string };
  entities: {
    get(kind: string, id: string): MaybePromise<CloudRecord | null>;
    put(mutation: Mutation): MaybePromise<CloudRecord>;
    commit(mutations: Mutation[]): MaybePromise<CloudRecord[]>;
  };
}
const connectionSchema = z.object({
  workspace_id: z.string(),
  connection_id: z.string(),
  base_url: z.string(),
  key_version: z.string(),
  ciphertext: z.string(),
  iv: z.string(),
  state: z.enum(["connected", "reauth", "permission", "error"]),
  updated_at: z.string(),
  message: z.string().nullable(),
});
type Connection = z.infer<typeof connectionSchema>;
const remoteSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.number().int().positive(),
  kind: z.enum(["work", "todo"]),
  displayName: z.string(),
  subjectId: z.string().nullable(),
  dueAt: z.iso.datetime().nullable(),
  dueDateLocal: z.iso.date().nullable(),
  workingStatus: z.string(),
  notesMarkdown: z.string().default(""),
  calendarEnabled: z.boolean(),
  archivedAt: z.iso.datetime().nullable().default(null),
  completedAt: z.iso.datetime().nullable().default(null),
  estimatedMinutes: z.number().int().nullable().default(null),
});
type Remote = z.infer<typeof remoteSchema>;
const receiptSchema = z.object({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive().nullable(),
  status: z.enum(["succeeded", "unknown", "conflict", "failed", "pending"]),
  event: eventSchema.nullable(),
  record: cloudRecordSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  reconciliationRequired: z.boolean(),
});
export type OrganatoReceipt = z.infer<typeof receiptSchema>;
const planSchema = z.object({
  action: z.enum(["create", "patch", "complete", "archive"]),
  expectedVersion: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive().nullable(),
  event: calendarEventSchema,
  upstream: z.record(z.string(), z.unknown()),
});
type Plan = z.infer<typeof planSchema>;
const operationSchema = z.object({
  operation_id: z.string(),
  event_id: z.string(),
  connection_id: z.string(),
  payload_hash: z.string(),
  plan_json: z.string(),
  status: receiptSchema.shape.status,
  receipt_json: z.string(),
  remote_json: z.string().nullable(),
  updated_at: z.string(),
});
type Operation = z.infer<typeof operationSchema>;
class Failure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}
const now = () => new Date().toISOString();
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
function sql(
  ctx: OrganatoContext,
  query: string,
  ...values: (string | number | null)[]
) {
  return ctx.env.DB.prepare(query).bind(...values);
}
async function connection(ctx: OrganatoContext) {
  const row = await sql(
    ctx,
    "SELECT * FROM centre_organato_connections WHERE workspace_id = ?",
    ctx.auth.workspaceId,
  ).first();
  return row ? connectionSchema.parse(row) : null;
}
function view(c: Connection | null) {
  return {
    state: c?.state ?? "unconfigured",
    baseUrl: c?.base_url ?? null,
    keyVersion: c?.key_version ?? null,
    updatedAt: c?.updated_at ?? null,
    message: c?.message ?? null,
  };
}
function baseUrl(value: string, ctx: OrganatoContext) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Failure(
      400,
      "invalid_base_url",
      "Choose an allowed HTTPS Organato API URL.",
    );
  }
  const origins = (ctx.env.ORGANATO_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !origins.includes(url.origin) ||
    !/^\/api\/v1\/?$/.test(url.pathname)
  )
    throw new Failure(
      400,
      "invalid_base_url",
      "Choose an allowlisted HTTPS origin with the /api/v1 base path.",
    );
  return `${url.origin}/api/v1`;
}
function bytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function base64(value: Uint8Array) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}
async function encryptionKey(ctx: OrganatoContext, version: string) {
  try {
    const keys = z
      .record(z.string(), z.string())
      .parse(JSON.parse(ctx.env.ORGANATO_ENCRYPTION_KEYS_JSON ?? "{}"));
    const raw = bytes(keys[version] ?? "");
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    throw new Failure(
      503,
      "encryption_unavailable",
      "The Organato encryption key is unavailable.",
    );
  }
}
function aad(
  ctx: OrganatoContext,
  c: Pick<Connection, "connection_id" | "base_url" | "key_version">,
) {
  return new TextEncoder().encode(
    JSON.stringify([
      ctx.auth.workspaceId,
      c.connection_id,
      c.base_url,
      c.key_version,
    ]),
  );
}
async function apiKey(ctx: OrganatoContext, c: Connection) {
  try {
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes(c.iv), additionalData: aad(ctx, c) },
        await encryptionKey(ctx, c.key_version),
        bytes(c.ciphertext),
      ),
    );
  } catch {
    throw new Failure(
      503,
      "encryption_unavailable",
      "The saved Organato credential cannot be opened.",
    );
  }
}
async function readJSON(
  source: Request | Response,
  limit: number,
): Promise<unknown> {
  if (Number(source.headers.get("content-length")) > limit)
    throw new Failure(
      413,
      "body_too_large",
      "JSON body exceeds the connector limit.",
    );
  const reader = source.body?.getReader();
  if (!reader) throw new Failure(400, "invalid_json", "Expected a JSON body.");
  let expired = false;
  const readTimer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 15000);
  let size = 0;
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit)
        throw new Failure(
          413,
          "body_too_large",
          "JSON body exceeds the connector limit.",
        );
      text += decoder.decode(part.value, { stream: true });
    }
    if (expired)
      throw new Failure(
        408,
        "body_timeout",
        "JSON body was not received within 15 seconds.",
      );
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new Failure(400, "invalid_json", "Expected valid JSON.");
    }
  } finally {
    clearTimeout(readTimer);
    await reader.cancel().catch(() => {});
  }
}
async function body(request: Request) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new Failure(415, "content_type", "Expected application/json.");
  return readJSON(request, 64 * 1024);
}
async function remote(
  ctx: OrganatoContext,
  c: Connection,
  path: string,
  method = "GET",
  payload?: unknown,
): Promise<unknown> {
  baseUrl(c.base_url, ctx);
  const key = await apiKey(ctx, c);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(c.base_url + path, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const state =
        response.status === 401
          ? "reauth"
          : response.status === 403
            ? "permission"
            : "error";
      const message =
        response.status === 401
          ? "Reconnect Organato with a valid API key."
          : response.status === 403
            ? "Organato denied permission. Use a read-and-write key for sessions."
            : "Organato rejected the request.";
      await sql(
        ctx,
        "UPDATE centre_organato_connections SET state = ?, message = ?, updated_at = ? WHERE workspace_id = ? AND connection_id = ?",
        state,
        message,
        now(),
        ctx.auth.workspaceId,
        c.connection_id,
      ).run();
      throw new Failure(
        response.status === 401 ||
        response.status === 403 ||
        response.status === 409
          ? response.status
          : 502,
        `upstream_${response.status}`,
        message,
        method !== "GET" && response.status >= 500,
      );
    }
    const result = await readJSON(response, 2 * 1024 * 1024);
    await sql(
      ctx,
      "UPDATE centre_organato_connections SET state = 'connected', message = NULL, updated_at = ? WHERE workspace_id = ? AND connection_id = ?",
      now(),
      ctx.auth.workspaceId,
      c.connection_id,
    ).run();
    return result;
  } catch (error) {
    if (error instanceof Failure && error.code.startsWith("upstream_"))
      throw error;
    throw new Failure(
      502,
      "upstream_unconfirmed",
      method === "GET"
        ? "Organato could not be read."
        : "The Organato write could not be confirmed. Reconcile before another write.",
      method !== "GET",
    );
  } finally {
    clearTimeout(timer);
  }
}
function parseRemoteItem(value: unknown) {
  const result = z.object({ item: remoteSchema }).safeParse(value);
  if (!result.success)
    throw new Failure(
      502,
      "invalid_upstream",
      "Organato returned an invalid item.",
    );
  return result.data.item;
}
function clock(r: Remote, timeZone: string) {
  if (r.dueAt) {
    const zoned = Temporal.Instant.from(r.dueAt).toZonedDateTimeISO(timeZone);
    return {
      date: zoned.toPlainDate().toString(),
      time: calendarTimeKey(zoned.toPlainTime()),
      startAt: Temporal.Instant.from(r.dueAt).toString(),
    };
  }
  return r.dueDateLocal
    ? { date: r.dueDateLocal, time: null, startAt: null }
    : null;
}
function projected(r: Remote, event?: CalendarEvent): StudyEvent | null {
  const timeZone = event?.timeZone ?? "Australia/Sydney";
  const date = clock(r, timeZone);
  if (!date || r.kind !== "todo" || !r.calendarEnabled) return null;
  return eventSchema.parse({
    ...event,
    ...date,
    id: event?.id ?? r.id,
    origin: event ? "centre" : "organato",
    kind: event?.kind ?? "deadline",
    title: r.displayName,
    subjectId: r.subjectId,
    notes: r.notesMarkdown,
    completedAt:
      r.workingStatus === "completed"
        ? (r.completedAt ?? event?.completedAt ?? now())
        : null,
    organatoId: r.id,
    organatoVersion: r.version,
    timeZone,
    deletedAt: r.archivedAt,
    plannedDurationMinutes: event ? r.estimatedMinutes : null,
  });
}
function wire(event: CalendarEvent) {
  return {
    displayName: event.title,
    subjectId: event.subjectId,
    notesMarkdown: event.notes,
    calendarNote: event.notes,
    calendarEnabled: true,
    estimatedMinutes: event.plannedDurationMinutes,
    dueAt: event.startAt,
    dueDateLocal: null,
    dueHasExplicitTime: true,
  };
}
function normalize(event: CalendarEvent, previous?: CalendarEvent) {
  if (event.origin !== "centre" || event.kind !== "session" || event.deletedAt)
    throw new Failure(
      400,
      "invalid_session",
      "Only active Centre-created study sessions can be changed.",
    );
  if (
    previous &&
    event.date === previous.date &&
    event.timeZone === previous.timeZone &&
    event.time &&
    previous.time &&
    Temporal.PlainTime.from(event.time).equals(
      Temporal.PlainTime.from(previous.time),
    )
  ) {
    return calendarEventSchema.parse({
      ...event,
      time: previous.time,
      startAt: previous.startAt,
    });
  }
  const startAt = calendarStartInstant(
    event.date,
    event.time ?? "",
    event.timeZone,
  ).toString();
  return calendarEventSchema.parse({
    ...event,
    time: event.time
      ? calendarTimeKey(Temporal.PlainTime.from(event.time))
      : null,
    startAt,
  });
}
async function getOperation(ctx: OrganatoContext, id: string) {
  const row = await sql(
    ctx,
    "SELECT * FROM centre_organato_operations WHERE workspace_id = ? AND operation_id = ?",
    ctx.auth.workspaceId,
    id,
  ).first();
  return row ? operationSchema.parse(row) : null;
}
function receipt(op: Operation): OrganatoReceipt {
  return {
    ...receiptSchema.parse(JSON.parse(op.receipt_json)),
    status: op.status,
  };
}
function receiptResponse(value: OrganatoReceipt, statusGet = false) {
  return json(
    value,
    statusGet
      ? 200
      : value.status === "succeeded"
        ? 200
        : value.status === "conflict"
          ? 409
          : value.status === "failed"
            ? 502
            : 202,
  );
}
async function saveReceipt(ctx: OrganatoContext, value: OrganatoReceipt) {
  await sql(
    ctx,
    "UPDATE centre_organato_operations SET status = ?, receipt_json = ?, updated_at = ? WHERE workspace_id = ? AND operation_id = ?",
    value.status,
    JSON.stringify(value),
    now(),
    ctx.auth.workspaceId,
    value.operationId,
  ).run();
  return value;
}
function canonicalEvent(plan: Plan, r: Remote): CalendarEvent {
  if (!matches(plan, r))
    throw new Failure(
      409,
      "reconciliation_mismatch",
      "The Organato item does not match this planned operation.",
    );
  return calendarEventSchema.parse({
    ...projected(r, plan.event),
    revision: plan.event.revision,
    updatedAt: plan.event.updatedAt,
  });
}
async function currentRecord(
  ctx: OrganatoContext,
  id: string,
): Promise<CloudRecord | null> {
  try {
    return cloudRecordSchema
      .nullable()
      .parse(await ctx.entities.get("calendarEvent", id));
  } catch {
    return null;
  }
}
async function reserveOperationLink(
  ctx: OrganatoContext,
  op: Operation,
  plan: Plan,
  r: Remote,
): Promise<void> {
  // The unique remote owner and the event's existing reservation are checked by
  // the same statement. A collision must not pin remote_json or write canonical data.
  canonicalEvent(plan, r);
  const reserved = await sql(
    ctx,
    "INSERT INTO centre_organato_links (workspace_id,event_id,organato_id,connection_id) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM centre_organato_links WHERE workspace_id = ? AND connection_id = ? AND organato_id = ? AND event_id <> ?) ON CONFLICT(workspace_id,event_id) DO UPDATE SET organato_id = excluded.organato_id WHERE centre_organato_links.connection_id = excluded.connection_id AND centre_organato_links.organato_id = excluded.organato_id RETURNING event_id",
    ctx.auth.workspaceId,
    plan.event.id,
    r.id,
    op.connection_id,
    ctx.auth.workspaceId,
    op.connection_id,
    r.id,
    plan.event.id,
  ).first();
  if (!reserved)
    throw new Failure(
      409,
      "reconciliation_mismatch",
      "The Organato item is already owned by another Centre session, or this session has a different reserved link.",
    );
}
async function canonical(
  ctx: OrganatoContext,
  op: Operation,
  plan: Plan,
  r: Remote,
) {
  const event = canonicalEvent(plan, r);
  await reserveOperationLink(ctx, op, plan, r);
  const record = cloudRecordSchema.parse(
    await ctx.entities.put({
      mutationId: op.operation_id,
      kind: "calendarEvent",
      id: event.id,
      schemaVersion: 1,
      expectedVersion: plan.expectedVersion,
      deleted: plan.action === "archive",
      data: event,
    }),
  );
  return saveReceipt(ctx, {
    operationId: op.operation_id,
    expectedVersion: plan.expectedVersion,
    expectedRevision: plan.expectedRevision,
    status: "succeeded",
    event,
    record,
    error: null,
    reconciliationRequired: false,
  });
}
function matches(plan: Plan, r: Remote) {
  const e = plan.event;
  if (
    r.kind !== "todo" ||
    !r.calendarEnabled ||
    (e.organatoId !== null && r.id !== e.organatoId)
  )
    return false;
  if (plan.action === "archive")
    return Boolean(r.archivedAt) && r.version > (e.organatoVersion ?? 0);
  if (
    r.archivedAt ||
    (plan.action !== "create" && r.version <= (e.organatoVersion ?? 0))
  )
    return false;
  if (plan.action === "complete")
    return (
      r.workingStatus === (e.completedAt ? "completed" : "not_started") &&
      r.version > (e.organatoVersion ?? 0)
    );
  return (
    samePlannedContent(e, r) &&
    (plan.action !== "create" ||
      (r.workingStatus === "not_started" && r.completedAt === null))
  );
}
function samePlannedContent(event: CalendarEvent, r: Remote): boolean {
  const date = clock(r, event.timeZone);
  return (
    r.displayName === event.title &&
    r.subjectId === event.subjectId &&
    r.notesMarkdown === event.notes &&
    r.estimatedMinutes === event.plannedDurationMinutes &&
    r.dueDateLocal === null &&
    date?.date === event.date &&
    date.time !== null &&
    event.time !== null &&
    Temporal.PlainTime.from(date.time).equals(
      Temporal.PlainTime.from(event.time),
    ) &&
    date.startAt !== null &&
    event.startAt !== null &&
    Temporal.Instant.from(date.startAt).equals(
      Temporal.Instant.from(event.startAt),
    )
  );
}
function sameCompletion(event: CalendarEvent, r: Remote): boolean {
  if (event.completedAt === null)
    return r.workingStatus === "not_started" && r.completedAt === null;
  return (
    r.workingStatus === "completed" &&
    r.completedAt !== null &&
    Temporal.Instant.from(r.completedAt).equals(
      Temporal.Instant.from(event.completedAt),
    )
  );
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  return base64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stable(value)),
      ),
    ),
  );
}
const operationInput = {
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
};
const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    date: z.iso.date().optional(),
    time: calendarTimeSchema.optional(),
    plannedDurationMinutes: z.number().int().min(5).max(720).optional(),
    subjectId: z.string().max(200).nullable().optional(),
    notes: z.string().max(20000).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
async function mutate(
  request: Request,
  ctx: OrganatoContext,
  c: Connection | null,
  id: string | null,
  action: Plan["action"],
) {
  const raw = await body(request);
  const input =
    action === "create"
      ? z
          .object({
            operationId: z.string().uuid(),
            id: z.string().uuid(),
            data: calendarEventSchema,
          })
          .strict()
          .parse(raw)
      : action === "patch"
        ? z
            .object({ ...operationInput, patch: patchSchema })
            .strict()
            .parse(raw)
        : action === "complete"
          ? z
              .object({ ...operationInput, completed: z.boolean() })
              .strict()
              .parse(raw)
          : z.object(operationInput).strict().parse(raw);
  const payloadHash = await hash({ action, id, body: raw });
  const existing = await getOperation(ctx, input.operationId);
  if (existing) {
    if (existing.payload_hash !== payloadHash)
      throw new Failure(
        409,
        "operation_reused",
        "This operation ID already has a different payload.",
      );
    return receiptResponse(receipt(existing));
  }
  if (!c)
    throw new Failure(
      503,
      "organato_unconfigured",
      "Connect Organato before using this route.",
    );
  let event: CalendarEvent;
  let expectedVersion = 0;
  if ("data" in input) {
    if (
      input.id !== input.data.id ||
      input.data.organatoId ||
      input.data.organatoVersion ||
      input.data.completedAt ||
      input.data.revision !== 1
    )
      throw new Failure(
        400,
        "invalid_create",
        "A new session needs matching IDs, revision 1 and no remote link or completion.",
      );
    if (await ctx.entities.get("calendarEvent", input.id))
      throw new Failure(
        409,
        "cloud_conflict",
        "The session ID already exists.",
      );
    event = normalize(input.data);
  } else {
    const record = await ctx.entities.get("calendarEvent", id ?? "");
    if (!record || record.deleted)
      throw new Failure(404, "session_not_found", "The session was not found.");
    event = calendarEventSchema.parse(record.data);
    if (
      event.id !== id ||
      event.origin !== "centre" ||
      event.kind !== "session" ||
      event.deletedAt
    )
      throw new Failure(
        400,
        "invalid_session",
        "Only active Centre-created sessions can be changed.",
      );
    if (
      record.version !== input.expectedVersion ||
      event.revision !== input.expectedRevision
    )
      throw new Failure(
        409,
        "cloud_conflict",
        "The session changed. Refresh before saving.",
      );
    if (!event.organatoId || !event.organatoVersion)
      throw new Failure(
        409,
        "missing_link",
        "The session has no confirmed Organato link.",
      );
    const linked = await sql(
      ctx,
      "SELECT connection_id,organato_id FROM centre_organato_links WHERE workspace_id = ? AND event_id = ?",
      ctx.auth.workspaceId,
      event.id,
    ).first();
    if (!linked)
      throw new Failure(
        409,
        "link_reconciliation_required",
        "This session has no verified hosted link. Reconcile the desktop link before a hosted mutation.",
      );
    const link = z
      .object({ connection_id: z.string(), organato_id: z.string() })
      .parse(linked);
    if (link.connection_id !== c.connection_id)
      throw new Failure(
        409,
        "connection_changed",
        "This session belongs to a different Organato credential. Restore its original connection.",
      );
    if (link.organato_id !== event.organatoId)
      throw new Failure(
        409,
        "link_reconciliation_required",
        "The canonical remote ID differs from its verified hosted link. Reconcile the link before changing this session.",
      );
    expectedVersion = input.expectedVersion;
    const patch = "patch" in input ? patchSchema.parse(input.patch) : {};
    if (patch.time?.length === 5 && patch.time === event.time?.slice(0, 5))
      patch.time = event.time;
    event = normalize(
      {
        ...event,
        ...patch,
        ...("completed" in input
          ? { completedAt: input.completed ? now() : null }
          : {}),
        revision: event.revision + 1,
        updatedAt: now(),
      },
      event,
    );
  }
  const upstream =
    action === "archive"
      ? { version: event.organatoVersion }
      : action === "complete"
        ? {
            version: event.organatoVersion,
            workingStatus: event.completedAt ? "completed" : "not_started",
          }
        : action === "create"
          ? { kind: "todo", ...wire(event) }
          : { version: event.organatoVersion, ...wire(event) };
  const expectedRevision =
    "expectedRevision" in input ? input.expectedRevision : null;
  const plan: Plan = {
    action,
    expectedVersion,
    expectedRevision,
    event,
    upstream,
  };
  const pending: OrganatoReceipt = {
    operationId: input.operationId,
    expectedVersion,
    expectedRevision,
    status: "pending",
    event,
    record: null,
    error: null,
    reconciliationRequired: true,
  };
  try {
    await sql(
      ctx,
      "INSERT INTO centre_organato_operations (workspace_id,operation_id,event_id,connection_id,payload_hash,plan_json,status,receipt_json,created_at,updated_at) SELECT ?,?,?,?,?,?,'pending',?,?,? WHERE ? = 'create' OR EXISTS (SELECT 1 FROM centre_organato_links WHERE workspace_id = ? AND event_id = ? AND connection_id = ? AND organato_id = ?)",
      ctx.auth.workspaceId,
      input.operationId,
      event.id,
      c.connection_id,
      payloadHash,
      JSON.stringify(plan),
      JSON.stringify(pending),
      now(),
      now(),
      action,
      ctx.auth.workspaceId,
      event.id,
      c.connection_id,
      event.organatoId,
    ).run();
  } catch {
    const raced = await getOperation(ctx, input.operationId);
    if (raced) {
      if (raced.payload_hash !== payloadHash)
        throw new Failure(
          409,
          "operation_reused",
          "This operation ID already has a different payload.",
        );
      return receiptResponse(receipt(raced));
    }
    throw new Failure(
      409,
      "session_busy",
      "This session has an unresolved operation. Reconcile it before another write.",
    );
  }
  const op = await getOperation(ctx, input.operationId);
  if (!op)
    throw new Failure(
      409,
      "connection_changed",
      "The hosted link changed before this operation could start. Verify its connection again.",
    );
  let confirmed = false;
  let intendedEvent = event;
  try {
    const path =
      action === "create"
        ? "/items"
        : `/items/${encodeURIComponent(event.organatoId ?? "")}${action === "archive" ? "/archive" : ""}`;
    const response = await remote(
      ctx,
      c,
      path,
      action === "patch" || action === "complete" ? "PATCH" : "POST",
      upstream,
    );
    confirmed = true;
    const r = parseRemoteItem(response);
    await reserveOperationLink(ctx, op, plan, r);
    await sql(
      ctx,
      "UPDATE centre_organato_operations SET remote_json = ?, updated_at = ? WHERE workspace_id = ? AND operation_id = ?",
      JSON.stringify(r),
      now(),
      ctx.auth.workspaceId,
      input.operationId,
    ).run();
    intendedEvent = canonicalEvent(plan, r);
    return receiptResponse(await canonical(ctx, op, plan, r));
  } catch (error) {
    const ambiguous =
      confirmed || !(error instanceof Failure) || error.ambiguous;
    const status = ambiguous
      ? "unknown"
      : error instanceof Failure && error.status === 409
        ? "conflict"
        : "failed";
    return receiptResponse(
      await saveReceipt(ctx, {
        ...pending,
        event: intendedEvent,
        record: ambiguous ? await currentRecord(ctx, event.id) : null,
        status,
        error: {
          code: ambiguous
            ? "write_unconfirmed"
            : error instanceof Failure
              ? error.code
              : "upstream_failed",
          message: ambiguous
            ? "The write may have applied. Reconcile this operation before another write."
            : "Organato rejected the operation.",
        },
        reconciliationRequired: ambiguous,
      }),
    );
  }
}
async function verifyLink(
  request: Request,
  ctx: OrganatoContext,
  c: Connection | null,
  id: string,
): Promise<Response> {
  const input = z
    .object({
      expectedVersion: z.number().int().positive(),
      expectedRevision: z.number().int().positive(),
    })
    .strict()
    .parse(await body(request));
  if (!c)
    throw new Failure(
      503,
      "organato_unconfigured",
      "Connect Organato before verifying this session.",
    );
  const initial = cloudRecordSchema
    .nullable()
    .parse(await ctx.entities.get("calendarEvent", id));
  if (!initial || initial.deleted)
    throw new Failure(
      404,
      "session_not_found",
      "The active session was not found.",
    );
  const value = eventSchema.parse(initial.data);
  if (
    value.id !== id ||
    value.origin !== "centre" ||
    value.kind !== "session" ||
    value.deletedAt
  )
    throw new Failure(
      400,
      "invalid_session",
      "Only active Centre-created sessions can be linked.",
    );
  const event = calendarEventSchema.parse(initial.data);
  if (
    initial.version !== input.expectedVersion ||
    event.revision !== input.expectedRevision
  )
    throw new Failure(
      409,
      "cloud_conflict",
      "The session changed. Refresh before verifying its link.",
    );
  const mismatch = () =>
    new Failure(
      409,
      "link_reconciliation_mismatch",
      "The Organato item does not exactly match this canonical session.",
    );
  if (!event.organatoId || !event.organatoVersion) throw mismatch();
  const unresolved = await sql(
    ctx,
    "SELECT operation_id FROM centre_organato_operations WHERE workspace_id = ? AND event_id = ? AND status IN ('pending','unknown') LIMIT 1",
    ctx.auth.workspaceId,
    id,
  ).first();
  if (unresolved)
    throw new Failure(
      409,
      "session_busy",
      "Reconcile the unresolved operation before verifying this link.",
    );
  let r: Remote;
  try {
    r = parseRemoteItem(
      await remote(ctx, c, `/items/${encodeURIComponent(event.organatoId)}`),
    );
  } catch (error) {
    if (error instanceof Failure && error.code === "upstream_404")
      throw mismatch();
    throw error;
  }
  if (
    r.id !== event.organatoId ||
    r.kind !== "todo" ||
    !r.calendarEnabled ||
    r.archivedAt ||
    r.version < event.organatoVersion ||
    !samePlannedContent(event, r) ||
    !sameCompletion(event, r)
  )
    throw mismatch();
  const collision = await sql(
    ctx,
    "SELECT event_id FROM centre_organato_links WHERE workspace_id = ? AND connection_id = ? AND organato_id = ? AND event_id <> ?",
    ctx.auth.workspaceId,
    c.connection_id,
    r.id,
    id,
  ).first();
  if (collision) throw mismatch();
  const current = await currentRecord(ctx, id);
  if (!current || current.deleted || current.version !== initial.version)
    throw new Failure(
      409,
      "cloud_conflict",
      "The session changed while its link was being verified.",
    );
  let record = initial;
  let resultEvent = event;
  if (r.version > event.organatoVersion) {
    resultEvent = calendarEventSchema.parse({
      ...event,
      organatoVersion: r.version,
      revision: event.revision + 1,
      updatedAt: now(),
    });
    try {
      record = cloudRecordSchema.parse(
        await ctx.entities.put({
          mutationId: crypto.randomUUID(),
          kind: "calendarEvent",
          id,
          schemaVersion: 1,
          expectedVersion: input.expectedVersion,
          deleted: false,
          data: resultEvent,
        }),
      );
    } catch {
      throw new Failure(
        409,
        "cloud_conflict",
        "The canonical remote version could not be refreshed. Refresh before verifying its link again.",
      );
    }
  }
  // This insert and the operation-ledger insert mutually exclude rebinds and writes.
  // A remote ID may identify only one Centre session for this credential.
  const bound = await sql(
    ctx,
    "INSERT INTO centre_organato_links (workspace_id,event_id,organato_id,connection_id) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM centre_organato_operations WHERE workspace_id = ? AND event_id = ? AND status IN ('pending','unknown')) ON CONFLICT(workspace_id,event_id) DO UPDATE SET organato_id = excluded.organato_id, connection_id = excluded.connection_id RETURNING event_id",
    ctx.auth.workspaceId,
    id,
    r.id,
    c.connection_id,
    ctx.auth.workspaceId,
    id,
  ).first();
  if (!bound)
    throw new Failure(
      409,
      "session_busy",
      "An operation started while the link was being verified. Reconcile it before linking.",
    );
  return json({ event: resultEvent, record });
}
async function snapshot(ctx: OrganatoContext, c: Connection) {
  const subjects = z
    .object({
      subjects: z
        .array(
          z.object({
            id: z.string(),
            displayName: z.string(),
            shortName: z.string().nullable(),
            colour: z.string(),
            active: z.boolean(),
          }),
        )
        .max(5000),
    })
    .parse(await remote(ctx, c, "/subjects")).subjects;
  const deadline = Date.now() + 45000;
  const items: Remote[] = [];
  let snapshotBytes = 0;
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; ; pageNumber++) {
    if (Date.now() > deadline)
      throw new Failure(
        502,
        "snapshot_timeout",
        "Organato snapshot exceeded its time budget.",
      );
    if (pageNumber >= 25)
      throw new Failure(
        502,
        "pagination_limit",
        "Organato exceeds the 5,000-item snapshot limit.",
      );
    const query = new URLSearchParams({ limit: "200", archived: "false" });
    if (cursor) query.set("cursor", cursor);
    const page = z
      .object({
        items: z.array(remoteSchema).max(200),
        nextCursor: z.string().min(1).max(200).nullable(),
      })
      .parse(await remote(ctx, c, `/items?${query}`));
    snapshotBytes += new TextEncoder().encode(
      JSON.stringify(page.items),
    ).byteLength;
    if (snapshotBytes > 8 * 1024 * 1024)
      throw new Failure(
        502,
        "snapshot_limit",
        "Organato snapshot exceeds the 8 MiB aggregate limit.",
      );
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor))
      throw new Failure(
        502,
        "pagination_loop",
        "Organato repeated a pagination cursor.",
      );
    seen.add(cursor);
  }
  const links = await sql(
    ctx,
    "SELECT event_id,organato_id FROM centre_organato_links WHERE workspace_id = ? AND connection_id = ? LIMIT 5001",
    ctx.auth.workspaceId,
    c.connection_id,
  ).all<{ event_id: string; organato_id: string }>();
  if (links.results.length > 5000)
    throw new Failure(
      502,
      "snapshot_limit",
      "The linked-session snapshot exceeds 5,000 records.",
    );
  const unresolved = await sql(
    ctx,
    "SELECT event_id FROM centre_organato_operations WHERE workspace_id = ? AND status IN ('pending','unknown') LIMIT 5001",
    ctx.auth.workspaceId,
  ).all<{ event_id: string }>();
  const blocked = new Set(unresolved.results.map((row) => row.event_id));
  const events: StudyEvent[] = [];
  const linked = new Set<string>();
  const remotes = new Map(items.map((item) => [item.id, item]));
  // Read sequentially to avoid exhausting D1 subrequest limits with a burst of reads.
  for (const link of links.results) {
    const record = await ctx.entities.get("calendarEvent", link.event_id);
    if (!record) continue;
    const event = calendarEventSchema.parse(record.data);
    if (
      record.kind !== "calendarEvent" ||
      record.id !== link.event_id ||
      event.id !== link.event_id ||
      event.organatoId !== link.organato_id
    ) {
      // Generic cloud sync can change a canonical link. Only /link can verify it.
      if (
        record.kind === "calendarEvent" &&
        record.id === link.event_id &&
        event.id === link.event_id &&
        !record.deleted &&
        !event.deletedAt
      )
        events.push(event);
      continue;
    }
    linked.add(link.organato_id);
    if (record.deleted || event.deletedAt) continue;
    const upstream = remotes.get(link.organato_id);
    let projection =
      upstream && !blocked.has(event.id) ? projected(upstream, event) : event;
    // Refresh the canonical remote version after an external edit, so a new command
    // can use the current Organato CAS version. Unresolved operations keep their plan.
    if (
      upstream &&
      projection &&
      upstream.version > (event.organatoVersion ?? 0) &&
      !blocked.has(event.id)
    ) {
      const updated = calendarEventSchema.parse({
        ...projection,
        revision: event.revision + 1,
        updatedAt: now(),
      });
      const saved = await ctx.entities.put({
        mutationId: crypto.randomUUID(),
        kind: "calendarEvent",
        id: event.id,
        schemaVersion: 1,
        expectedVersion: record.version,
        deleted: false,
        data: updated,
      });
      projection = calendarEventSchema.parse(saved.data);
    }
    if (projection && !projection.deletedAt) {
      snapshotBytes += new TextEncoder().encode(
        JSON.stringify(projection),
      ).byteLength;
      if (snapshotBytes > 8 * 1024 * 1024)
        throw new Failure(
          502,
          "snapshot_limit",
          "Organato snapshot exceeds the 8 MiB aggregate limit.",
        );
      events.push(projection);
    }
  }
  for (const r of items) {
    if (r.archivedAt || linked.has(r.id)) continue;
    const event = projected(r);
    if (event) events.push(event);
  }
  return json({
    subjects: subjects
      .filter((s) => s.active)
      .map((s) =>
        subjectSchema.parse({
          id: s.id,
          name: s.displayName,
          shortName: s.shortName,
          color: s.colour,
        }),
      ),
    assignments: items
      .filter((r) => !r.archivedAt)
      .map((r) =>
        assignmentSchema.parse({
          id: r.id,
          title: r.displayName,
          kind: r.kind,
          subjectId: r.subjectId,
          dueDate: clock(r, "Australia/Sydney")?.date ?? null,
          status: r.workingStatus,
          version: r.version,
        }),
      ),
    events,
    fetchedAt: now(),
    connection: view(await connection(ctx)),
  });
}
async function reconcile(
  request: Request,
  ctx: OrganatoContext,
  c: Connection,
  id: string,
) {
  const input = z
    .object({
      resolution: z.enum(["applied", "not_applied"]),
      organatoId: z.string().min(1).max(200).optional(),
    })
    .strict()
    .parse(await body(request));
  let op = await getOperation(ctx, id);
  if (!op)
    throw new Failure(
      404,
      "operation_not_found",
      "The operation was not found.",
    );
  if (
    op.status === "succeeded" ||
    op.status === "failed" ||
    op.status === "conflict"
  )
    return receiptResponse(receipt(op));
  if (op.status === "pending") {
    if (Date.now() - Date.parse(op.updated_at) < 60000)
      throw new Failure(
        409,
        "operation_pending",
        "The operation may still be running. Wait one minute before reconciling.",
      );
    await sql(
      ctx,
      "UPDATE centre_organato_operations SET status = 'unknown', updated_at = ? WHERE workspace_id = ? AND operation_id = ? AND status = 'pending' AND updated_at = ?",
      now(),
      ctx.auth.workspaceId,
      id,
      op.updated_at,
    ).run();
    op = await getOperation(ctx, id);
    if (!op || op.status !== "unknown")
      throw new Failure(
        409,
        "operation_busy",
        "Another request is reconciling this operation.",
      );
  }
  if (op.connection_id !== c.connection_id)
    throw new Failure(
      409,
      "connection_changed",
      "Restore the original connection before reconciling this operation.",
    );
  const claimed = await sql(
    ctx,
    "UPDATE centre_organato_operations SET status = 'pending', updated_at = ? WHERE workspace_id = ? AND operation_id = ? AND status = 'unknown' RETURNING *",
    now(),
    ctx.auth.workspaceId,
    id,
  ).first();
  if (!claimed)
    throw new Failure(
      409,
      "operation_busy",
      "Another request is reconciling this operation.",
    );
  try {
    if (input.resolution === "not_applied") {
      if (op.remote_json)
        throw new Failure(
          409,
          "remote_confirmed",
          "Organato returned a successful write. Reconcile it as applied.",
        );
      return receiptResponse(
        await saveReceipt(ctx, {
          ...receipt(op),
          status: "failed",
          error: {
            code: "reconciled_not_applied",
            message:
              "Explicitly marked not applied. Use a new operation ID for another attempt.",
          },
          reconciliationRequired: false,
        }),
      );
    }
    const plan = planSchema.parse(JSON.parse(op.plan_json));
    const saved = op.remote_json
      ? remoteSchema.parse(JSON.parse(op.remote_json))
      : null;
    const remoteId = saved?.id ?? plan.event.organatoId ?? input.organatoId;
    if (!remoteId || (input.organatoId && input.organatoId !== remoteId))
      throw new Failure(
        400,
        "organato_id_required",
        "Supply the matching Organato item ID for this operation.",
      );
    const r = parseRemoteItem(
      await remote(ctx, c, `/items/${encodeURIComponent(remoteId)}`),
    );
    if (r.id !== remoteId || !matches(plan, r))
      throw new Failure(
        409,
        "reconciliation_mismatch",
        "The Organato item does not match this operation.",
      );
    await reserveOperationLink(ctx, op, plan, r);
    await sql(
      ctx,
      "UPDATE centre_organato_operations SET remote_json = ?, updated_at = ? WHERE workspace_id = ? AND operation_id = ?",
      JSON.stringify(r),
      now(),
      ctx.auth.workspaceId,
      id,
    ).run();
    try {
      return receiptResponse(await canonical(ctx, op, plan, r));
    } catch {
      return receiptResponse(
        await saveReceipt(ctx, {
          ...receipt(op),
          expectedVersion: plan.expectedVersion,
          expectedRevision: plan.expectedRevision,
          event: canonicalEvent(plan, r),
          record: await currentRecord(ctx, plan.event.id),
          status: "unknown",
          error: {
            code: "canonical_unconfirmed",
            message:
              "The remote item is confirmed, but the canonical record could not be saved. Reconcile again after resolving the cloud conflict.",
          },
          reconciliationRequired: true,
        }),
      );
    }
  } catch (error) {
    await saveReceipt(ctx, {
      ...receipt(op),
      status: "unknown",
      reconciliationRequired: true,
    });
    throw error;
  }
}

/** Returns null outside this module's namespace. The host must authenticate first. */
export async function handleOrganatoRequest(
  request: Request,
  ctx: OrganatoContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/organato" && !path.startsWith("/v1/organato/")) return null;
  try {
    if (!ctx.auth.workspaceId || !ctx.auth.deviceId)
      throw new Failure(
        401,
        "unauthorized",
        "Workspace authentication is required.",
      );
    if (path === "/v1/organato/connection" && request.method === "GET")
      return json(view(await connection(ctx)));
    if (path === "/v1/organato/connection" && request.method === "POST") {
      const input = z
        .object({
          apiKey: z
            .string()
            .trim()
            .min(1)
            .max(1024)
            .regex(/^[\x21-\x7e]+$/),
          baseUrl: z.string().max(2048),
        })
        .strict()
        .parse(await body(request));
      const base = baseUrl(input.baseUrl, ctx);
      const version = ctx.env.ORGANATO_KEY_VERSION;
      if (!version)
        throw new Failure(
          503,
          "encryption_unavailable",
          "The current encryption key version is not configured.",
        );
      const c: Connection = {
        workspace_id: ctx.auth.workspaceId,
        connection_id: await hash([ctx.auth.workspaceId, base, input.apiKey]),
        base_url: base,
        key_version: version,
        iv: base64(crypto.getRandomValues(new Uint8Array(12))),
        ciphertext: "",
        state: "connected",
        updated_at: now(),
        message: null,
      };
      c.ciphertext = base64(
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: bytes(c.iv), additionalData: aad(ctx, c) },
            await encryptionKey(ctx, version),
            new TextEncoder().encode(input.apiKey),
          ),
        ),
      );
      // Validate the key with a read before replacing a usable saved connection.
      await remote(ctx, c, "/subjects");
      await sql(
        ctx,
        "INSERT INTO centre_organato_connections (workspace_id,connection_id,base_url,key_version,ciphertext,iv,state,updated_at,message) VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(workspace_id) DO UPDATE SET connection_id=excluded.connection_id,base_url=excluded.base_url,key_version=excluded.key_version,ciphertext=excluded.ciphertext,iv=excluded.iv,state=excluded.state,updated_at=excluded.updated_at,message=NULL",
        ctx.auth.workspaceId,
        c.connection_id,
        base,
        version,
        c.ciphertext,
        c.iv,
        c.state,
        c.updated_at,
      ).run();
      return json(view(c));
    }
    if (
      path === "/v1/organato/connection/remove" &&
      request.method === "POST"
    ) {
      z.object({})
        .strict()
        .parse(await body(request));
      await sql(
        ctx,
        "DELETE FROM centre_organato_connections WHERE workspace_id = ?",
        ctx.auth.workspaceId,
      ).run();
      return json(view(null));
    }
    const operation =
      /^\/v1\/organato\/operations\/([^/]+)(\/reconcile)?$/.exec(path);
    if (operation && !operation[2] && request.method === "GET") {
      const id = z.string().uuid().parse(operation[1]);
      const op = await getOperation(ctx, id);
      if (!op)
        throw new Failure(
          404,
          "operation_not_found",
          "The operation was not found.",
        );
      return receiptResponse(receipt(op), true);
    }
    const c = await connection(ctx);
    if (!c && (path === "/v1/organato/snapshot" || operation?.[2]))
      throw new Failure(
        503,
        "organato_unconfigured",
        "Connect Organato before using this route.",
      );
    if (c && path === "/v1/organato/snapshot" && request.method === "GET")
      return await snapshot(ctx, c);
    if (c && operation?.[2] && request.method === "POST")
      return await reconcile(
        request,
        ctx,
        c,
        z.string().uuid().parse(operation[1]),
      );
    if (path === "/v1/organato/sessions" && request.method === "POST")
      return await mutate(request, ctx, c, null, "create");
    const session =
      /^\/v1\/organato\/sessions\/([^/]+)(?:\/(complete|archive|link))?$/.exec(
        path,
      );
    if (session) {
      const id = z.string().uuid().parse(session[1]);
      if (session[2] === "link" && request.method === "POST")
        return await verifyLink(request, ctx, c, id);
      if (!session[2] && request.method === "PATCH")
        return await mutate(request, ctx, c, id, "patch");
      if (session[2] === "complete" && request.method === "POST")
        return await mutate(request, ctx, c, id, "complete");
      if (session[2] === "archive" && request.method === "POST")
        return await mutate(request, ctx, c, id, "archive");
    }
    throw new Failure(404, "not_found", "Organato route not found.");
  } catch (error) {
    if (error instanceof Failure)
      return json(
        {
          error: { code: error.code, message: error.message },
          connection: view(await connection(ctx).catch(() => null)),
        },
        error.status,
      );
    if (error instanceof z.ZodError || error instanceof RangeError)
      return json(
        {
          error: {
            code: "invalid_request",
            message:
              "The request or upstream response does not match the required schema.",
          },
        },
        400,
      );
    return json(
      {
        error: {
          code: "connector_error",
          message: "The Organato connector could not finish the request.",
        },
      },
      503,
    );
  }
}
