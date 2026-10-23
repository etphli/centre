# Previous quiz attempts

Log has Study time and Attempts views. A marked quiz's **Compare attempts** button opens its own history. Attempts can be filtered by subject and resource. The score table and attempt pickers run oldest first, using the saved ID to order equal timestamps.

Comparison reads the active local snapshot or iPhone workspace replica. It never edits attempts, review memories, resources, sync records or the outbox. It adds no cloud endpoint, database or migration. The existing independent Centre D1 sync transports both legacy `attempt` and canonical `practice.attempt` records. Local history works without a cloud account.

## What the numbers mean

The percentage is the saved score divided by its saved mark total. Counts cover question IDs present in saved feedback or answers. Blank and whitespace-only answers are **Unanswered**, even when the grader awarded zero. Answered zero-mark questions are **Incorrect**. Missing, duplicated or invalid marking remains ungraded.

Two attempts must belong to the same resource. Question rows use the union of their saved IDs. Scores can be compared for a shared ID with the same mark maximum. A higher partial score can also remain a repeated mistake. Unanswered questions never count as repeated mistakes. Changed question sets and mark allocations are identified, and changed maxima never yield a per-question improvement label.

Version 1 attempts do not retain historical prompt text, rubric or grading-model metadata. Shared IDs and equal marks cannot prove equivalent questions or marking. The interface labels available prompts as **Current prompt**, retains saved answers and feedback, and explains that desktop and iPhone graders may differ. Percentage-point changes describe saved scores; they do not establish a learning gain.

## Deletion and isolation

Archiving a resource hides its content and review entries as before. Its attempts remain visible under **Unavailable resources**, using saved resource and question IDs. Restoring the resource restores the existing links. No deleted prompt, title or subject is exposed through this history projection.

Desktop history comes only from the authenticated local service's current snapshot. Native history comes only from the active account/workspace replica. The existing cloud authentication and account-switch guards remain authoritative. There is no comparison cache shared between accounts.

## Portable code and verification

`shared/attempt-comparison.ts` has no runtime dependencies. It exports `AttemptRecord`, `attemptQuestions`, `attemptSummary`, `chronologicalAttempts`, `normalizedScore` and `compareAttempts`. Callers supply workspace-scoped attempts and order the comparison pair. Invalid legacy dates follow dated attempts. The native counterpart mirrors these rules in CentreCore.

Run:

```sh
npm run typecheck
npm test
npm run build
npm run build:electron
node scripts/verify-attempt-comparison.mjs
npm run test:ios-core
npm run test:ios
```

The Electron verifier requires an existing renderer/Electron build and uses a synthetic isolated profile. It exercises filters, sparse history, changed marks, saved answer comparison, keyboard access, resource links, themes, narrow layout, archive and restart. Screenshots and check results go to `.runtime/attempt-comparison/`. It does not call a live AI grader or verify hosted production sync. `npx tsx scripts/verify-attempt-comparison.mjs --serve` supplies the same synthetic data for a local browser verification session.
