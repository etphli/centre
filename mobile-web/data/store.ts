import {
  CLOUD_LIMITS,
  cloudAuthSchema,
  cloudChangesSchema,
  cloudMutationSchema,
  cloudRecordSchema,
  type CloudAuth,
  type CloudMutation,
  type CloudRecord,
} from "../../shared/cloud";
import { CLOUD_ENTITY_KINDS, parseCloudEntity } from "../../shared/cloud-entities";
import { recoverStudySession, studySessionSchema } from "../../shared/study-log";
import { z } from "zod";

const DATABASE_VERSION = 1;
const DATABASE_STORE = "mobile-state";
const DATABASE_KEY = "root";
const PAGE_SIZE = 100;
const MAX_PULL_PAGES = 200;
const MAX_MUTATIONS_PER_SYNC = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_URL_LENGTH = 4_096;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CURSOR = 9_223_372_036_854_775_807n;
const DEVICE_NAME = "Centre iPhone web";

export type MobileEntity =
  | (Omit<CloudRecord, "version"> & { version: 0 })
  | CloudRecord;

export interface MobileConflict {
  key: string;
  kind: string;
  id: string;
  local: MobileEntity;
  remote: CloudRecord | null;
}

export type MobilePhase =
  | "unpaired"
  | "ready"
  | "offline"
  | "syncing"
  | "auth-required"
  | "error";

export interface MobileState {
  session: CloudAuth | null;
  entities: MobileEntity[];
  pending: number;
  conflicts: MobileConflict[];
  phase: MobilePhase;
  error: string | null;
  lastSyncedAt: string | null;
}

export type PendingDelivery = "queued" | "uncertain" | "blocked";

export interface PendingMutation {
  mutation: CloudMutation;
  delivery: PendingDelivery;
}

export interface MobileWorkspaceState {
  workspaceId: string;
  session: CloudAuth | null;
  cursor: string;
  entities: Record<string, MobileEntity>;
  shadow: Record<string, CloudRecord>;
  outbox: PendingMutation[];
  conflicts: Record<string, CloudRecord | null>;
  localValues: Record<string, unknown>;
  error: string | null;
  errorKind: "offline" | "error" | null;
  lastSyncedAt: string | null;
}

export interface PersistedMobileState {
  schemaVersion: 1;
  origin: string;
  revision: number;
  activeWorkspaceId: string | null;
  lastWorkspaceId: string | null;
  workspaces: Record<string, MobileWorkspaceState>;
}

export interface Persistence {
  read(): Promise<PersistedMobileState>;
  transact<T>(
    update: (
      current: PersistedMobileState,
    ) => { state: PersistedMobileState; result: T },
  ): Promise<T>;
}

export interface MobileStoreOptions {
  origin?: string;
  fetch?: typeof fetch;
  persistence?: Persistence;
  now?: () => number;
}

export class MobileRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current: CloudRecord | null = null,
  ) {
    super(message);
    this.name = "MobileRequestError";
  }
}

class SessionChangedError extends Error {
  constructor() {
    super("The Centre account changed while that request was running.");
    this.name = "SessionChangedError";
  }
}

const persistedEntitySchema = cloudRecordSchema.extend({
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const pendingMutationSchema = cloudMutationSchema;
const decimalCursorSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/);
const persistedWorkspaceSchema = z.object({
  workspaceId: z.string(),
  session: cloudAuthSchema.nullable(),
  cursor: decimalCursorSchema,
  entities: z.record(z.string(), persistedEntitySchema),
  shadow: z.record(z.string(), cloudRecordSchema),
  outbox: z.array(z.object({
    mutation: pendingMutationSchema,
    delivery: z.enum(["queued", "uncertain", "blocked"]),
  }).strict()),
  conflicts: z.record(z.string(), cloudRecordSchema.nullable()),
  localValues: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  errorKind: z.enum(["offline", "error"]).nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
}).strict();
const persistedStateSchema = z.object({
  schemaVersion: z.literal(1),
  origin: z.string(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  activeWorkspaceId: z.string().nullable(),
  lastWorkspaceId: z.string().nullable(),
  workspaces: z.record(z.string(), persistedWorkspaceSchema),
}).strict();

function slot(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

function entityKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function storageKey(kind: string, id: string): string {
  return slot("e:", JSON.stringify([kind, id]));
}

function workspaceKey(workspaceId: string): string {
  return slot("w:", workspaceId);
}

function parsePersistedState(value: unknown): PersistedMobileState {
  const state = persistedStateSchema.parse(value);
  for (const workspace of Object.values(state.workspaces)) {
    for (const entity of Object.values(workspace.entities)) {
      if (entity.data && CLOUD_ENTITY_KINDS.includes(entity.kind)) {
        const data = parseCloudEntity(entity.kind, entity.data);
        if (typeof data.id === "string" && data.id !== entity.id) {
          throw new Error("Stored cloud record ID does not match its canonical data.");
        }
      }
    }
    for (const remote of Object.values(workspace.shadow)) parsedRecord(remote);
    for (const remote of Object.values(workspace.conflicts)) {
      if (remote) parsedRecord(remote);
    }
    for (const entry of workspace.outbox) {
      const { mutation } = entry;
      if (!CLOUD_ENTITY_KINDS.includes(mutation.kind) || mutation.kind === "practice.attempt") {
        throw new Error("Stored outbox contains a record kind that mobile cannot write.");
      }
      if (mutation.data) {
        const data = parseCloudEntity(mutation.kind, mutation.data);
        if (typeof data.id === "string" && data.id !== mutation.id) {
          throw new Error("Stored cloud mutation ID does not match its canonical data.");
        }
      }
    }
  }
  return state;
}

function emptyWorkspace(workspaceId: string): MobileWorkspaceState {
  return {
    workspaceId,
    session: null,
    cursor: "0",
    entities: {},
    shadow: {},
    outbox: [],
    conflicts: {},
    localValues: {},
    error: null,
    errorKind: null,
    lastSyncedAt: null,
  };
}

function emptyPersistedState(origin = ""): PersistedMobileState {
  return {
    schemaVersion: 1,
    origin,
    revision: 0,
    activeWorkspaceId: null,
    lastWorkspaceId: null,
    workspaces: {},
  };
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function normalizeOrigin(input: string | undefined): string {
  const value = input ?? globalThis.location?.origin;
  if (!value) throw new Error("A page origin is required to open the Centre mobile store.");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new Error("Centre mobile storage requires this page's HTTPS origin.");
  }
  return url.origin;
}

function createIdbPersistence(origin: string): Persistence {
  let databasePromise: Promise<IDBDatabase> | null = null;

  const openDatabase = (): Promise<IDBDatabase> => {
    if (databasePromise) return databasePromise;
    const factory = globalThis.indexedDB;
    if (!factory) {
      throw new Error("IndexedDB is unavailable in this browser.");
    }
    databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(`centre-mobile:${origin}`, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(DATABASE_STORE);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
      request.onblocked = () => reject(new Error("IndexedDB is blocked by another Centre tab."));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
    return databasePromise;
  };

  return {
    async read() {
      const database = await openDatabase();
      return new Promise<PersistedMobileState>((resolve, reject) => {
        const transaction = database.transaction(DATABASE_STORE, "readonly");
        const request = transaction.objectStore(DATABASE_STORE).get(DATABASE_KEY);
        let result: PersistedMobileState | null = null;
        let failure: unknown;
        request.onsuccess = () => {
          try {
            const stored: unknown = request.result;
            result = stored === undefined ? emptyPersistedState(origin) : parsePersistedState(stored);
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
        request.onerror = () => {
          failure = request.error ?? new Error("IndexedDB could not read Centre data.");
          transaction.abort();
        };
        transaction.oncomplete = () => {
          if (failure) reject(failure);
          else resolve(result ?? emptyPersistedState(origin));
        };
        transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("IndexedDB read failed."));
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("IndexedDB read was interrupted."));
      });
    },
    async transact<T>(update: (current: PersistedMobileState) => { state: PersistedMobileState; result: T }) {
      const database = await openDatabase();
      return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(DATABASE_STORE, "readwrite");
        const objectStore = transaction.objectStore(DATABASE_STORE);
        const request = objectStore.get(DATABASE_KEY);
        let result: { value: T } | null = null;
        let failure: unknown;
        request.onsuccess = () => {
          try {
            const stored: unknown = request.result;
            const current = stored === undefined ? emptyPersistedState(origin) : parsePersistedState(stored);
            if (current.origin && current.origin !== origin) {
              throw new Error("This IndexedDB library belongs to another page origin.");
            }
            const updated = update(current);
            const next = parsePersistedState(updated.state);
            if (next.origin !== origin) throw new Error("Mobile storage origin cannot change.");
            result = { value: updated.result };
            objectStore.put(next, DATABASE_KEY);
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
        request.onerror = () => {
          failure = request.error ?? new Error("IndexedDB could not read Centre data.");
          transaction.abort();
        };
        transaction.oncomplete = () => {
          if (result) resolve(result.value);
          else reject(new Error("IndexedDB transaction completed without a result."));
        };
        transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("IndexedDB write failed."));
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("IndexedDB write was interrupted."));
      });
    },
  };
}

interface RequestContext {
  generation: number;
  workspaceId: string;
  session: CloudAuth;
}

interface RemoteRecordReply {
  record: CloudRecord;
}

function parseRemoteReply(value: unknown): RemoteRecordReply {
  return z.object({ record: cloudRecordSchema }).strict().parse(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameProjection(
  left: Pick<CloudRecord, "deleted" | "data"> | undefined,
  right: Pick<CloudRecord, "deleted" | "data"> | undefined,
): boolean {
  return left?.deleted === right?.deleted && stableJson(left?.data) === stableJson(right?.data);
}

function parsedRecord(record: CloudRecord): CloudRecord {
  const validated = cloudRecordSchema.parse(record);
  if (!Number.isSafeInteger(validated.version)) throw new Error("Cloud record version is outside the supported integer range.");
  if (validated.data && CLOUD_ENTITY_KINDS.includes(validated.kind)) {
    const data = parseCloudEntity(validated.kind, validated.data);
    if (typeof data.id === "string" && data.id !== validated.id) {
      throw new Error("Cloud record ID does not match its canonical data.");
    }
    return { ...validated, data };
  }
  return validated;
}

function dateNow(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value)) throw new Error("The mobile store clock returned an invalid time.");
  return new Date(value).toISOString();
}

function expectedVersionFor(workspace: MobileWorkspaceState, kind: string, id: string): number {
  const key = entityKey(kind, id);
  const current = workspace.shadow[storageKey(kind, id)]?.version ?? 0;
  const expectedVersion = workspace.outbox
    .filter((entry) => entityKey(entry.mutation.kind, entry.mutation.id) === key)
    .reduce((version, entry) => Math.max(version, entry.mutation.expectedVersion + 1), current);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER) {
    throw new Error("This record has reached the cloud version limit.");
  }
  return expectedVersion;
}

function makeMutation(
  workspace: MobileWorkspaceState,
  entity: MobileEntity,
  expectedVersion = expectedVersionFor(workspace, entity.kind, entity.id),
): CloudMutation {
  const mutation = cloudMutationSchema.parse({
    mutationId: crypto.randomUUID(),
    kind: entity.kind,
    id: entity.id,
    schemaVersion: 1,
    expectedVersion,
    deleted: entity.deleted,
    data: entity.data,
  });
  if (new TextEncoder().encode(JSON.stringify(mutation)).byteLength > CLOUD_LIMITS.recordBytes) {
    throw new Error("Cloud record is larger than the Centre mobile record limit.");
  }
  return mutation;
}

function setEntity(workspace: MobileWorkspaceState, entity: MobileEntity): void {
  workspace.entities[storageKey(entity.kind, entity.id)] = entity;
}

function clearRecordOutbox(workspace: MobileWorkspaceState, kind: string, id: string): void {
  const key = entityKey(kind, id);
  workspace.outbox = workspace.outbox.filter((entry) => entityKey(entry.mutation.kind, entry.mutation.id) !== key);
}

function enqueueEntity(workspace: MobileWorkspaceState, entity: MobileEntity, expectedVersion?: number): void {
  const key = entityKey(entity.kind, entity.id);
  const queuedTail: number[] = [];
  for (let index = workspace.outbox.length - 1; index >= 0; index--) {
    const entry = workspace.outbox[index];
    if (entityKey(entry.mutation.kind, entry.mutation.id) !== key) continue;
    if (entry.delivery !== "queued") break;
    queuedTail.push(index);
  }

  if (queuedTail.length > 0) {
    const firstQueued = queuedTail.at(-1);
    const lastQueued = queuedTail[0];
    if (firstQueued === undefined || lastQueued === undefined) {
      throw new Error("The mobile outbox queue changed while coalescing an edit.");
    }
    const expected = expectedVersion ?? workspace.outbox[firstQueued]?.mutation.expectedVersion;
    if (expected === undefined) throw new Error("The queued mobile mutation is incomplete.");
    const replacement = { mutation: makeMutation(workspace, entity, expected), delivery: "queued" as const };
    const replaced = new Set(queuedTail);
    workspace.outbox = workspace.outbox.flatMap((entry, index) =>
      index === lastQueued ? [replacement] : replaced.has(index) ? [] : [entry],
    );
    return;
  }

  if (workspace.outbox.length >= CLOUD_LIMITS.records) {
    throw new Error("The offline mutation queue reached the Centre cloud record limit.");
  }
  workspace.outbox.push({ mutation: makeMutation(workspace, entity, expectedVersion), delivery: "queued" });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertPersistedOrigin(state: PersistedMobileState, origin: string): void {
  if (state.origin && state.origin !== origin) {
    throw new Error("This mobile data library belongs to another page origin.");
  }
}

function activeWorkspace(state: PersistedMobileState): MobileWorkspaceState | null {
  const id = state.activeWorkspaceId;
  return id ? state.workspaces[workspaceKey(id)] ?? null : null;
}

function parsePairCode(code: string): string {
  if (code.length < 32 || code.length > 200 || !/^[\x20-\x7e]+$/.test(code)) {
    throw new Error("Pairing code must contain 32 to 200 ASCII characters.");
  }
  return code;
}

function requestUrl(origin: string, path: string): URL {
  if (path.length > MAX_URL_LENGTH || !path.startsWith("/v1/") || path.startsWith("//") || path.includes("\\")) {
    throw new MobileRequestError(400, "invalid_path", "Centre requests must stay on this origin under /v1/.");
  }
  const url = new URL(path, origin);
  const forbiddenKeys = new Set([
    "token", "accesstoken", "authorization", "idtoken", "code", "secret",
    "apikey", "clientsecret", "password", "pairingcode", "session", "bearer",
  ]);
  if (
    url.origin !== origin ||
    !url.pathname.startsWith("/v1/") ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => forbiddenKeys.has(key.toLowerCase().replaceAll("_", "").replaceAll("-", "")))
  ) {
    throw new MobileRequestError(400, "invalid_path", "Centre requests must stay on this origin under /v1/ and keep credentials out of the URL.");
  }
  return url;
}

function isPublicPathAllowed(url: URL, method: string): boolean {
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/v1/records" || path === "/v1/changes") return false;
  return method === "GET" || method === "HEAD" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function combineSignals(signal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => controller.abort(source.reason);
  if (signal.aborted) abortFrom(signal);
  else signal.addEventListener("abort", () => abortFrom(signal), { once: true });
  if (timeout.aborted) abortFrom(timeout);
  else timeout.addEventListener("abort", () => abortFrom(timeout), { once: true });
  return controller.signal;
}

function assertJsonRequestBody(body: BodyInit | null | undefined): void {
  if (body === undefined || body === null) return;
  if (typeof body !== "string") {
    throw new MobileRequestError(400, "invalid_body", "Centre mobile API requests must use bounded JSON bodies.");
  }
  if (new TextEncoder().encode(body).byteLength > CLOUD_LIMITS.recordBytes) {
    throw new MobileRequestError(413, "bounds", "Centre mobile API request is larger than the cloud record limit.");
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Centre returned a response larger than the mobile client limit.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Centre returned a response larger than the mobile client limit.");
  }
  if (text.length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error("Centre returned an invalid JSON response.");
  }
}

function mobileHttpError(status: number, value: unknown): MobileRequestError {
  const parsed = z.object({
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
    current: cloudRecordSchema.nullable().optional(),
  }).passthrough().safeParse(value);
  if (!parsed.success) {
    return new MobileRequestError(status, "http_error", `Centre returned HTTP ${status}.`);
  }
  return new MobileRequestError(
    status,
    parsed.data.error.code,
    parsed.data.error.message,
    parsed.data.current ?? null,
  );
}

function isOfflineError(error: unknown): boolean {
  if (error instanceof MobileRequestError) return error.status >= 500 || error.status === 429;
  if (error instanceof SessionChangedError) return false;
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
  return error instanceof TypeError;
}

function errorText(error: unknown): string {
  if (error instanceof MobileRequestError) return error.message;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "Centre did not respond before the mobile request timed out.";
  return error instanceof Error ? error.message : "Centre mobile sync failed.";
}

function withTransport(entity: MobileEntity, record: CloudRecord): MobileEntity {
  return {
    ...entity,
    version: record.version,
    cursor: record.cursor,
    ...(record.createdCursor === undefined ? {} : { createdCursor: record.createdCursor }),
  };
}

function recoverImportedRecord(record: CloudRecord, now: number): MobileEntity {
  if (record.kind !== "studySession" || record.deleted || !record.data) return record;
  const session = studySessionSchema.parse(record.data);
  const recovered = recoverStudySession(session, now, true);
  if (recovered === session) return record;
  const data = parseCloudEntity("studySession", recovered);
  return { ...record, updatedAt: recovered.updatedAt, data };
}

function domainIdentityConflict(
  workspace: MobileWorkspaceState,
  remote: CloudRecord,
): string | null {
  if (remote.deleted || !remote.data) return null;
  if (remote.kind === "studyGoal") {
    const incoming = parseCloudEntity(remote.kind, remote.data);
    const duplicate = Object.values(workspace.entities).find((entity) => {
      if (entity.kind !== "studyGoal" || entity.id === remote.id || entity.deleted || !entity.data) return false;
      const local = parseCloudEntity("studyGoal", entity.data);
      return local.weekStart === incoming.weekStart && local.timeZone === incoming.timeZone;
    });
    return duplicate ? entityKey(duplicate.kind, duplicate.id) : null;
  }
  if (remote.kind === "practice.learningNeed") {
    const incoming = parseCloudEntity(remote.kind, remote.data);
    const duplicate = Object.values(workspace.entities).find((entity) => {
      if (entity.kind !== "practice.learningNeed" || entity.id === remote.id || entity.deleted || !entity.data) return false;
      const local = parseCloudEntity("practice.learningNeed", entity.data);
      return local.subjectId === incoming.subjectId && local.topicId === incoming.topicId && local.conceptKey === incoming.conceptKey;
    });
    return duplicate ? entityKey(duplicate.kind, duplicate.id) : null;
  }
  return null;
}

function applyRemotePage(
  workspace: MobileWorkspaceState,
  records: CloudRecord[],
  nextCursor: string,
  now: number,
): void {
  const cursor = BigInt(workspace.cursor);
  const parsed = records.map(parsedRecord);
  let previousRecordCursor = cursor;
  for (const record of parsed) {
    const recordCursor = BigInt(record.cursor);
    if (recordCursor <= cursor || recordCursor < previousRecordCursor || recordCursor > BigInt(nextCursor)) {
      throw new Error("Centre returned records outside the requested cursor page.");
    }
    previousRecordCursor = recordCursor;
  }

  for (const remote of parsed) {
    const key = storageKey(remote.kind, remote.id);
    const local = workspace.entities[key];
    const localKey = entityKey(remote.kind, remote.id);
    const priorShadow = workspace.shadow[key];
    if (priorShadow && priorShadow.version >= remote.version) continue;

    workspace.shadow[key] = remote;
    const duplicateKey = domainIdentityConflict(workspace, remote);
    const pending = workspace.outbox.some((entry) => entityKey(entry.mutation.kind, entry.mutation.id) === localKey);
    const acknowledgesUncertainMutation = workspace.outbox.some(({ mutation, delivery }) =>
      delivery === "uncertain" &&
      entityKey(mutation.kind, mutation.id) === localKey &&
      mutation.expectedVersion + 1 === remote.version &&
      sameProjection(mutation, remote),
    );
    if (duplicateKey) {
      workspace.conflicts[duplicateKey] = remote;
      continue;
    }

    if (pending && !sameProjection(local, remote) && !acknowledgesUncertainMutation) {
      workspace.conflicts[localKey] = remote;
      continue;
    }
    if (pending) continue;

    const imported = recoverImportedRecord(remote, now);
    setEntity(workspace, imported);
    if (!sameProjection(imported, remote)) {
      const mutation = makeMutation(workspace, imported, remote.version);
      workspace.outbox.push({ mutation, delivery: "queued" });
    }
  }

  workspace.cursor = nextCursor;
}

function sortedEntities(workspace: MobileWorkspaceState | null): MobileEntity[] {
  if (!workspace) return [];
  return Object.values(workspace.entities).sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

function buildConflicts(workspace: MobileWorkspaceState | null): MobileConflict[] {
  if (!workspace) return [];
  return Object.entries(workspace.conflicts)
    .flatMap(([key, remote]) => {
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator);
      const id = key.slice(separator + 1);
      const local = workspace.entities[storageKey(kind, id)];
      return local ? [{ key, kind, id, local, remote }] : [];
    })
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function updateWorkspace(
  state: PersistedMobileState,
  workspaceId: string,
  update: (workspace: MobileWorkspaceState) => void,
): void {
  const key = workspaceKey(workspaceId);
  const workspace = state.workspaces[key] ?? emptyWorkspace(workspaceId);
  update(workspace);
  state.workspaces[key] = workspace;
}

function requestContext(state: PersistedMobileState, generation: number): RequestContext {
  const id = state.activeWorkspaceId;
  const workspace = activeWorkspace(state);
  if (!id || !workspace?.session) throw new MobileRequestError(401, "auth_required", "Pair Centre before making cloud requests.");
  return { generation, workspaceId: id, session: workspace.session };
}

function contextMatches(state: PersistedMobileState, context: RequestContext): boolean {
  const workspace = state.workspaces[workspaceKey(context.workspaceId)];
  return state.activeWorkspaceId === context.workspaceId && workspace?.session?.token === context.session.token;
}

function recordRevision(data: Record<string, unknown> | null): number | null {
  const revision = data?.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function bumpDomainRevision(
  kind: string,
  local: MobileEntity,
  remote: CloudRecord | null,
  now: string,
): MobileEntity {
  if (local.deleted || !local.data) return { ...local, updatedAt: now };
  const localRevision = recordRevision(local.data);
  const remoteRevision = remote && !remote.deleted ? recordRevision(remote.data) : null;
  const data: Record<string, unknown> = { ...local.data };
  if (typeof data.updatedAt === "string") data.updatedAt = now;
  if (localRevision !== null || remoteRevision !== null) {
    data["revision"] = Math.max(localRevision ?? 0, remoteRevision ?? 0) + 1;
  }
  const validated = parseCloudEntity(kind, data);
  return { ...local, updatedAt: now, data: validated };
}

export class MobileStore {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly persistence: Persistence;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly channel: BroadcastChannel | null;
  private persisted = emptyPersistedState();
  private snapshot: MobileState = {
    session: null,
    entities: [],
    pending: 0,
    conflicts: [],
    phase: "unpaired",
    error: null,
    lastSyncedAt: null,
  };
  private openPromise: Promise<void> | null = null;
  private opened = false;
  private generation = 0;
  private syncPromise: Promise<void> | null = null;
  private syncing = false;

  constructor(options: MobileStoreOptions = {}) {
    this.origin = normalizeOrigin(options.origin);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.persistence = options.persistence ?? createIdbPersistence(this.origin);
    this.now = options.now ?? Date.now;
    this.channel = typeof window === "undefined" || typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(`centre-mobile:${this.origin}`);
    if (this.channel) {
      this.channel.onmessage = () => {
        void this.refreshFromPersistence(true).catch(() => undefined);
      };
    }
  }

  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = this.openOnce();
    return this.openPromise;
  }

  private async openOnce(): Promise<void> {
    const stored = parsePersistedState(await this.persistence.read());
    assertPersistedOrigin(stored, this.origin);
    await this.transact((state) => {
      if (state.origin && state.origin !== this.origin) {
        throw new Error("This mobile data library belongs to another page origin.");
      }
      state.origin = this.origin;
      const workspaceId = state.activeWorkspaceId ?? state.lastWorkspaceId;
      if (workspaceId) {
        updateWorkspace(state, workspaceId, (workspace) => {
          const expiry = workspace.session ? Date.parse(workspace.session.expiresAt) : Number.POSITIVE_INFINITY;
          if (workspace.session && expiry <= this.now()) {
            workspace.session = null;
            workspace.error = "The Centre session expired. Pair again to sync this cached library.";
            workspace.errorKind = null;
          }
          const recoveryTime = this.now();
          for (const entity of Object.values(workspace.entities)) {
            if (entity.kind !== "studySession" || entity.deleted || !entity.data) continue;
            const session = studySessionSchema.safeParse(entity.data);
            if (!session.success || session.data.state.kind !== "running") continue;
            const recovered = recoverStudySession(session.data, recoveryTime, true);
            const next: MobileEntity = {
              ...entity,
              updatedAt: recovered.updatedAt,
              data: parseCloudEntity("studySession", recovered),
            };
            setEntity(workspace, next);
            if (!Object.hasOwn(workspace.conflicts, entityKey(entity.kind, entity.id))) {
              enqueueEntity(workspace, next);
            }
          }
        });
      }
    });
    this.opened = true;
    await this.refreshFromPersistence(false);
  }

  getSnapshot(): MobileState {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async pair(code: string): Promise<void> {
    await this.ensureOpen();
    const exactCode = parsePairCode(code);
    const generation = ++this.generation;
    const startingAuthority = await this.readState();
    const startingWorkspaceId = startingAuthority.activeWorkspaceId;
    const startingToken = activeWorkspace(startingAuthority)?.session?.token ?? null;
    const url = new URL("/v1/auth/pair", this.origin);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: exactCode, deviceName: DEVICE_NAME }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      mode: "same-origin",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
      throw new MobileRequestError(502, "redirect_blocked", "Centre returned a response from another origin.");
    }
    const value = await readJsonResponse(response);
    if (!response.ok) throw mobileHttpError(response.status, value);
    if (generation !== this.generation) throw new SessionChangedError();
    const session = cloudAuthSchema.parse(value);
    if (Date.parse(session.expiresAt) <= this.now()) {
      throw new MobileRequestError(401, "expired_session", "Centre returned an expired session.");
    }
    await this.transact((state) => {
      if (generation !== this.generation) throw new SessionChangedError();
      if (
        state.activeWorkspaceId !== startingWorkspaceId ||
        (activeWorkspace(state)?.session?.token ?? null) !== startingToken
      ) {
        throw new SessionChangedError();
      }
      state.origin = this.origin;
      const key = workspaceKey(session.workspaceId);
      const workspace = state.workspaces[key] ?? emptyWorkspace(session.workspaceId);
      workspace.session = session;
      workspace.error = null;
      workspace.errorKind = null;
      state.workspaces[key] = workspace;
      state.activeWorkspaceId = session.workspaceId;
      state.lastWorkspaceId = session.workspaceId;
    });
  }

  async disconnect(): Promise<void> {
    await this.ensureOpen();
    this.generation++;
    await this.transact((state) => {
      const currentId = state.activeWorkspaceId;
      if (currentId) {
        updateWorkspace(state, currentId, (workspace) => {
          workspace.session = null;
        });
        state.lastWorkspaceId = currentId;
      }
      state.activeWorkspaceId = null;
    });
  }

  async save(
    kind: string,
    id: string,
    data: Record<string, unknown> | null,
    deleted = false,
  ): Promise<void> {
    await this.ensureOpen();
    if (!kind || kind.length > 100 || !id || id.length > 200) {
      throw new Error("Cloud record kind and ID are outside their allowed lengths.");
    }
    if (!CLOUD_ENTITY_KINDS.includes(kind)) throw new Error("Unsupported Centre cloud record kind.");
    if (kind === "practice.attempt") throw new Error("Practice attempts are created by the authenticated cloud grader.");
    if (!deleted && !data) throw new Error("A live cloud record must include validated data.");
    const timestamp = dateNow(this.now);
    const parsedData = deleted ? null : parseCloudEntity(kind, data);
    if (parsedData && typeof parsedData.id === "string" && parsedData.id !== id) {
      throw new Error("Cloud record ID does not match its canonical data.");
    }

    await this.transact((state) => {
      const workspaceId = state.activeWorkspaceId;
      if (!workspaceId) throw new Error("Pair Centre before saving mobile study data.");
      updateWorkspace(state, workspaceId, (workspace) => {
        const key = storageKey(kind, id);
        const existing = workspace.entities[key];
        const shadow = workspace.shadow[key];
        const entity: MobileEntity = {
          kind,
          id,
          schemaVersion: 1,
          version: existing?.version ?? shadow?.version ?? 0,
          cursor: existing?.cursor ?? shadow?.cursor ?? "0",
          ...(existing?.createdCursor ?? shadow?.createdCursor
            ? { createdCursor: existing?.createdCursor ?? shadow?.createdCursor }
            : {}),
          updatedAt: timestamp,
          deleted,
          data: parsedData,
        };
        setEntity(workspace, entity);
        if (!Object.hasOwn(workspace.conflicts, entityKey(kind, id))) {
          enqueueEntity(workspace, entity);
        }
      });
    });
  }

  async saveLocal(key: string, value: unknown): Promise<void> {
    await this.ensureOpen();
    if (!key || key.length > 200) throw new Error("Local mobile value keys must contain 1 to 200 characters.");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Local mobile values must be JSON serializable.");
    const safeValue: unknown = JSON.parse(serialized);
    if (new TextEncoder().encode(serialized).byteLength > CLOUD_LIMITS.recordBytes) {
      throw new Error("Local mobile values are larger than the cloud record limit.");
    }
    await this.transact((state) => {
      const workspaceId = state.activeWorkspaceId;
      if (!workspaceId) throw new Error("Pair Centre before saving workspace-scoped mobile values.");
      updateWorkspace(state, workspaceId, (workspace) => {
        const localKey = slot("v:", key);
        if (!Object.hasOwn(workspace.localValues, localKey) && Object.keys(workspace.localValues).length >= CLOUD_LIMITS.records) {
          throw new Error("This workspace has reached the local mobile value limit.");
        }
        workspace.localValues[localKey] = safeValue;
      });
    });
  }

  async getLocal(key: string): Promise<unknown> {
    await this.ensureOpen();
    await this.refreshFromPersistence(false);
    const workspace = activeWorkspace(this.persisted);
    if (!workspace) throw new Error("Pair Centre before reading workspace-scoped mobile values.");
    return clone(workspace.localValues[slot("v:", key)]);
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    await this.ensureOpen();
    const context = await this.captureContext();
    return this.authenticatedRequest(path, init, context, false);
  }

  sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    const operation = this.syncOnce().finally(() => {
      this.syncing = false;
      this.syncPromise = null;
      this.publish();
    });
    this.syncing = true;
    this.syncPromise = operation;
    this.publish();
    return operation;
  }

  private async syncOnce(): Promise<void> {
    await this.ensureOpen();
    let context: RequestContext;
    try {
      context = await this.captureContext();
    } catch (error) {
      if (error instanceof MobileRequestError && error.status === 401) return;
      throw error;
    }

    try {
      await this.pull(context);
      await this.push(context);
      await this.transact((state) => {
        if (!contextMatches(state, context)) return;
        updateWorkspace(state, context.workspaceId, (workspace) => {
          workspace.lastSyncedAt = dateNow(this.now);
          workspace.error = null;
          workspace.errorKind = null;
        });
      });
    } catch (error) {
      if (error instanceof SessionChangedError) return;
      if (error instanceof MobileRequestError && error.status === 401) return;
      const message = errorText(error);
      await this.transact((state) => {
        if (!contextMatches(state, context)) return;
        updateWorkspace(state, context.workspaceId, (workspace) => {
          workspace.error = message;
          workspace.errorKind = isOfflineError(error) ? "offline" : "error";
        });
      });
    }
  }

  async resolveConflict(key: string, choice: "local" | "cloud"): Promise<void> {
    await this.ensureOpen();
    const timestamp = dateNow(this.now);
    await this.transact((state) => {
      const workspaceId = state.activeWorkspaceId;
      const workspace = activeWorkspace(state);
      if (!workspaceId || !workspace) throw new Error("Pair Centre before resolving mobile conflicts.");
      const remote = workspace.conflicts[key];
      if (!Object.hasOwn(workspace.conflicts, key)) throw new Error("Mobile sync conflict was not found.");
      const separator = key.indexOf(":");
      if (separator < 1) throw new Error("Mobile sync conflict key is invalid.");
      const kind = key.slice(0, separator);
      const id = key.slice(separator + 1);
      const localStorageKey = storageKey(kind, id);
      const local = workspace.entities[localStorageKey];
      if (!local) throw new Error("The latest local record for this conflict is unavailable.");

      if (choice === "cloud") {
        clearRecordOutbox(workspace, kind, id);
        delete workspace.entities[localStorageKey];
        delete workspace.conflicts[key];
        if (remote) {
          const imported = recoverImportedRecord(parsedRecord(remote), this.now());
          setEntity(workspace, imported);
          workspace.shadow[storageKey(remote.kind, remote.id)] = remote;
          if (!sameProjection(imported, remote)) enqueueEntity(workspace, imported, remote.version);
        }
        return;
      }

      if (kind === "practice.attempt") {
        throw new Error("Practice attempts are immutable cloud-created records. Keep the cloud result for this conflict.");
      }
      let selected = local;
      let expectedVersion = remote?.version ?? workspace.shadow[localStorageKey]?.version ?? 0;
      if (remote && (remote.kind !== kind || remote.id !== id)) {
        if (kind !== "studyGoal" && kind !== "practice.learningNeed") {
          throw new MobileRequestError(409, "identity_conflict", "These records have different identities and cannot be merged by the mobile client.");
        }
        if (local.deleted || !local.data || remote.deleted || !remote.data) {
          throw new MobileRequestError(409, "identity_conflict", "Deleted records with different identities need a cloud choice.");
        }
        const incoming = parseCloudEntity(kind, remote.data);
        const desired = parseCloudEntity(kind, local.data);
        const merged = {
          ...desired,
          id: remote.id,
          createdAt: incoming.createdAt,
          updatedAt: timestamp,
          revision: Math.max(recordRevision(desired) ?? 0, recordRevision(incoming) ?? 0) + 1,
        };
        selected = {
          ...local,
          id: remote.id,
          version: remote.version,
          cursor: remote.cursor,
          ...(remote.createdCursor ? { createdCursor: remote.createdCursor } : {}),
          updatedAt: timestamp,
          data: parseCloudEntity(kind, merged),
        };
        delete workspace.entities[localStorageKey];
        clearRecordOutbox(workspace, kind, id);
        workspace.shadow[storageKey(remote.kind, remote.id)] = remote;
        expectedVersion = remote.version;
      } else {
        selected = bumpDomainRevision(kind, local, remote, timestamp);
        selected = {
          ...selected,
          version: remote?.version ?? expectedVersion,
          cursor: remote?.cursor ?? selected.cursor,
          ...(remote?.createdCursor ?? selected.createdCursor
            ? { createdCursor: remote?.createdCursor ?? selected.createdCursor }
            : {}),
        };
        if (remote) workspace.shadow[localStorageKey] = remote;
        clearRecordOutbox(workspace, kind, id);
      }

      setEntity(workspace, selected);
      delete workspace.conflicts[key];
      enqueueEntity(workspace, selected, expectedVersion);
    });
  }

  private async pull(context: RequestContext): Promise<void> {
    for (let pageNumber = 0; pageNumber < MAX_PULL_PAGES; pageNumber++) {
      const state = await this.readState();
      if (!contextMatches(state, context)) throw new SessionChangedError();
      const workspace = state.workspaces[workspaceKey(context.workspaceId)];
      if (!workspace) throw new SessionChangedError();
      const cursor = workspace.cursor;
      const value = await this.authenticatedRequest(
        `/v1/changes?cursor=${encodeURIComponent(cursor)}&limit=${PAGE_SIZE}`,
        {},
        context,
        true,
      );
      const page = cloudChangesSchema.parse(value);
      const pageCursor = BigInt(page.cursor);
      const priorCursor = BigInt(cursor);
      if (pageCursor > MAX_CURSOR || pageCursor < priorCursor || (page.hasMore && pageCursor <= priorCursor)) {
        throw new Error("Centre returned an invalid change cursor.");
      }
      if (page.records.length > PAGE_SIZE) throw new Error("Centre returned too many records in a change page.");
      if (page.hasMore && page.records.length === 0) throw new Error("Centre returned an empty page with more changes.");
      const timestamp = this.now();
      await this.transact((next) => {
        if (!contextMatches(next, context)) throw new SessionChangedError();
        updateWorkspace(next, context.workspaceId, (current) => {
          if (current.cursor !== cursor) throw new SessionChangedError();
          applyRemotePage(current, page.records, page.cursor, timestamp);
        });
      });
      if (!page.hasMore) return;
    }
    throw new Error("Centre returned more change pages than the mobile client limit.");
  }

  private async push(context: RequestContext): Promise<void> {
    for (let sent = 0; sent < MAX_MUTATIONS_PER_SYNC; sent++) {
      const candidate = await this.nextMutation(context);
      if (!candidate) return;
      const { mutation, key } = candidate;
      if (!(await this.setDelivery(context, mutation.mutationId, "uncertain"))) continue;
      try {
        const value = await this.authenticatedRequest(
          "/v1/records",
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mutation) },
          context,
          true,
        );
        const remote = parsedRecord(parseRemoteReply(value).record);
        if (remote.kind !== mutation.kind || remote.id !== mutation.id) {
          throw new Error("Centre acknowledged a different cloud record.");
        }
        await this.applyAcknowledgment(context, mutation, remote);
      } catch (error) {
        if (error instanceof MobileRequestError && error.status === 409) {
          await this.recordConflict(context, key, mutation.mutationId, error.current);
          continue;
        }
        throw error;
      }
    }
  }

  private async nextMutation(context: RequestContext): Promise<{ mutation: CloudMutation; key: string } | null> {
    const state = await this.readState();
    if (!contextMatches(state, context)) throw new SessionChangedError();
    const workspace = state.workspaces[workspaceKey(context.workspaceId)];
    if (!workspace) throw new SessionChangedError();
    const priorKeys = new Set<string>();
    for (const entry of workspace.outbox) {
      const { kind, id } = entry.mutation;
      const key = entityKey(kind, id);
      if (priorKeys.has(key)) continue;
      priorKeys.add(key);
      const conflicted = Object.hasOwn(workspace.conflicts, key);
      if (conflicted && entry.delivery !== "uncertain") continue;
      if (entry.delivery === "blocked") continue;
      return { mutation: entry.mutation, key };
    }
    return null;
  }

  private async setDelivery(context: RequestContext, mutationId: string, delivery: "uncertain"): Promise<boolean> {
    return this.transact((state) => {
      if (!contextMatches(state, context)) throw new SessionChangedError();
      let marked = false;
      updateWorkspace(state, context.workspaceId, (workspace) => {
        const entry = workspace.outbox.find((value) => value.mutation.mutationId === mutationId);
        if (entry && entry.delivery !== "blocked") {
          entry.delivery = delivery;
          marked = true;
        }
      });
      return marked;
    });
  }

  private async applyAcknowledgment(context: RequestContext, mutation: CloudMutation, remote: CloudRecord): Promise<void> {
    await this.transact((state) => {
      if (!contextMatches(state, context)) throw new SessionChangedError();
      updateWorkspace(state, context.workspaceId, (workspace) => {
        const key = storageKey(mutation.kind, mutation.id);
        const pending = workspace.outbox.some((entry) => entry.mutation.mutationId === mutation.mutationId);
        const prior = workspace.shadow[key];
        if (!pending) {
          if (!prior || prior.version < remote.version) workspace.shadow[key] = remote;
          return;
        }
        const local = workspace.entities[key];
        const unchanged = sameProjection(local, mutation);
        if (local) {
          const transported = withTransport(local, remote);
          const acknowledged: MobileEntity = unchanged
            ? { ...transported, updatedAt: remote.updatedAt, deleted: remote.deleted, data: remote.data }
            : transported;
          setEntity(workspace, acknowledged);
        }
        if (!prior || prior.version <= remote.version) workspace.shadow[key] = remote;
        workspace.outbox = workspace.outbox.filter((entry) => entry.mutation.mutationId !== mutation.mutationId);
      });
    });
  }

  private async recordConflict(context: RequestContext, key: string, mutationId: string, remote: CloudRecord | null): Promise<void> {
    await this.transact((state) => {
      if (!contextMatches(state, context)) throw new SessionChangedError();
      updateWorkspace(state, context.workspaceId, (workspace) => {
        if (!workspace.outbox.some((entry) => entry.mutation.mutationId === mutationId)) return;
        const separator = key.indexOf(":");
        const kind = key.slice(0, separator);
        const id = key.slice(separator + 1);
        const previousConflict = workspace.conflicts[key];
        if (remote) {
          const parsedRemote = parsedRecord(remote);
          if (!previousConflict || previousConflict.version <= parsedRemote.version) {
            workspace.conflicts[key] = parsedRemote;
          }
        } else if (!Object.hasOwn(workspace.conflicts, key)) {
          workspace.conflicts[key] = null;
        }
        if (remote) {
          const remoteKey = storageKey(remote.kind, remote.id);
          const prior = workspace.shadow[remoteKey];
          if (!prior || prior.version <= remote.version) workspace.shadow[remoteKey] = parsedRecord(remote);
        }
        let blocked = false;
        workspace.outbox = workspace.outbox.map((entry) => {
          if (entry.mutation.kind !== kind || entry.mutation.id !== id) return entry;
          if (!blocked) {
            blocked = true;
            return { ...entry, delivery: "blocked" };
          }
          return { ...entry, delivery: "blocked" };
        });
      });
    });
  }

  private async captureContext(): Promise<RequestContext> {
    const state = await this.readState();
    const context = requestContext(state, this.generation);
    if (Date.parse(context.session.expiresAt) <= this.now()) {
      await this.invalidateSession(context, "The Centre session expired. Pair again to sync this cached library.");
      throw new MobileRequestError(401, "expired_session", "The Centre session expired. Pair again to sync this cached library.");
    }
    return context;
  }

  private async authenticatedRequest(
    path: string,
    init: RequestInit,
    context: RequestContext,
    internal: boolean,
  ): Promise<unknown> {
    const url = requestUrl(this.origin, path);
    const method = (init.method ?? "GET").toUpperCase();
    if (!internal && !isPublicPathAllowed(url, method)) {
      throw new MobileRequestError(400, "managed_route", "Record and change routes are managed by the durable mobile sync store.");
    }
    const headers = new Headers(init.headers);
    if (headers.has("Authorization")) {
      throw new MobileRequestError(400, "managed_authorization", "Centre adds its bearer token in the Authorization header.");
    }
    assertJsonRequestBody(init.body);
    headers.set("Authorization", `Bearer ${context.session.token}`);
    if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const signal = combineSignals(init.signal);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        method,
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        mode: "same-origin",
        signal,
      });
    } catch (error) {
      await this.assertContext(context);
      throw error;
    }
    await this.assertContext(context);
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
      throw new MobileRequestError(502, "redirect_blocked", "Centre returned a response from another origin.");
    }
    const value = await readJsonResponse(response);
    await this.assertContext(context);
    if (!response.ok) {
      const failure = mobileHttpError(response.status, value);
      if (failure.status === 401) await this.invalidateSession(context, failure.message);
      throw failure;
    }
    return value;
  }

  private async assertContext(context: RequestContext): Promise<void> {
    if (context.generation !== this.generation) throw new SessionChangedError();
    const state = await this.readState();
    if (!contextMatches(state, context)) throw new SessionChangedError();
  }

  private async invalidateSession(context: RequestContext, message: string): Promise<void> {
    if (context.generation !== this.generation) return;
    await this.transact((state) => {
      if (!contextMatches(state, context)) return;
      updateWorkspace(state, context.workspaceId, (workspace) => {
        workspace.session = null;
        workspace.error = message;
        workspace.errorKind = null;
      });
    });
  }

  private async readState(): Promise<PersistedMobileState> {
    const state = parsePersistedState(await this.persistence.read());
    assertPersistedOrigin(state, this.origin);
    return state;
  }

  private async transact<T>(
    update: (state: PersistedMobileState) => T,
  ): Promise<T> {
    const result = await this.persistence.transact((currentValue) => {
      const current = parsePersistedState(currentValue);
      assertPersistedOrigin(current, this.origin);
      const state = clone(current);
      const value = update(state);
      state.origin = this.origin;
      state.revision = current.revision + 1;
      return { state: parsePersistedState(state), result: value };
    });
    await this.refreshFromPersistence(false);
    this.publish();
    this.channel?.postMessage({ revision: this.persisted.revision });
    return result;
  }

  private async refreshFromPersistence(notify: boolean): Promise<void> {
    const state = await this.readState();
    const changed = state.revision !== this.persisted.revision || state.origin !== this.persisted.origin;
    const previousWorkspace = this.persisted.activeWorkspaceId;
    const previousSession = activeWorkspace(this.persisted)?.session?.token ?? null;
    const nextSession = activeWorkspace(state)?.session?.token ?? null;
    if (
      this.opened &&
      (previousWorkspace !== state.activeWorkspaceId || previousSession !== nextSession)
    ) {
      this.generation++;
    }
    this.persisted = state;
    this.rebuildSnapshot();
    if (notify && changed) this.emit();
  }

  private publish(): void {
    this.rebuildSnapshot();
    this.emit();
  }

  private rebuildSnapshot(): void {
    const workspace = activeWorkspace(this.persisted);
    const storedSession = workspace?.session ?? null;
    const session = storedSession && Date.parse(storedSession.expiresAt) > this.now()
      ? storedSession
      : null;
    const phase: MobilePhase = this.syncing
      ? "syncing"
      : !this.persisted.activeWorkspaceId
        ? "unpaired"
        : !session
          ? "auth-required"
          : workspace?.errorKind === "offline"
            ? "offline"
            : workspace?.error
              ? "error"
              : "ready";
    this.snapshot = {
      session,
      entities: clone(sortedEntities(workspace)),
      pending: workspace?.outbox.length ?? 0,
      conflicts: clone(buildConflicts(workspace)),
      phase,
      error: workspace?.error ?? null,
      lastSyncedAt: workspace?.lastSyncedAt ?? null,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async ensureOpen(): Promise<void> {
    if (!this.opened) await this.open();
  }
}
