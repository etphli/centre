# iPhone web installation evidence

## Actual verification

- **440 JavaScript tests pass**, including the central Worker/SQLite, immutable receipts, portable domain schemas and mobile data regressions. TypeScript checks pass.
- The renderer, iPhone production bundle, Electron main/preload and Worker dry-run build pass. The existing large-bundle advisory remains; it is not a build failure.
- **27 production browser checks pass**, using real Chromium, IndexedDB, service worker, authenticated Worker routing, CAS and SQLite. Google identity and model inference are simulated. Objective grading runs the actual central grader. See [the browser report](browser-report.json).
- **7 actual Electron checks pass**, using the production renderer/service and an isolated local profile. Appearance settings are changed through the UI. The public installation QR appears while signed out, and account pairing remains disabled. The 960px layout has no body overflow and account controls can scroll above the composer. See [the desktop report](desktop-report.json).
- Apple's Core Image independently decodes both the generated QR PNG and its actual Electron screenshot crop to `https://centre-cloud.etphli.workers.dev/iphone/`. See [decoder output](qr-decode.txt). This is image decoding, not a physical iPhone camera test.

## Recovery and review findings

| Finding | Correction and proof |
| --- | --- |
| Browser fetch lost its global receiver | Bound the default fetch; receiver regression and actual browser pairing pass. |
| Every keystroke/checkpoint created a cloud mutation | Never-sent edits coalesce. A 100-edit regression retains one latest tail behind the immutable uncertain head. |
| Chat send could split message and request journal across commits | `saveBatch` atomically commits message/chat/outbox/journal/composer. Rollback and older-ACK tests pass; browser checks a committed reply after an intentionally lost HTTP response. |
| A definitive grading failure locked answer editing permanently | Persist terminal rejection state, keep saved answers and offer a confirmed new draft. [Failed marking](grade-failed.png) and actual restart flow pass. Ambiguous failures retain the original request ID. |
| An old screen could act after another account connected | Screen actions carry their original workspace through transaction and request boundaries. Tests reject stale saves, journals, reads, sync and disconnect without changing the new workspace. |
| A new workspace reused an old workspace's sync promise | Sync reuse is generation-scoped. The regression failed before the fix with only A requested; it now requests A then B and loads B's saved topic. |
| Async checkboxes and rapid appearance changes showed stale state | Optimistic checklist feedback plus durable save confirmation; serialized preference patches use current values. Browser reload and light/large checks pass. |

Independent GPT-6 Luna reviews found no P1 in the reviewed data, timer, cache, document-rendering and auth paths. Both round-one P2 findings and the round-two sync finding above are resolved with checks. This does not establish that the app has no possible bugs.

## Screens and scope

All phone images contain disposable synthetic study data. The notes/offline image follows a full offline page reload, not a mocked offline badge. The recovered timer follows a running checkpoint and real page reload. Lost chat/grade responses are simulated HTTP 503 responses after the actual Worker committed; the subsequent read returns the original result without another inference or attempt.

The browser run covers 390px and 320px widths, large text, dark/light/midnight, keyboard focus, saved quiz answers, checklist reload, no script/image canary requests from generated HTML, Review resolution, hosted chat, failed grading recovery, timer pause/restart, offline library, static-only cache and a second account's isolation. Full-page screenshots may show the fixed bottom navigation partway down the image, at the original viewport edge; scrolling exposes content above that fixed bar.

The native SwiftUI app is unchanged by this web client. This host has no full Xcode or iOS device. Safari's Share sheet, Add to Home Screen and physical-device behavior remain unverified here. Chromium emulation is not iOS evidence. No live production model inference is claimed by the fixture results. Existing Apple signing, native download and GitHub runner billing blockers remain separate from web deployment.

Rerun the browser proof with `scripts/verify-iphone.mjs`, desktop proof with `scripts/verify-iphone-desktop.mjs`, and image decoding with `swift scripts/verify-iphone-qr.swift .runtime/iphone-desktop installation-qr installation-qr-screen`.
