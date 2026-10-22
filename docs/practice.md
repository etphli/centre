# Durable practice and learning history

Quiz answers are saved as a draft, separate from immutable graded attempts. The desktop saves answers and the current question immediately, serializes pending saves across navigation, and keeps a browser recovery copy of unsaved edits when storage is available. A save failure keeps the inputs visible and offers retry or explicit discard-and-reload. Marking first flushes the latest draft. Failed marking retains that draft. Start over tombstones the matching draft and creates an empty attempt.

A completed result can be reopened. **Try again** explicitly creates an empty draft; a new attempt never inherits answers from a graded submission.

## Canonical portable module

`shared/practice.ts` imports only Zod. Desktop and hosted grading use the same schemas and pure transitions:

| Kind | Schema | Type |
| --- | --- | --- |
| `practice.draft` | `quizDraftSchema` | `QuizDraft` |
| `practice.attempt` | `attemptSchema` | `QuizAttempt` |
| `practice.learningNeed` | `learningNeedSchema` | `LearningNeed` |
| Embedded evidence | `learningEvidenceSchema` | `LearningEvidence` |
| Grading output | `gradeResultSchema` | `GradeResult` |

`validateGradeResult(questions, candidate, fallbackConcept?)` checks every real question exactly once, marking bounds, and exact maximum marks. It derives totals from validated question feedback and preserves the question's concept label.

`applyGradeEvidence(input)` and `applyReviewEvidence(input)` return new learning-history arrays without mutating their inputs. Callers supply `now` and `createId`. `relevantLearningNeeds(history, subjectId?, topicId?)` selects at most five current needs for prompts. `normalizeConceptKey(label)` normalizes concept labels consistently across runtimes. Existing `shared/schema.ts` imports and re-exports the canonical practice definitions.

## Learning evidence

Learning needs are keyed by the combination of Organato subject ID, Centre-owned topic ID, and normalized concept. Incorrect feedback adds two priority points; partial answers or explicit review flags add one; demonstrated correct work removes two. Resolving a linked Review item removes two. Priority stays within 0–10. It is a practice priority, not an accuracy estimate.

Each need retains its newest eight evidence entries. Improved needs stay at zero and can reopen after later mistakes. The history retains at most 500 records, including tombstones; at that limit existing needs still evolve and new concepts are skipped. Learning history never consumes or edits the separate 50-entry personal facts/preferences memory.

Generation receives recent evidence for the exact requested topic. The app displays a practice-focus note only when generated question concepts match actual current learning needs. Chat receives relevant evidence as a separate context field. Current requests and explicit settings take priority over this inferred practice need.

## Local API and atomic grading

- `PATCH /api/resources/:id/practice-draft`: `{id, expectedRevision, answers, currentQuestion}`. New drafts use `expectedRevision: null`; existing edits use the last saved revision. Identical retries return the existing record without a revision bump.
- `POST /api/resources/:id/practice-draft/start-over`: `{id, expectedRevision}`. Tombstones exactly that draft; repeating the same deletion is safe.
- `POST /api/quiz/grade`: `{resourceId, draftId, expectedDraftRevision, answers}`. Validates that the persisted draft matches the submission. One atomic local save adds the attempt, updates learning evidence and Review, and tombstones the exact submitted draft. Failed writes publish none of those changes.

`Store.atomic` prepares practice changes on an isolated snapshot and publishes its stable record patches only after the disk write succeeds. All Store writes share one queue; ordinary saves read the current state when their queued write executes. An unrelated save cannot capture an uncommitted draft or overwrite a successful practice commit. Record patches preserve unrelated edits made while persistence is pending.

`sourceDraftId` is the durable submission idempotency key. Duplicate submissions return the existing matching result, including after restart. Reusing it with a different resource or answers is a conflict. An in-flight guard also prevents concurrent calls from invoking marking twice. The attempt ledger provides long-term deduplication; the bounded evidence list alone does not.

## Centre cloud integration

The independent Centre Worker owns authentication and generic `POST /v1/records` / `GET /v1/changes`. This feature adds no hosted routes. A domain record's `revision` is separate from the server `CloudRecord.version` used for transport compare-and-swap.

Hosted grading checks `getPracticeAttempt` before AI and after a uniqueness race. It uses trusted `entities.commit(mutations[])` to atomically create one attempt, tombstone its matching draft, and update learning-need records. The database enforces unique `(workspace, sourceDraftId)` attempts. Subject/topic/concept uniqueness must also be retained when reconciling learning needs across devices. iOS owns hosted model calls and reuses the portable validation and transitions.

Generic Review records use `memorySchema` and `StudyMemory` from `shared/schema.ts`. There is no separate `ReviewMemory` export. `learningNeedId` is a nullable UUID defaulting to null; `resolvedAt` is nullable and defaults to null. The trusted generic `reviewMemory` adapter should derive `applyReviewEvidence` only when a prior unresolved record becomes resolved, using its trusted association and stable `resolvedAt` timestamp. Commit both records in the same CAS batch. Missing associations and already-resolved updates add no evidence. Automatic grade cleanup already updates the learning need and must not also invent explicit Review evidence.

## Reproduce the desktop evidence

Run `npx tsx scripts/practice-fixture.ts`. It starts a real local Centre service and renderer on port 5387 with a fresh temporary store and a deterministic fake CLI provider. It first grades an earlier quiz and then generates targeted practice through the actual routes. It never opens the user's data directory or calls a live model. The current fixture directory and resource ID are written to `.runtime/practice-ui-info.json`.

Open **Resources → Inverse operations practice**. Exercise choice and text answers, navigation, reload, resource switching, start over, and Try again. Create `fail-grade` in the printed fixture directory to simulate marking failure. A `slow-grade` file delays marking for navigation checks. A directory named `state.json.tmp` simulates a storage-write failure; remove that fixture directory entry before retrying.

Evidence and the verified state list are in `docs/evidence/practice/`. Hosted synchronization and iOS verification belong to their respective owners and were not exercised by this desktop fixture.

For the automated browser flow, install the verification-only dependency with `npm install --prefix .runtime/ui-tools --no-save --ignore-scripts playwright`, then run `node scripts/verify-practice-ui.mjs` while the fixture is running. It uses installed Chrome, exercises the actual UI and local service, and writes screenshots plus `ui-proof.json`.
