# iPhone verification evidence

These are screenshots from the actual SwiftUI app on an iPhone 16 Pro simulator in macOS CI. They are not web mockups. The UI-test workspace uses explicit local records and a cached text attachment. It never produces fixture AI answers or contacts a deployed service.

## Verified implementation

Implementation `b12884568744312afbf6ba1865c4e48db0552435` passed [native CI run 39770040680](https://github.com/etphli/centre/actions/runs/39770040680): unsigned iOS Release build, 64 portable XCTest cases, and all 12 simulator UI tests. The simulator suite executed in 318.606 seconds with zero failures. Xcode's exported screenshots below come from that run. Its [complete artifact](https://github.com/etphli/centre/actions/runs/39770040680/artifacts/12422756534) includes recordings, result bundle, and logs.

[Desktop CI run 39767722350](https://github.com/etphli/centre/actions/runs/39767722350) passed type checking, all 162 Node tests, renderer production build, Electron build, and unsigned app packaging. After integrating Search main `9418451`, combined local type checking and all 196 Node tests passed. The local portable Swift executable also passed real disk reopen, exact lost-acknowledgement replay, successor edits, conflicts, checkpoint recovery, and DST checks.

The added Review-resolution and light-theme restart test passed, as did the focused timer test for Keep iPhone preserving its owned running lease, normal restart pausing it, and Keep cloud importing a running lease paused. Visual inspection also found pale picker values immediately after switching to light mode. A focused Settings-local tint fix follows this run; its corrected capture and actual result are linked from the PR before readiness.

The green native source tree is `6f8075ea8c0cf384698f14a979cc24274f4e5ad8`. Search integration `ccd5abf` preserves that exact tree. The two-line Settings tint correction `7a10582` changes it to `e8bbc073884c39efd9f5d36d4df03cd7072856be`; the PR records its actual follow-up verification.

## Exercised native states

| Actual behavior | Capture |
| --- | --- |
| Offline chat list | [Chat](01-chat-dark-offline.png) |
| Note body restored after app termination | [Saved note](02-note-body-restored-from-disk.png) |
| Quiz choice saved and restored without invented marking | [Draft](03-offline-quiz-draft.png), [restored choice](04-quiz-answer-restored.png) |
| Immediate native Back preserves quiz answers | [Restored after Back](14-quiz-answer-after-immediate-native-back.png) |
| Running timer recovers paused at its checkpoint | [Recovered timer](05-timer-recovered-paused.png) |
| Explicit local choice retains running state; cloud choice imports paused | [Keep iPhone](20-keep-local-timer-still-running.png), [restart](21-local-timer-paused-on-restart.png), [Keep cloud](22-keep-cloud-timer-imported-paused.png) |
| Light theme survives restart | [Light Log](19-light-log-after-restart.png) |
| Completed Log entry and weekly goal survive restart | [Log and goal](06-completed-log-and-goal-restored.png) |
| Review action has a 44-point target; resolution survives restart | [Review](07-review-saved-memory.png), [resolved after restart](17-offline-review-resolution-restored.png) |
| Cached calendar explicitly reports offline and saved plans | [Calendar](08-offline-calendar.png) |
| Pending changes and distinct mobile provider | [Settings](09-settings-pending-and-provider.png) |
| Accessibility XXXL actions remain readable and reachable | [Log](10-accessibility-large-log.png), [Settings](11-accessibility-large-settings.png) |
| Unconfigured sign-in rejects a URL containing credentials | [Connection error](12-unconfigured-account-rejects-credential-url.png) |
| Real WKWebView delegate cancels external navigation | [Static saved diagram](13-saved-diagram-navigation-cancelled.png) |
| Cached attachment opens through native Quick Look offline | [Attachment](14-cached-attachment-quick-look.png) |
| AI data permission precedes sending; pending message survives restart | [Permission](15-cloud-ai-consent-before-send.png), [saved message](16-offline-message-restored-no-fixture-inference.png) |

The diagram test exercises an actual external-link attempt and observes the real navigation cancellation counter. It is not a packet-level network interception test. JavaScript stays disabled on iPhone; generated interactive checklist scripts do not execute there.

## Design findings and corrections

| Finding | Fix | Actual corrected evidence |
| --- | --- | --- |
| IOS-1: desktop pairing looked like a field and worked while signed out | `38c6c54`, `fbd922e`: normal Centre button, authentication gate, Connections guidance | [Dark](desktop-ios1-dark-signed-out.png), [light and large](desktop-ios1-light-large-signed-out.png) |
| IOS-2: duplicate pairing and technical install copy | `fbd922e`, `cd657b8`: shared `AccountPairing`, plain install copy; PR 19 consumes the same component | Desktop captures above; authenticated cloud widget evidence belongs to PR 19 |
| X-2: generic blue selection | `38c6c54`: neutral palette and window tint | Native quiz selection and Settings captures above |
| Native accessibility: Pause split mid-word and Settings squeezed values into columns | `ebdaf47`: stacked actions and labeled values at accessibility sizes | Corrected XXXL Log and Settings above |
| Native calendar: empty cached week looked current | `ebdaf47`: explicit offline notice, saved-plan labels | Corrected calendar above |
| Review action inherited the row identifier and had a small target | `c06d01c`, `b128845`: contained accessibility group and 44-point action | Review and resolved-after-restart captures above |
| Keep iPhone incorrectly recovered its own running timer | `a7106f3`: choice-aware lease handling, exact core and actual simulator regressions | Keep iPhone, restart and Keep cloud captures above |

GPT-6.1-Sol independently inspected the real native captures, then rechecked all corrected native findings. Those corrections were clear. The later light Settings capture exposed one remaining P1 in picker contrast; readiness requires the focused tint correction and a new actual capture. No new Claude review worker was started.

## Boundary verification and limits

The rerunnable `scripts/verify-mobile-cloud.mjs` executes the database owner's actual authenticated router, entity adapters, AI handlers, hosted Organato module, and isolated SQLite. It passed workspace isolation, one-use pairing, durable chat results/history, atomic attempt/draft/evidence commits, encrypted connector credentials, ambiguity-safe calendar operations, and attachment inheritance after parent archive. It used **2 simulated inference calls and 3 simulated upstream writes**. The owned desktop fixture was stopped, its port 5299 rejected connections, and no other listening process belonged to this checkout. The desktop service was not used. This proves local integration, not hosted inference or production rollout.

The own grade regression also seeds 499 retained live Learning Needs plus a transport tombstone. Grading still commits once, updates an existing concept, and skips a new concept at the 500-record cap. Native conflict tests prove independent transport/domain revisions and prohibit local overwrites of immutable attempts.

Local Xcode and an iOS runtime are unavailable. T3 lists no local devices and reports that `xcrun simctl list devices --json` failed. The actual simulator results therefore come from CI. Local Electron flow and text-size scripts were attempted but blocked by a missing Electron Framework and `Operation not permitted` when creating its symlink. A later T3 preview recheck timed out twice; the committed desktop captures were taken during the earlier successful real preview session.

Real Google account sign-in, deployed Workers AI inference, production D1 synchronization, and signed-device installation are not verified. No production deployment, migration, TestFlight upload, or downloadable invitation exists. [Release setup](../../ios/release.md) lists the exact remaining account, signing, privacy, and hosting requirements. The coordinator owns any authorized main-branch merge; deployment and upload remain separate approval gates.
