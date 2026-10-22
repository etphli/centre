# Checklist progress contract

`shared/checklist-progress.ts` owns the strict v1 schema. `interactiveResourceProgressSchema` and `validateInteractiveResourceProgress(value)` return `InteractiveResourceProgress`:

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `id` | Deterministic UUID v8 for the resource and document revision |
| `revision` | Positive domain revision, starting at `1` |
| `resourceId` | Centre resource ID, at most 200 characters |
| `documentRevision` | Lowercase SHA-256 of the exact stored `resource.content` |
| `checkedItemIds` | Sorted, unique stable IDs, at most 100 |
| `createdAt`, `updatedAt` | UTC ISO instants |
| `deletedAt` | UTC ISO instant or `null`, reserved for sync tombstones |

`Snapshot.interactiveResourceProgress` defaults to `[]` when Centre opens an older snapshot. The atomic local `state.json` contains the collection. A successful save commits the new collection before exposing it to other readers. Repeated writes of the same checked state do not increment `revision`.

`interactiveResourceProgressId(resourceId, documentRevision)` hashes the UTF-8 bytes of `centre:interactiveProgress:v1`, NUL, the resource ID, NUL, and the document revision with SHA-256. It takes the first 16 bytes, sets the UUID version bits to 8 and the RFC variant bits to `10`, then formats the UUID in lowercase. Independent clients therefore create the same entity ID for the same document.

## Supported item identity

The service parses static HTML with `parse5`. The first 100 HTML `input` elements whose parsed `type` is `checkbox` are eligible. Comments, script text, other text nodes, and template contents do not create items.

An input can supply a unique `data-centre-checklist-id` matching `[a-z][a-z0-9_-]{0,63}`. The `legacy-N` namespace is reserved. A missing, invalid, reserved, or duplicated explicit ID becomes `legacy-N`, where `N` is the input's one-based position among eligible static checkboxes in document order. Labels and arbitrary script or DOM text never become keys. Script-created items cannot introduce new durable IDs.

Every item ID belongs to one resource ID and document revision. Changed generated content gets a new revision and a different progress record, even if its checkbox labels or explicit IDs match an older document. Archive retains the record on disk while blocking preview and update access. Restore exposes the same progress again.

The source `checked` attributes supply initial defaults until the first changed state is saved. An existing empty `checkedItemIds` set explicitly restores every supported item as unchecked.

## Isolated document and bridge

The React parent renders a sandboxed artifact iframe with `allow-scripts` and no same-origin permission. Its trusted document contains another iframe with the same sandbox and generated HTML in `srcdoc`. The trusted parent CSP includes `frame-src 'none'`. Initial `srcdoc` execution works, while subsequent network navigation from generated content is blocked. Both layers also block connections, external images, external styles, forms, and base URL changes. Data images and fonts remain available.

If a blocked self-navigation replaces the inner browser document, the trusted wrapper recovers once with a static checklist. It copies only supported IDs, checked defaults and escaped label text, then installs Centre's own bridge. Generated scripts and event handlers are absent from this recovery document. A visible notice explains the blocked navigation. The parent restores the current checked set, including pending edits, without replaying saves. Recovery never reloads the generated script, so an automatic navigation cannot start a reset loop.

The child posts these messages:

```ts
{ type: 'centre:checklist-ready', resourceId, documentRevision }
{ type: 'centre:checklist-change', resourceId, documentRevision, itemId, checked }
```

The trusted artifact relay accepts only its actual inner iframe window. It requires exact keys, matching resource and document revision, a known item ID, and a boolean checked value. The React parent then calls `validateChecklistBridgeMessage` with the actual outer iframe window and authenticated preview metadata. The validator rejects extra fields, malformed values, unknown IDs, wrong scopes, and payloads over 2048 encoded bytes. A message sent directly from the generated inner frame to the app fails the outer-window check.

The app restores state with:

```ts
{ type: 'centre:checklist-restore', resourceId, documentRevision, hasProgress, checkedItemIds }
```

The relay and child require the correct parent window and matching scope. Restore sets checkbox properties without dispatching changes. The child reports native trusted checkbox changes. The bridge carries no app token, credential, network client, storage interface, resource content, or arbitrary key-value data.

`ChecklistProgressQueue` keeps validated user edits outside a frame's lifetime. It serializes saves, preserves later toggles during navigation, shares changes only within the same resource and document revision, and waits for in-flight writes before a new preview reads saved state. Failed writes retain the latest desired values and show an error with an explicit retry. Restores and ordinary rerenders do not replay saves.

## Local service API

| Route | Result |
| --- | --- |
| `GET /api/resources/:id/preview` | Authenticated `{url, documentRevision, itemIds, checkedItemIds, hasProgress}` |
| `POST /api/resources/:id/checklist-progress` | Authenticated strict `{documentRevision, itemId, checked}` update, persisted before `{ok:true}` |

Preview rejects archived and non-diagram resources. Its read-only artifact capability is bound to the resource and document revision. Updates reject an archived or missing resource with 404, an unsupported ID or malformed body with 400, and a stale document revision with 409. The request body limit is 16 KiB. These routes belong to the local app service.

Standalone exported HTML has no authenticated app bridge and does not write Centre progress.

## Centre cloud and iOS integration

Centre's independent Worker uses the reserved generic record kind `interactiveProgress`, `POST /v1/records`, and `GET /v1/changes`. The database owner imports the canonical schema and validator above. Hosted checklist-specific endpoints and generic unvalidated progress blobs are not part of this contract.

`data.revision` remains the entity domain revision. The Worker envelope's `CloudRecord.version` remains its transport version. `mergeInteractiveResourceProgress(local, incoming)` validates both strict records and returns `InteractiveResourceProgressMerge`:

- Different record or resource identities return `conflict` with `record-identity`.
- Different document revisions return `conflict` with `document-revision`.
- A higher domain revision returns `local` or `incoming`.
- Equal revisions with different checked sets or tombstones return `conflict` with `equal-revision`.
- Equal state returns `same`.

Timestamps do not choose a winner. Transport conflicts still preserve pending local changes for explicit resolution. Imported resources preserve their IDs and exact stored content. Progress for another document revision is retained separately and never projected onto the current document.

The service's visible `/api/state` projection hides progress for archived resources. Sync reads the complete persisted collection and does not infer tombstones from that visible projection.

## Verification

`server/checklist-progress.test.ts` covers strict entities, deterministic IDs, legacy HTML fixtures, forged bridge values, authenticated service calls, atomic storage, service restart, revision changes, archive and restore, and real disk failures. `server/checklist-progress-queue.test.ts` covers queue lifetimes and retries. Browser verification exercises native checkbox interaction through the generated child, trusted relay, React parent, authenticated service, and disk, then reloads the rendered resource.


The rerunnable `scripts/verify-checklist-sandbox.mjs` starts an isolated actual React frame, local service, disk store and HTTP canary. It checks loaded script execution before every attack, positive canary controls, zero outbound attack requests, exact-window bridge rejection, bounded navigation recovery, native saving and reload restoration. Set `CENTRE_PLAYWRIGHT_MODULE` to an installed Playwright module. Use `CENTRE_CHROMIUM_EXECUTABLE` for Chromium or `CENTRE_SANDBOX_ENGINE=electron` for the repo's Electron runtime. It writes reports and screenshots to a fresh temporary directory. No hosted credentials or deployment are required.
