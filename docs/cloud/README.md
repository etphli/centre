# Centre cloud foundation

Centre owns a separate Cloudflare Worker and D1 database. `cloud/wrangler.jsonc` binds the deployed Centre database `16c45b97-0c59-4293-9c79-e1f1aa0ef081`. The private service is `https://centre-cloud.etphli.workers.dev` on Workers Free. It must never bind Organato's database. Organato remains the authority for imported subjects, assignments and calendar items through its authenticated API.

Local study works without cloud configuration. Connections offers a separate Google sign-in and an explicit **Import and enable sync** action. Import first persists a private local backup, verifies the account/device binding, and records pending mutations. Sign-in alone uploads no study records. Disconnect keeps local and cloud data.

## Wire protocol

`shared/cloud.ts` defines the v1 wire schemas. `shared/cloud-entities.ts` is the writable kind allowlist. Domain schemas validate record data; arbitrary blobs, credentials and execution metadata are rejected.

- `POST /v1/auth/google {idToken,deviceName}` verifies Google's RS256 JWT against fixed Google JWKS, configured audiences, issuer, expiry, verified email and a server subject allowlist. Missing configuration denies access. The server derives one private workspace from the Google subject.
- Authenticated `POST /v1/pairings {}` creates a one-use, five-minute invitation. Native `POST /v1/auth/pair {code,deviceName}` redeems it. `centre://pair?baseUrl=...&code=...` carries only the invitation, never a desktop bearer or CLI credential.
- Both login methods return `{token,workspaceId,deviceId,expiresAt}`. An opaque session expires after 30 days; only its hash is stored. All other routes require bearer authorization. `GET /v1/devices` and `POST /v1/devices/revoke {deviceId}` support revocation.
- `GET /v1/bootstrap` returns schema version, authenticated identity, supported kinds and limits.
- `GET /v1/changes?cursor=0&limit=100` returns `{records,cursor,hasMore}`. Cursors are decimal strings, compared numerically, without floating-point conversion. Changes contain the latest version of each changed record, including tombstones.
- `POST /v1/records` accepts `{mutationId,kind,id,schemaVersion:1,expectedVersion,deleted,data}`. `expectedVersion=0` creates. Exact retry returns the original receipt even after later edits. Reusing a mutation ID with different input returns 409. Conflicts return `{error:{code,message},current}` and retain the local edit for explicit resolution.

A CloudRecord is `{kind,id,schemaVersion:1,version,cursor,createdCursor?,updatedAt,deleted,data}`. `version` is transport compare-and-swap state. `data.revision` is the separate canonical domain revision. `createdCursor` orders equal-time messages by original creation, including after an update or fresh bootstrap. Clients must preserve unknown kinds and must never infer their deletion.

## Domain rules

Resources include canonical question concepts and practice focus. Chat and message uploads use the exact `shared/chat-sync.ts` projections. Codex thread/turn IDs, activity, response errors, local file/process metadata, connector settings and Keychain data never enter them. Derived search indexes, snippets and extracted sidecars remain local.

Chat archive is **not a physical tombstone**: it is a live transport record with `data.deletedAt` set. Retain all chat ancestry and message associations, including archived parents. Reads and AI reject an archived target. Active descendants can still read inherited attachments through the canonical attachment authorization helper. Physical parent tombstones are rejected while a retained child references that parent. Nothing cascades to ancestors, descendants, messages, resources or files.

Study sessions/goals use the merged Log schemas and projections. Imported running sessions always pause at their checkpoint, incrementing the domain revision as a pending local recovery. Local Log mutations and imports share the same Store transaction queue. Independent UUIDs for the same week and zone produce a conflict, not duplicate goals. Learning needs similarly enforce a workspace/subject/topic/concept identity. Practice attempts are immutable and unique by sourceDraftId per workspace. The trusted learning-history list includes all retained tombstones in its 500-record bound; hosted grading still evolves existing concepts at that limit and skips new concepts.

`interactiveProgress` uses the canonical strict checklist validator and deterministic UUID v8 helper. The Worker invokes its canonical merge helper: stale revisions and equal domain revisions with different state return a conflict. An explicit keep-local resolution advances the domain revision beyond both copies, separately from transport CAS. Acknowledgments normalize server-canonical fields only while the exact submitted local edit remains current. Uploads use complete persisted collections, including archived progress, rather than the visible `/api/state` projection.

## Attachments

D1 holds immutable metadata and bounded content chunks. This avoids an additional paid storage service. Each file is at most 20 MiB, each chunk 256 KiB and workspace reservations at most 100 MiB.

1. `PUT /v1/attachments/:id {name,mimeType,size,sha256,sourceChatId,chatId}` reserves an immutable original owner and active target.
2. `PUT /v1/attachments/:id/chunks/:index {data:base64}` writes idempotent chunks.
3. `POST /v1/attachments/:id/complete {mutationId}` checks size and SHA-256 before publishing metadata to changes.
4. Metadata and chunk GET requests require `?chatId=activeTarget`. The server checks workspace, original ownership, retained message prefix and ancestry, using all persisted chats.
5. A generic attachment tombstone removes content and releases quota, retaining identity and receipts. An abandoned staged upload is cancelled durably before the client clears pending work. Tombstoned cached files remain unreadable.

## Trusted extension interface

`cloud/index.ts` mounts `handleCloudExtension` after central authentication and request limits. It composes `cloud-ai/` and `cloud-organato/`; neither module supplies account authority.

The repository provides `get`, `put`, `commit`, `getPracticeAttempt`, `listLearningNeeds`, `listMessages`, `putMessage` and `resolveReview`. `commit(mutations[])` is one D1 transaction with all CAS checks. No arbitrary SQL is exposed over HTTP. `putMessage(mutation,chatId)` guards active chat state within the same write transaction, closing archive-versus-assistant-write races. History returns the latest at most 20 live messages in chronological order.

Hosted grading checks sourceDraftId before inference and after a uniqueness race, then commits the immutable attempt, matching draft tombstone and learning transitions atomically. Review's ordinary unresolved-to-resolved record write derives the linked need from the prior trusted memory link, with stable resolvedAt, in the same transaction. Exact retries return the original records. Trusted grade cleanup uses raw `commit` so it does not derive extra Review evidence.

The Organato module owns encrypted per-workspace connector state and its operation ledger. Unknown upstream outcomes block automatic replay. AI needs an approved optional Workers AI binding. Without that binding, written inference reports unavailable. No provider credentials go to clients.

## Desktop persistence and integration

`cloud-sync.json` holds versioned cursor, shadow, immutable outbox mutations, conflicts and interrupted file work. The session stays in macOS Keychain. Files use private permissions and atomic rename. A failed import does not acknowledge its cursor or publish state. `Store.onCommitted` observes both `save` and `atomic`; a successful local mutation captures pending work. Startup also reconstructs pending changes from the durable snapshot.

Store transactions stage before writing and publish after rename. They re-prepare if legacy callers changed live state during an awaited write. Chat/resource imports preserve live object identity so an asynchronous response does not write to a detached object. Conflict decisions run inside the same queue. Imported running timers remain pending recovery edits.

Search PR #11 must rebuild its local index from committed source records after sync applies them. Its derived data must never be copied into D1. Chat PR #14, checklist PR #15, practice PR #16 and iOS PR #13 are merged. The combined source passed 396 local tests before deployment. Deployment verification is recorded in `docs/evidence/cloud/deployment.json`; native distribution remains separately blocked.

## Verification

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run cloud:build` and `npm run cloud:migrate:local -- --persist-to .runtime/cloud-check`.

The tests run actual Fetch handlers, signed local JWT fixtures and isolated SQLite. Mounted AI and Organato tests simulate inference/upstream responses. They do not prove a production integration. `docs/evidence/cloud/` records real rendered local UI states and the native connector regression result. See [rollout.md](rollout.md) for approvals and prerequisites.
