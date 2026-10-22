import { handleGradeRequest, type GradeRecord, type GradeMutation } from './grade';
export const AI_PROVIDER = "cloudflare-ai";
export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const MAX_USER_TEXT = 8_000;
const MAX_OUTPUT_TEXT = 20_000;
const MAX_BODY_BYTES = 4_096;
const MAX_RUNS_PER_WORKSPACE_PER_DAY = 20;
const MAX_RUNS_TOTAL_PER_DAY = 120;
const MAX_ACTIVE_RUNS = 16;
const MAX_ACTIVE_WORKSPACE = 2;
const PROVIDER_TIMEOUT_MS = 45_000;
const LEASE_MS = 5 * 60 * 1_000;
const SYSTEM_PROMPT =
  "You are Centre, a helpful study assistant. Explain ideas clearly, support the learner, and answer the latest message directly.";

type SqlValue = string | number | null | ArrayBuffer | Uint8Array;

export interface D1PreparedStatement {
  bind(...values: SqlValue[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number; duration?: number; last_row_id?: number };
  error?: string;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface CloudRecord {
  kind: string;
  id: string;
  schemaVersion: number;
  version: number;
  cursor: string;
  updatedAt: string;
  deleted: boolean;
  data: Record<string, unknown> | null;
}

export interface CloudMutation {
  mutationId: string;
  kind: string;
  id: string;
  schemaVersion: 1;
  expectedVersion: number;
  deleted: boolean;
  data: Record<string, unknown> | null;
}

export interface AiRequestContext {
  env: {
    DB?: D1Database;
    AI?: { run(model: string, input: unknown): Promise<unknown> };
  };
  auth: { workspaceId: string; deviceId: string };
  entities: {
    get(kind: string, id: string): Promise<CloudRecord | null>;
    put(mutation: CloudMutation): Promise<{ record: CloudRecord }>;
    listMessages?(chatId: string, limit: number): Promise<CloudRecord[]>;
    commit?(mutations: GradeMutation[]): Promise<unknown>;
    getPracticeAttempt?(sourceDraftId: string): Promise<GradeRecord | null>;
    listLearningNeeds?(): Promise<GradeRecord[]>;
  };
}

type RunStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

interface RunRow {
  workspace_id: string;
  run_id: string;
  device_id: string;
  chat_id: string;
  message_id: string;
  status: RunStatus;
  provider: string;
  model: string;
  error_code: string | null;
  result_text: string | null;
  assistant_message_id: string;
  assistant_mutation_id: string;
  request_context: string;
  created_at: string;
  updated_at: string;
  request_day: string;
  lease_expires_at_ms: number | null;
  lease_token: string | null;
}

type ApiRun = {
  id: string;
  chatId: string;
  messageId: string;
  status: RunStatus;
  provider: string;
  model: string;
  errorCode: string | null;
  result: string | null;
  assistantMessageId: string;
  createdAt: string;
  updatedAt: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validRecordId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function asApiRun(row: RunRow): ApiRun {
  return {
    id: row.run_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    errorCode: row.error_code,
    result: row.status === "completed" ? row.result_text : null,
    assistantMessageId: row.assistant_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRun(db: D1Database, workspaceId: string, runId: string): Promise<RunRow | null> {
  return db.prepare(
    `SELECT workspace_id,run_id,device_id,chat_id,message_id,status,provider,model,error_code,
            result_text,assistant_message_id,assistant_mutation_id,request_context,created_at,updated_at,
            request_day,lease_expires_at_ms,lease_token
       FROM centre_ai_runs WHERE workspace_id=? AND run_id=?`,
  ).bind(workspaceId, runId).first<RunRow>();
}

async function updateRun(
  db: D1Database,
  sql: string,
  values: SqlValue[],
): Promise<void> {
  await db.prepare(sql).bind(...values).run();
}

function responseFor(row: RunRow, status = row.status === "running" || row.status === "queued" ? 202 : 200): Response {
  return json({ run: asApiRun(row) }, status);
}

function updateTimestamp(): { iso: string; milliseconds: number } {
  const milliseconds = Date.now();
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function boundedOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_TEXT) return value;
  let prefix = value.slice(0, MAX_OUTPUT_TEXT - 1);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function parseProviderOutput(value: unknown): { text: string } | { error: string } {
  if (!isObject(value) || typeof value.response !== "string") return { error: "provider_invalid_response" };
  if (!value.response.trim()) return { error: "provider_empty_response" };
  return { text: boundedOutput(value.response) };
}

function validatePersistedMessage(
  chat: CloudRecord | null,
  message: CloudRecord | null,
  chatId: string,
  messageId: string,
): { content: string; requestContext: Record<string, unknown> } | { response: Response } {
  if (!chat || chat.deleted || chat.kind !== "chat" || chat.id !== chatId || chat.schemaVersion !== 1 ||
      !isObject(chat.data) || chat.data.id !== chatId) {
    return { response: error("not_found", "The requested chat or message was not found.", 404) };
  }
  if (!message || message.deleted || message.kind !== "message" || message.id !== messageId || message.schemaVersion !== 1 || !isObject(message.data)) {
    return { response: error("not_found", "The requested chat or message was not found.", 404) };
  }
  const data = message.data;
  if (data.chatId !== chatId || data.id !== messageId || data.role !== "user" || typeof data.content !== "string") {
    return { response: error("not_found", "The requested chat or message was not found.", 404) };
  }
  if (data.content.length > MAX_USER_TEXT) {
    return { response: error("input_too_large", "The saved message exceeds the 8,000 character limit.", 413) };
  }
  if (!data.content.trim()) {
    return { response: error("invalid_message", "The saved message must contain text.", 400) };
  }
  const rawContext = data.requestContext;
  const requestContext: Record<string, unknown> = { page: "chat" };
  if (isObject(rawContext)) {
    if (typeof rawContext.page === "string" && rawContext.page.length > 0 && rawContext.page.length <= 100) requestContext.page = rawContext.page;
    for (const key of ["subjectId", "topicId", "resourceId"]) {
      const value = rawContext[key];
      if (typeof value === "string" && value.length > 0 && value.length <= 200) requestContext[key] = value;
    }
  }
  return { content: data.content, requestContext };
}

type RunInput = { id: string; chatId: string; messageId: string };
async function readRequestBody(request: Request): Promise<RunInput | Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error("content_type", "Send Content-Type: application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) return error("invalid_json", "The request body must be valid JSON.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* The bounded body is already rejected. */ }
        return error("invalid_request", "The request body is too large.", 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return error("invalid_json", "The request body must be valid JSON.", 400);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return error("invalid_json", "The request body must be valid UTF-8 JSON.", 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return error("invalid_json", "The request body must be valid JSON.", 400);
  }
  if (!isObject(body)) return error("invalid_request", "Expected a JSON object.", 400);
  const keys = Object.keys(body).sort();
  if (keys.length !== 3 || keys[0] !== "chatId" || keys[1] !== "id" || keys[2] !== "messageId") {
    return error("invalid_request", "Only id, chatId, and messageId are accepted.", 400);
  }
  if (!isUuid(body.id) || !validRecordId(body.chatId) || !validRecordId(body.messageId)) {
    return error("invalid_request", "Provide a UUID run id and valid chat and message ids.", 400);
  }
  return { id: body.id, chatId: body.chatId, messageId: body.messageId };
}

async function createRun(
  db: D1Database,
  workspaceId: string,
  deviceId: string,
  runId: string,
  chatId: string,
  messageId: string,
  requestContext: Record<string, unknown>,
): Promise<{ row: RunRow | null; owned: boolean; limited: boolean }> {
  const now = updateTimestamp();
  const createdAt = now.iso;
  const requestDay = createdAt.slice(0, 10);
  const leaseExpiresAt = now.milliseconds + LEASE_MS;
  const leaseToken = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const assistantMutationId = crypto.randomUUID();

  // The D1 batch is one transaction. The insert reserves the daily and active
  // budget through indexed counts, then only this call's random token can claim it.
  await db.batch([
    db.prepare(
      `INSERT INTO centre_ai_runs (
         workspace_id,run_id,device_id,chat_id,message_id,status,provider,model,error_code,
         result_text,assistant_message_id,assistant_mutation_id,request_context,created_at,updated_at,
         request_day,lease_expires_at_ms,lease_token
       )
       SELECT ?,?,?,?,?, 'queued', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM centre_ai_runs WHERE workspace_id=? AND request_day=?) < ?
          AND (SELECT COUNT(*) FROM centre_ai_runs WHERE request_day=?) < ?
          AND (SELECT COUNT(*) FROM centre_ai_runs WHERE status='running' AND lease_expires_at_ms>?) < ?
          AND (SELECT COUNT(*) FROM centre_ai_runs WHERE workspace_id=? AND status='running' AND lease_expires_at_ms>?) < ?
       ON CONFLICT(workspace_id,run_id) DO NOTHING`,
    ).bind(
      workspaceId, runId, deviceId, chatId, messageId,
      AI_PROVIDER, AI_MODEL, assistantMessageId, assistantMutationId,
      JSON.stringify(requestContext), createdAt, createdAt, requestDay, leaseExpiresAt, leaseToken,
      workspaceId, requestDay, MAX_RUNS_PER_WORKSPACE_PER_DAY, requestDay,
      MAX_RUNS_TOTAL_PER_DAY, now.milliseconds, MAX_ACTIVE_RUNS,
      workspaceId, now.milliseconds, MAX_ACTIVE_WORKSPACE,
    ),
    db.prepare(
      `UPDATE centre_ai_runs
          SET status='running',updated_at=?,lease_expires_at_ms=?
        WHERE workspace_id=? AND run_id=? AND status='queued' AND lease_token=?`,
    ).bind(createdAt, leaseExpiresAt, workspaceId, runId, leaseToken),
  ]);

  const row = await getRun(db, workspaceId, runId);
  if (row) {
    const identityMatches = row.chat_id === chatId && row.message_id === messageId;
    return { row: identityMatches ? row : null, owned: identityMatches && row.lease_token === leaseToken, limited: false };
  }
  return { row: null, owned: false, limited: true };
}

function assistantMutation(row: RunRow, result: string): CloudMutation {
  const requestContext: unknown = JSON.parse(row.request_context);
  if (!isObject(requestContext)) throw new Error("Invalid persisted request context");
  return {
    mutationId: row.assistant_mutation_id,
    kind: "message",
    id: row.assistant_message_id,
    schemaVersion: 1,
    expectedVersion: 0,
    deleted: false,
    data: {
      id: row.assistant_message_id,
      chatId: row.chat_id,
      role: "assistant",
      content: result,
      createdAt: row.created_at,
      responseDurationMs: null,
      resourceIds: [],
      attachmentIds: [],
      requestContext: requestContext,
    },
  };
}

function assistantRecordMatches(record: CloudRecord, row: RunRow, result: string): boolean {
  const data = record.data;
  return record.kind === "message" && record.id === row.assistant_message_id && !record.deleted &&
    isObject(data) && data.id === row.assistant_message_id && data.chatId === row.chat_id &&
    data.role === "assistant" && data.content === result;
}

async function finishWithResult(
  db: D1Database,
  context: AiRequestContext,
  row: RunRow,
  result: string,
): Promise<RunRow | null> {
  const mutation = assistantMutation(row, result);
  const { record } = await context.entities.put(mutation);
  if (!record || !assistantRecordMatches(record, row, result)) {
    await updateRun(
      db,
      `UPDATE centre_ai_runs SET status='failed',error_code='assistant_persistence_conflict',
              lease_token=NULL,lease_expires_at_ms=NULL,updated_at=?
        WHERE status='running' AND workspace_id=? AND run_id=? AND result_text=?`,
      [updateTimestamp().iso, row.workspace_id, row.run_id, result],
    );
    return getRun(db, row.workspace_id, row.run_id);
  }
  const now = updateTimestamp();
  await updateRun(
    db,
    `UPDATE centre_ai_runs SET status='completed',error_code=NULL,lease_token=NULL,
            lease_expires_at_ms=NULL,updated_at=?
      WHERE status='running' AND workspace_id=? AND run_id=? AND result_text=?`,
    [now.iso, row.workspace_id, row.run_id, result],
  );
  return getRun(db, row.workspace_id, row.run_id);
}

async function persistKnownResult(
  db: D1Database,
  context: AiRequestContext,
  row: RunRow,
  result: string,
): Promise<RunRow | null> {
  if (!row.result_text) {
    const now = updateTimestamp();
    const persist = () => updateRun(
      db,
      `UPDATE centre_ai_runs SET result_text=?,updated_at=?
        WHERE status='running' AND workspace_id=? AND run_id=? AND lease_token=?
          AND lease_expires_at_ms>? AND result_text IS NULL`,
      [result, now.iso, row.workspace_id, row.run_id, row.lease_token ?? "", now.milliseconds],
    );
    try {
      await persist();
    } catch {
      // This is an idempotent, deterministic D1 update. Retry once if the
      // reply was lost before deciding the known provider result is at risk.
      await persist();
    }
    const refreshed = await getRun(db, row.workspace_id, row.run_id);
    if (!refreshed) return null;
    if (refreshed.status === "completed" || refreshed.status === "failed" || refreshed.status === "interrupted") return refreshed;
    if (refreshed.result_text !== result) return interruptedIfExpired(db, refreshed);
    row = refreshed;
  }
  if (row.result_text !== result) return row;
  try {
    return await finishWithResult(db, context, row, result);
  } catch {
    // The entity write may have committed even if its reply was lost. The
    // stored result plus deterministic mutation id make the next GET safe.
    return getRun(db, row.workspace_id, row.run_id);
  }
}

async function markTerminal(
  db: D1Database,
  row: RunRow,
  status: "failed" | "interrupted",
  errorCode: string,
): Promise<RunRow | null> {
  const now = updateTimestamp();
  await updateRun(
    db,
    `UPDATE centre_ai_runs SET status=?,error_code=?,lease_token=NULL,lease_expires_at_ms=NULL,updated_at=?
      WHERE status='running' AND workspace_id=? AND run_id=? AND lease_token=? AND result_text IS NULL`,
    [status, errorCode, now.iso, row.workspace_id, row.run_id, row.lease_token ?? ""],
  );
  return getRun(db, row.workspace_id, row.run_id);
}

async function interruptedIfExpired(db: D1Database, row: RunRow): Promise<RunRow | null> {
  if (row.status !== "running" || row.result_text !== null) return row;
  const now = updateTimestamp();
  if (row.lease_expires_at_ms !== null && row.lease_expires_at_ms > now.milliseconds) return row;
  await updateRun(
    db,
    `UPDATE centre_ai_runs SET status='interrupted',error_code='run_interrupted',lease_token=NULL,
            lease_expires_at_ms=NULL,updated_at=?
      WHERE status='running' AND workspace_id=? AND run_id=? AND result_text IS NULL
        AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=?)`,
    [now.iso, row.workspace_id, row.run_id, now.milliseconds],
  );
  return getRun(db, row.workspace_id, row.run_id);
}

async function recoverOrExpire(
  db: D1Database,
  context: AiRequestContext,
  row: RunRow,
): Promise<RunRow | null> {
  if (row.status === "queued") {
    const now = updateTimestamp();
    await updateRun(
      db,
      `UPDATE centre_ai_runs SET status='interrupted',error_code='run_interrupted',
              lease_token=NULL,lease_expires_at_ms=NULL,updated_at=?
        WHERE workspace_id=? AND run_id=? AND status='queued'`,
      [now.iso, row.workspace_id, row.run_id],
    );
    return getRun(db, row.workspace_id, row.run_id);
  }
  if (row.status !== "running") return row;
  if (row.result_text !== null) return persistKnownResult(db, context, row, row.result_text);
  return interruptedIfExpired(db, row);
}

async function startProvider(
  db: D1Database,
  context: AiRequestContext,
  row: RunRow,
  userText: string,
  ai: NonNullable<AiRequestContext["env"]["AI"]>,
): Promise<RunRow | null> {
  let response: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([ai.run(AI_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      max_tokens: 1_024,
      stream: false,
    }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Provider deadline exceeded")), PROVIDER_TIMEOUT_MS); timer.unref?.(); })]);
  } catch {
    // A rejected provider call can mean the provider completed but the reply
    // was lost. Do not retry it from this run id.
    return markTerminal(db, row, "interrupted", "provider_outcome_unknown");
  } finally { if (timer) clearTimeout(timer); }
  const parsed = parseProviderOutput(response);
  if ("error" in parsed) return markTerminal(db, row, "failed", parsed.error);
  try {
    return await persistKnownResult(db, context, row, parsed.text);
  } catch {
    // If the D1 reply was ambiguous, recover only from its durable result.
    // Never call the provider again for a result that may have been lost.
    const latest = await getRun(db, row.workspace_id, row.run_id);
    if (!latest) return null;
    if (latest.result_text !== null) return persistKnownResult(db, context, latest, latest.result_text);
    return markTerminal(db, latest, "interrupted", "result_persistence_unknown");
  }
}

function validAuth(context: AiRequestContext): boolean {
  return typeof context?.auth?.workspaceId === "string" && context.auth.workspaceId.length > 0 &&
    typeof context.auth.deviceId === "string" && context.auth.deviceId.length > 0;
}

export async function handleAiRequest(request: Request, context: AiRequestContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/ai/grades" || url.pathname.startsWith("/v1/ai/grades/")) {
    if (!validAuth(context)) return error("unauthorized", "Authentication is required.", 401);
    const { commit, getPracticeAttempt, listLearningNeeds } = context.entities;
    if (!commit || !getPracticeAttempt || !listLearningNeeds) return error("unconfigured", "Trusted quiz marking is not configured.", 503);
    return handleGradeRequest(request, { env: context.env, auth: context.auth, entities: { get: context.entities.get, commit, getPracticeAttempt, listLearningNeeds } });
  }
  if (url.pathname !== "/v1/ai/runs" && !/^\/v1\/ai\/runs\/[^/]+$/.test(url.pathname)) return null;
  if (!validAuth(context)) return error("unauthorized", "Authentication is required.", 401);
  if (!context.env?.DB) return error("service_unavailable", "The AI service is not configured.", 503);
  const db = context.env.DB;
  const workspaceId = context.auth.workspaceId;

  if (url.pathname === "/v1/ai/runs") {
    if (request.method !== "POST") return error("method_not_allowed", "Use POST for this route.", 405);
    const body = await readRequestBody(request);
    if (body instanceof Response) return body;
    const runId = body.id.toLowerCase();
    const chatId = body.chatId;
    const messageId = body.messageId;

    try {
      let row = await getRun(db, workspaceId, runId);
      if (row) {
        if (row.chat_id !== chatId || row.message_id !== messageId) {
          return error("idempotency_mismatch", "This run id is already bound to another request.", 409);
        }
        row = await recoverOrExpire(db, context, row);
        if (!row) return error("service_unavailable", "The run state could not be read.", 503);
        if (row.status !== "running") return responseFor(row);
        return responseFor(row);
      }

      const ai = context.env.AI;
      if (!ai || typeof ai.run !== "function") return error("service_unavailable", "The AI service is not configured.", 503);
      const [chat, message] = await Promise.all([
        context.entities.get("chat", chatId),
        context.entities.get("message", messageId),
      ]);
      const input = validatePersistedMessage(chat, message, chatId, messageId);
      if ("response" in input) return input.response;

      const created = await createRun(db, workspaceId, context.auth.deviceId, runId, chatId, messageId, input.requestContext);
      if (!created.row) {
        const raced = await getRun(db, workspaceId, runId);
        if (raced) {
          if (raced.chat_id !== chatId || raced.message_id !== messageId) {
            return error("idempotency_mismatch", "This run id is already bound to another request.", 409);
          }
          const recovered = await recoverOrExpire(db, context, raced);
          return recovered ? responseFor(recovered) : error("service_unavailable", "The run state could not be read.", 503);
        }
        return created.limited
          ? error("rate_limited", "The hosted AI request limit has been reached. Try again later.", 429)
          : error("service_unavailable", "The run state could not be created.", 503);
      }
      if (!created.owned) return responseFor(created.row);
      const finished = await startProvider(db, context, created.row, input.content, ai);
      return finished ? responseFor(finished) : error("service_unavailable", "The run state could not be saved.", 503);
    } catch {
      return error("service_unavailable", "The run could not be processed safely.", 503);
    }
  }

  if (request.method !== "GET") return error("method_not_allowed", "Use GET for this route.", 405);
  const rawId = url.pathname.slice("/v1/ai/runs/".length);
  if (!isUuid(rawId)) return error("not_found", "The requested run was not found.", 404);
  try {
    let row = await getRun(db, workspaceId, rawId.toLowerCase());
    if (!row) return error("not_found", "The requested run was not found.", 404);
    row = await recoverOrExpire(db, context, row);
    if (!row) return error("service_unavailable", "The run state could not be read.", 503);
    return responseFor(row, 200);
  } catch {
    return error("service_unavailable", "The run could not be read safely.", 503);
  }
}
