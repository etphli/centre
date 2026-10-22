# Hosted Organato connector

`handleOrganatoRequest(request, context): Promise<Response | null>` handles `/v1/organato/*` after the host authenticates the workspace and device. It returns `null` outside that namespace. This module uses Worker Web Crypto and fetch. It does not use desktop credentials or Keychain.

Apply `migrations/0001_organato.sql` to the host's D1 database before mounting the handler. The migration owns only `centre_organato_*` tables. No deployment configuration or core migration is included.

## Host contract

The exported `OrganatoContext`, `Database`, `Statement`, and `Mutation` interfaces are structural. `CloudRecord` derives from the exported Zod `cloudRecordSchema`. No absent core modules are imported.

```ts
{
  env: {
    DB, // D1-compatible prepare, bind, first, all and run
    ORGANATO_ENCRYPTION_KEYS_JSON,
    ORGANATO_KEY_VERSION,
    ORGANATO_ALLOWED_ORIGINS,
  },
  auth: { workspaceId, deviceId },
  entities: {
    get(kind, id), // MaybePromise<CloudRecord | null>
    put(mutation), // MaybePromise<CloudRecord>
    commit(mutations), // MaybePromise<CloudRecord[]>, reserved for host compatibility
  },
}
```

A record contains `{kind,id,schemaVersion:1,version,cursor,updatedAt,deleted,data}`. `cursor` is a decimal string and never passes through a JavaScript number. `cloudRecordSchema` validates stored receipt records and host write results. `MaybePromise<T>` accepts either a synchronous value or a promise for `entities.get`, `entities.put`, and `entities.commit`. A mutation contains `{mutationId,kind,id,schemaVersion:1,expectedVersion,deleted,data}`. The connector writes only `calendarEvent`. The host must enforce compare-and-swap and durable idempotency by mutation ID. Replaying the same successful mutation after a connector persistence failure must return the original record. Record `version` and calendar `data.revision` are separate counters.

## Secrets and URL policy

- `ORGANATO_ENCRYPTION_KEYS_JSON` is a Worker secret containing a JSON object mapping key versions to standard base64 encoded 32-byte AES keys.
- `ORGANATO_KEY_VERSION` selects the version for new credentials. Retain old map entries while ciphertext still uses them. Re-saving a connection encrypts with the current version.
- `ORGANATO_ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS origins. There is no default allowlist. Only `/api/v1`, optionally with a trailing slash, is accepted as the API base path. Credentials, query strings and fragments are rejected.

The connector encrypts each API key with AES-256-GCM, a fresh 12-byte IV, and authenticated workspace, connection, URL and key-version metadata. Only ciphertext is stored. API keys and upstream error bodies are never returned or logged. All upstream fetches reject redirects. Connecting checks the credential with GET `/subjects` before replacing the saved connection.

A connection identity binds hosted session links and unresolved operations to the original API key and base URL. Reconnecting the same original key restores that identity, including after removal. A different key cannot reconcile old operations because it may belong to another Organato workspace. Resolve outstanding operations before rotating or revoking the original key.

`centre_organato_links.connection_id` records the credential that confirmed each hosted link. A mutation against a link from another credential returns HTTP 409 with `connection_changed` before any upstream write. Snapshot reads and deduplication use only links for the current credential. An old remote ID cannot suppress, project, or update an unrelated item from the new credential.

Desktop-origin canonical records can contain an `organatoId` without any verified hosted link. Normal mutations return HTTP 409 with `link_reconciliation_required` until the client explicitly calls POST `/sessions/:id/link` with `{expectedVersion,expectedRevision}`. The same route permits intentional key rotation by verifying an old hosted link under the current credential.

Link verification checks the active Centre session and both input counters before GET `/items/:organatoId`. The request cannot supply another remote ID. The remote item must be an active, calendar-enabled todo with matching title, subject, notes, planned duration, local date, local clock, exact start instant, and completion state. Its version must be at least the canonical `organatoVersion`. A mismatch returns HTTP 409 with `link_reconciliation_mismatch` and leaves the link unchanged. Open canonical sessions require `not_started` with no completion timestamp. Completed sessions require `completed` and the same completion instant.

On exact proof, the route binds or rebinds the hosted link to the current credential and returns `{event,record}`. If the remote version is newer, it first saves the refreshed `organatoVersion` with cloud CAS, a fresh mutation UUID, and calendar revision incremented by one. Equal remote versions leave both counters unchanged. The route performs no upstream mutation and creates no actual study log. Unresolved operations block verification. The link insertion and mutation-ledger insertion exclude concurrent rebinding and upstream writes through atomic SQL conditions.

The draft migration now requires `connection_id` on hosted links and scopes remote-ID uniqueness by workspace and connection. An installation using an earlier draft schema needs an explicit upgrade before running this version. Existing links must not be assigned the current credential without verified provenance.

## Routes

All request bodies use `application/json`. Unknown fields are rejected.

| Method | Path under `/v1/organato` | Body or result |
| --- | --- | --- |
| GET | `/connection` | `{state,baseUrl,keyVersion,updatedAt,message}` |
| POST | `/connection` | `{apiKey,baseUrl}`; returns connection metadata |
| POST | `/connection/remove` | `{}`; clears the encrypted credential |
| GET | `/snapshot` | `{subjects,assignments,events,fetchedAt,connection}` |
| POST | `/sessions` | `{operationId:UUID,id:UUID,data:CalendarEvent}` |
| POST | `/sessions/:id/link` | `{expectedVersion,expectedRevision}`; returns `{event,record}` after read-only upstream verification |
| PATCH | `/sessions/:id` | `{operationId,expectedVersion,expectedRevision,patch}` |
| POST | `/sessions/:id/complete` | `{operationId,expectedVersion,expectedRevision,completed:boolean}` |
| POST | `/sessions/:id/archive` | `{operationId,expectedVersion,expectedRevision}` |
| GET | `/operations/:operationId` | Stored receipt, always HTTP 200 when found |
| POST | `/operations/:operationId/reconcile` | `{resolution:'applied'|'not_applied',organatoId?:string}` |

Connection states are `unconfigured`, `connected`, `reauth`, `permission` and `error`. Unconfigured upstream routes return 503. Upstream 401 and 403 update connection state to `reauth` and `permission`. Operation failures use the receipt status codes below. Other failures use `{error:{code,message},connection?}`.

Patch fields are `title`, `date`, `time`, `plannedDurationMinutes`, `subjectId` and `notes`. Sessions require a valid time and a duration of 5 to 720 minutes. Times accept `HH:mm[:ss[.fraction]]` with up to nine fractional digits. New sessions and changed local date/time values compute `startAt` using the canonical IANA timezone and reject daylight-saving gaps or ambiguous times. Notes, duration, title and completion changes preserve the existing precise `startAt`, including an already chosen instant in a repeated daylight-saving hour. A minute-only time patch that matches the existing minute preserves its seconds and fraction. Remote clock projections use `calendarTimeKey`, retaining nonzero seconds and fractions and using `HH:mm` when both are zero. Creates require revision 1, matching Centre UUIDs and no remote link, deletion or completion.

Imported projections retain original remote IDs, `origin: 'organato'` and `kind: 'deadline'`. Linked sessions retain the Centre UUID and remote version. Snapshot reads the current credential's successful-link ledger to find canonical records and deduplicates matching imported events. A newer remote version refreshes the canonical record with cloud CAS and increments its calendar revision. Sessions with unresolved operations are held at their canonical state until reconciliation. Subjects and assignments preserve original IDs. The connector does not archive or overwrite unrelated assignments. Completion updates working status and does not record actual study hours.

## Operations and recovery

Each upstream mutation first inserts a durable workspace-scoped operation with its payload hash, complete plan and pending receipt. A partial unique index permits at most one unresolved operation per session. Reusing an operation ID with the same payload returns its receipt. A different payload returns 409. Saved receipts can be replayed even after the connection is removed. Creates use upstream POST `/items`, edits and completion use PATCH `/items/:id`, and archive uses POST `/items/:id/archive` with `{version}`. There is no upstream DELETE or automatic write retry.

Receipts contain `{operationId,expectedVersion,expectedRevision,status,event,record,error,reconciliationRequired}`. `expectedVersion` is the input cloud record version used for transport CAS. `expectedRevision` is the input calendar domain revision. Create receipts use `expectedVersion: 0` and `expectedRevision: null`. Both counters remain unchanged in the durable plan and all later receipts. The result event's `revision` and the result record's `version` describe the resulting states, not these input preconditions. Succeeded operations return 200, pending or unknown operations 202, conflicts 409 and failed operations 502. Validation and local precondition failures can return ordinary error responses before an operation is inserted.

The connector stores a successful remote response before attempting canonical persistence. Any ambiguous write, malformed success response, or subsequent persistence failure leaves the operation unresolved. It never repeats the external mutation. Even if saving the unknown receipt fails, the existing pending ledger still prevents replay. A crashed pending operation can be explicitly reconciled after one minute. Concurrent reconciliation requests claim the operation before reading or applying a resolution.

`applied` performs only a GET of the linked item and a canonical write. A lost create response requires an explicitly supplied Organato ID. The item must match the planned create fields and be a calendar-enabled todo. Edits, completion and archives validate their expected remote state and identity. A confirmed archive supplies the canonical tombstone. A canonical CAS conflict keeps the operation unknown for investigation. Its receipt retains the intended event with the confirmed remote ID and version, both input precondition counters, and the current cloud record when readable. The connector never overwrites a newer cloud record or repeats the upstream mutation.

`not_applied` records a terminal failure requiring a new operation ID for another attempt. It is refused when a successful remote response is already saved. It is an explicit operator assertion, not an inference from an absent list result. Keep the original API key available until uncertain operations are resolved.

## Bounds and verification

Incoming JSON is limited to 64 KiB and 15 seconds. Each upstream request has a 15-second timeout and a 2 MiB JSON limit. Snapshots permit 25 pages of 200 items, reject repeated cursors, and check a 45-second pagination budget. Linked canonical IDs are capped at 5,000. Remote items plus linked projections have an 8 MiB aggregate JSON budget. Large workspaces receive an explicit error rather than a silently truncated snapshot. Imported all-day dates retain their date without conversion to UTC midnight. Imported timed projections use `Australia/Sydney`; linked Centre sessions use their canonical timezone.

The explicit module type check is `tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM cloud-organato/index.ts`. The independent worker suite runs with `tsx --test cloud-organato/index.test.ts`.

Verification uses the actual SQLite migration and handler with simulated upstream fetches: credential encryption, URL allowlisting, create replay, changed-payload rejection, completion, confirmed archive, lost-response reconciliation, snapshot deduplication, canonical persistence recovery and workspace isolation. The separate worker test owner maintains `index.test.ts`, including explicit link adoption, mismatch rejection, key rotation, and precise timestamp checks. A focused additional check verifies notes, duration, unchanged-minute patches and completion on an existing fractional instant in a repeated daylight-saving hour. No production API calls or deployments are part of this module.
