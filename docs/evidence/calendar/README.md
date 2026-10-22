# Calendar verification

Captured 22 October 2026 after integrating main `9064c7f`. These are the real React calendar and local Centre service, backed by a disposable Organato HTTP fixture. No production requests or writes were made.

## Repeat the checks

Start `npx tsx scripts/calendar-fixture.ts` from the repository root. It creates a temporary store, fake credential, three planned sessions and two assignments, and serves http://127.0.0.1:5286. Its URLs are saved in ignored `.runtime/calendar-fixture.json`.

With Playwright and Chromium available, run:

```sh
node scripts/verify-calendar.mjs
node scripts/verify-calendar-captures.mjs
```

If Playwright is installed outside this checkout, set `PLAYWRIGHT_MODULE` to its absolute module path. Outputs go to `.runtime/calendar-evidence/`. The scripts reject non-loopback fixture URLs. Stop the fixture with Ctrl-C.

T3 preview status and open timed out; its open call reported `Preview automation open timed out after 660000ms.` The available CUA inventory had no browser and opening IAB reported `Browser is not available: iab`. Playwright was used as the documented fallback.

## Results

- `npm test`: 188 passed, zero failed, after integrating current main.
- `npm run build`: passed TypeScript and production Vite build. Existing large-chunk and dependency comment warnings remain.
- Hosted module: 60 tests against real SQLite with upstream fetch simulation. Independent three-round review found and verified fixes for remote ownership collision, stale hosted links and stale snapshot responses. Live hosted D1 concurrency and production Organato are unverified.
- Real UI: month arrow-key navigation and Shift-Enter create; week switching; session selection and overlap details; create; move date/time; change duration; complete; failed archive keeps active; successful archive creates tombstone and preserves completion and assignments; previous/next/current week. The study Log state is unchanged by these actions. Zero page errors; one expected HTTP 503 console entry from the intentional failure.
- At 1280×800, the week width and scroll width are both 708px and all seven headers are visible. Selecting the afternoon session scrolls to 756px. The month ends at 621.94px, above the composer at 631px.
- Browser rendering and local service were exercised. Electron packaging, live account provisioning and production deployment were not exercised.

## Review fixes and captures

| Finding | Fix commit | Corrected capture |
| --- | --- | --- |
| CAL-1: seven days and selected-session scroll | `e949ccd` | [Dark week](week-dark-1280.png), [light week](week-light-1280.png) |
| CAL-2: consistent destructive removal | `3f41ae0`, specificity `628460a` | [Removal confirmation](remove-light.png), [failed removal](remove-error.png) |
| CAL-3: human assignment labels | `526e9aa` | [Month and assignment context](month-dark-1280.png) |
| CAL-4: month above composer, chip times | `eb8c290` | [Dark month](month-dark-1280.png), [light month](month-light-1280.png) |
| X-1: canonical shared date/time/duration controls | `c6dc4a2`, spinner `d57e7a3`, then merged main | [Date picker](date-picker-dark.png), [duration menu](duration-light.png), [editor](editor.png) |
| X-2: local neutral focus, today and selection | `628460a`, shared tokens now in main | [Light week](week-light-1280.png), [date picker](date-picker-dark.png) |

The footer's unavailable Codex notice belongs to the intentionally isolated fixture.

Explicit assignment deadline instants are also covered in Sydney and Los Angeles. Date-only deadlines remain all-day on their original calendar date. The final optional `Assignment.dueAt` projection preserves existing date-only consumers.

The coordinator independently cleared CAL-1/2/3/4 and local X-1/X-2 using the fresh fixture at 1280×800. The live recheck confirmed seven visible days, selected scroll, month/composer separation, human status labels, opaque archive confirmation, shared controls and zero page exceptions. This is Calendar visual clearance only; hosted D1/iOS integration and merge approval remain separate. A subsequent test-only addition confirms authenticated operation-not-found and concurrent explicit retry deduplicate to one upstream create; the focused module suite passes 60 tests. No duplicate full build was run.

## Final integration and narrow layout

The coordinator integrated approved main plus chat/Search dependencies, preserving calendar fields and safe archive behavior. A real HTTP regression first reproduced archived sessions remaining in Search, including their stale Organato assignment projection. Confirmed archive now refreshes the index and excludes both tombstoned sessions and those stale projections immediately.

`npm test` passed all 267 tests and TypeScript passed on the stacked calendar candidate. FINAL-NARROW-1 was fixed by stacking weekday and date below 760px. The actual T3 browser at 760x900, dark/large text, showed seven contained headers, no weekday/date overlap and no body overflow. `week-narrow-large.png` and `narrow-recheck.json` record the actual result. This is CSS for the desktop browser calendar grid; native iOS has its own SwiftUI calendar and does not consume this stylesheet. Final whole-program native/build verification follows integration.

These integration and CSS changes were authored by GPT-6.1 Sol.
