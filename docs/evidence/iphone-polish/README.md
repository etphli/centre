# iPhone daily-use improvements

All screenshots use synthetic study data in the real Chromium client. The localhost fixture runs Centre's actual Worker router, account-scoped entity store, SQLite and IndexedDB. Identity and inference are simulated. No production student account was used.

- [Baseline reproduction](baseline.json): switching the browser offline left the old client saying Synced; a saved quiz had no Log resume action.
- [17 new browser checks](report.json): immediate offline/reconnect status, quiz and Review shortcuts, large text at 320px, keyboard focus, an actual waiting service worker, explicit deferral, offline activation/reload, paused timer, retained answers/outbox/private unsent draft, and a deliberately failed deferred chunk with navigation/reload recovery.
- [27 original browser checks](regression.json): existing Log, timer, quiz grading, checklist, Review, chat, Calendar, themes, reload/offline cache, post-commit lost responses and account isolation remain working. Google identity and inference are simulated.
- Full JavaScript suite: **442/442 pass**. Typecheck, production renderer and iPhone builds, and Worker dry run pass. Existing large-chunk advisories remain.
- [Production bundle comparison](performance.json): the entry script drops from 905,907 to 555,167 bytes, **38.7%**. This measures startup code only. All deferred chunks are still downloaded into the public offline cache, so total bandwidth is not reduced by that amount.

## Actual captures

- [Log resume shortcuts, dark](continue-dark.png).
- [Log resume shortcuts, light large text at 320px](continue-light-large-320.png).
- [Explicit update confirmation with offline queued edits](update-confirm-light.png).
- [Unsent draft after the offline update](updated-draft-offline.png).
- [Recovery after intentionally blocking a deferred page download](page-recovery.png).

The browser preview was tried first. Two snapshot calls failed with `Preview snapshot failed: Preview automation snapshot timed out after 15000ms.` The documented Playwright workflow supplied the captures and offline/update controls.

This change affects the Home Screen web client only. macOS UI, shared records and cloud API contracts are unchanged. Native SwiftUI uses its own navigation and Apple update mechanism, so service-worker activation has no native counterpart. Physical Safari/Home Screen installation and native simulator execution remain unverified on this CLT-only host. GitHub's prior native jobs were blocked before starting by account billing; no billing or Apple account changes were made.

Run after `npm run build:iphone`:

```sh
CENTRE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core node scripts/verify-iphone-polish.mjs
CENTRE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core node scripts/verify-iphone.mjs
```
