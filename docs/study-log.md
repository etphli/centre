# Study log v1

Centre stores actual study separately from planned Calendar events. The Log route shows eight weekly totals, daily totals, subject attribution, a per-week aim, and editable study entries. The top-bar timer remains mounted across navigation. `StudyLogPage` is the content extension point for future Log features; no quiz comparison is implemented here.

## Persisted records

The authoritative Zod schemas and inferred TypeScript types are in `shared/study-log.ts`. Portable examples and expected totals are in `shared/fixtures/study-log-v1.json`.

`Snapshot.studyLog` contains `{schemaVersion:1,sessions,goals}`. Legacy snapshots default to an empty log. The existing atomic `state.json` writer persists records locally without hosted authentication. A serialized study mutation validates and saves its new state before reporting success. Study changes become visible in shared state only after the atomic rename succeeds. Unrelated queued saves read the latest confirmed state when they execute, so they cannot persist a rejected study mutation.

Sessions and goals have stable UUIDs, `schemaVersion:1`, positive domain `revision`, UTC `createdAt` and `updatedAt`, and nullable `deletedAt`. Deletion retains a tombstone. Changes to existing records require the expected revision. A repeated create with the same ID and matching content returns the existing record.

A session contains `source:timer|manual`, nullable `subjectId` and `taskId`, `title`, `notes`, `timeZone`, closed UTC `segments:[{start,end}]`, and one of these states:

- `{kind:'running',since,checkpointAt,lastActivityAt,confirmedAt}`
- `{kind:'paused',reason:'user'|'idle'|'recovery'|'check-in'|'clock'}`
- `{kind:'completed'}`

Manual sessions are completed and contain at least one interval. Paused time is absent from segments. A timer may complete with no elapsed time. Completed timer entries retain their separate intervals when edited; changing metadata preserves exact timestamps.

A goal contains `weekStart`, an ISO Monday date, `timeZone`, and integer `targetMinutes` from 1 to 10080. There is one live aim per week and timezone. Aims do not silently repeat into future weeks.

## Timing and boundaries

The service clock controls timer transitions. The renderer checkpoints every 15 seconds. A lease expires after 45 seconds without a checkpoint, and recovery closes the interval at the last persisted checkpoint. Service startup performs the same recovery. Closed-app time is never added. Resume is explicit.

Ten minutes without pointer, keyboard, or scroll interaction pauses at the idle boundary. Reading for longer requires interaction or **Still studying** in timer details. A separate 60-minute check-in limit applies even with continuous interaction. Clock rollback pauses at the saved checkpoint. Safety boundaries take precedence over heartbeat or resume requests, so a late heartbeat cannot resume an unattended timer.

Weeks start Monday in `settings.timeZone`. Temporal calendar arithmetic determines local day and week boundaries, including 23-hour and 25-hour days. Durations use UTC elapsed milliseconds. Overnight entries split across local days and weeks. An entry spanning two weeks shows only the selected week's time in the list.

Create and edit reject future study, malformed or overlapping intervals, stale revisions, and unknown subject or task references. Task links must match a selected subject. The local service starts one unfinished timer and rejects resume while another timer runs. Multiple paused timers imported from other devices remain available to finish in order. Stop and pause remain available even when imported historical intervals overlap. Aggregation defensively unions intervals imported from different devices, then attributes overlaps to the earliest-created session with UUID as a tie-breaker. Subject totals therefore sum to the actual weekly total.

## Desktop action requests

`src/data/useStudyLog.tsx` exports `requestStudyLogAction({id,mode})`. The unique request ID deduplicates the latest 128 requests. Modes are `manual`, `timer`, and `week`. The canonical route is `{kind:'log'}`.

`manual` navigates to Log and opens the existing entry dialog. `week` navigates to Log, selects the current week, and focuses `#study-week-title`. `timer` focuses the top-right controls on the current page, opening details if a timer exists. It never starts or resumes time. The hook uses the validated `centre:study-log-action` CustomEvent internally; shortcut owners call the typed export rather than create another Log screen.

## Local API

Every route requires the existing local bearer capability or validated Electron IPC. Responses contain the full `StudyLog`.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/study-log` | None |
| POST | `/api/study-log/sessions` | `{id,subjectId,taskId,title,notes,timeZone,segments}` |
| PATCH | `/api/study-log/sessions/:id` | `{expectedRevision,subjectId,taskId,title,notes,timeZone,segments}` |
| POST | `/api/study-log/sessions/:id/delete` | `{expectedRevision}` |
| POST | `/api/study-log/timer/start` | `{id,subjectId,taskId,title,notes,timeZone}` |
| POST | `/api/study-log/timer/:id/:action` | `{expectedRevision,activity?:boolean}` |
| POST | `/api/study-log/goals` | `{id,weekStart,timeZone,targetMinutes,expectedRevision?:number}` |

Timer actions are `heartbeat`, `pause`, `resume`, `stop`, and `confirm`. Only completed sessions can be edited or deleted. Validation failures return 400, missing entries 404, and overlap or revision conflicts 409. Existing authentication and request-size limits apply. The Electron allowlist exposes only these methods and paths.

## AI logging from chat

The chat model has `centre_get_study_log` and `centre_log_study`. For example, ask “Log my algebra study yesterday from 6 pm to 7:30 pm in Sydney.” It reads current records, then records an actual completed manual entry with the student's title, subject/task links and notes. Log refreshes from confirmed service state after chat changes without requiring a reload.

`server/study-log-tools.ts` exports `logStudyInputSchema`, `logStudy` and `studyLogInstructions`. Write arguments are `{id,confirmedByUser:true,title,notes,subjectId,taskId,timeZone,segments:[{start,end}]}`. Tool segments contain local ISO date-times without offsets, such as `2026-10-21T18:00`. The adapter converts them with canonical `localStudyInstant` and calls the same persisted manual-entry service. It returns only the confirmed saved record. Stable UUID retries are idempotent.

A write requires an active, uncancelled student chat and explicit-request confirmation. Guided resource generation cannot write study records. The model is instructed to ask for missing actual times, never invent intervals from duration alone, never infer study from a chat or Calendar plan, and report success only after a successful save. The tool cannot start timers or edit/delete existing records. Existing future-time, overlap, reference and DST rejection rules apply.

`server/study-log-tools.test.ts` runs the real Codex protocol handler, authenticated HTTP routes, dynamic tools and disk persistence with a deterministic model CLI fixture. `node scripts/verify-study-log-ai.mjs` drives the built app's actual chat and Log screens through that fixture and captures the saved entry. This verifies wiring and persistence, not live model reasoning or a hosted integration.

## Cloud integration

Feature 3 owns Centre's independent Cloudflare D1 database and Worker. This change does not configure, migrate, or deploy a remote database. Organato remains canonical for subjects, tasks, and planned Calendar entries.

`shared/study-log-sync.ts` exports `studyLogToCloudRecords(log)` and `applyStudyCloudRecord(log,record,now)`. The kinds are `studySession` and `studyGoal`. The cloud owner supplies its authenticated envelope, transport version, durable outbox, and explicit conflict decisions. `CloudRecord.version` is separate from `data.revision`.

The caller resolves transport conflicts before applying a record. Imported running timers always recover paused at checkpoint, including on a second device. The projection checks ID consistency and v1 schemas, preserves tombstones and unrelated study records, and rejects missing live data. A null-data tombstone for an unknown ID remains in the transport shadow rather than inventing a domain record. Live running data becomes a paused local edit with an incremented domain revision, which the transport must retain as pending local state.

Local-first operation has no dependency on the database PR. Hosted sync, account isolation, and mobile transport require that owner's integration and approval before deployment. No hosted production integration is claimed here.

## Verification

- `npm test` includes persisted timer transitions, lease and idle recovery, hourly check-ins, rollback, concurrent edits, deletion, save failure, authentication, IPC rules, portable fixtures, cloud import, DST, overlap attribution, and week totals.
- `npm run typecheck`, `npm run build`, and `npm run build:electron` build the real application. The Electron build requires Google Desktop OAuth configuration. Local verification may use explicit nonfunctional fixture values, which do not verify Google login.
- `node scripts/verify-study-log.mjs` opens the production Electron app against temporary data. It drives manual create, edit, delete, aims, themes, pause, resume, stop, navigation, and a second-process restart. Screenshots and JSON reports are saved in ignored `.runtime/`.
- `node scripts/verify-flows.mjs` checks existing desktop resource and chat flows. It uses its documented synthetic provider fixtures.

The saved [desktop screenshots](evidence/study-log/README.md) use synthetic local data. During verification, T3 preview disconnected and Electron capture intermittently returned `UnknownVizError`. The final native run uses software rendering and bounded capture retries. A development-renderer fallback was rejected by the existing desktop IPC authority and is excluded from passing evidence. Production-renderer checks remain authoritative.
