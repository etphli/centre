# iPhone verification evidence

These are screenshots from the actual SwiftUI app on an iPhone 16 Pro simulator in macOS CI. They are not web mockups. The UI-test workspace uses explicit local records and a cached text attachment. It never produces fixture AI answers or contacts a deployed service.

## Verified implementation

Implementation `ebdaf47198b9f430c9fcb03fec12edab213e045c` passed [native CI run 39767722272](https://github.com/etphli/centre/actions/runs/39767722272): unsigned iOS Release build, 63 portable XCTest cases, and all 10 simulator UI tests. The simulator suite executed in 223.339 seconds with zero failures. Xcode's exported screenshots below come from that run.

[Desktop CI run 39767722350](https://github.com/etphli/centre/actions/runs/39767722350) passed type checking, all 162 Node tests, renderer production build, Electron build, and unsigned app packaging. The local portable Swift executable also passed real disk reopen, exact lost-acknowledgement replay, successor edits, conflicts, checkpoint recovery, and DST checks.

The additional Review-resolution and light-theme restart test is in `62a16b9`. A later focused timer regression exercises Keep iPhone preserving its owned running lease, normal restart pausing it, and Keep cloud importing a running lease paused. Their actual results are recorded on the PR and in its native workflow, rather than inferred from these earlier captures.

## Exercised native states

| Actual behavior | Capture |
| --- | --- |
| Offline chat list | [Chat](01-chat-dark-offline.png) |
| Note body restored after app termination | [Saved note](02-note-body-restored-from-disk.png) |
| Quiz choice saved and restored without invented marking | [Draft](03-offline-quiz-draft.png), [restored choice](04-quiz-answer-restored.png) |
| Immediate native Back preserves quiz answers | [Restored after Back](14-quiz-answer-after-immediate-native-back.png) |
| Running timer recovers paused at its checkpoint | [Recovered timer](05-timer-recovered-paused.png) |
| Completed Log entry and weekly goal survive restart | [Log and goal](06-completed-log-and-goal-restored.png) |
| Saved Review question | [Review](07-review-saved-memory.png) |
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

GPT-6.1-Sol independently inspected the real native captures, then rechecked all corrected native findings. No remaining screenshot-backed P1 or P2 findings were identified in those captures. No new Claude review worker was started.

## Boundary verification and limits

The rerunnable `scripts/verify-mobile-cloud.mjs` executes the database owner's actual authenticated router, entity adapters, AI handlers, hosted Organato module, and isolated SQLite. It passed workspace isolation, one-use pairing, durable chat results/history, atomic attempt/draft/evidence commits, encrypted connector credentials, ambiguity-safe calendar operations, and attachment inheritance after parent archive. It used **2 simulated inference calls and 3 simulated upstream writes**. The owned desktop fixture was stopped, its port 5299 rejected connections, and no other listening process belonged to this checkout. The desktop service was not used. This proves local integration, not hosted inference or production rollout.

The own grade regression also seeds 499 retained live Learning Needs plus a transport tombstone. Grading still commits once, updates an existing concept, and skips a new concept at the 500-record cap. Native conflict tests prove independent transport/domain revisions and prohibit local overwrites of immutable attempts.

Local Xcode and an iOS runtime are unavailable. T3 lists no local devices and reports that `xcrun simctl list devices --json` failed. The actual simulator results therefore come from CI. Local Electron flow and text-size scripts were attempted but blocked by a missing Electron Framework and `Operation not permitted` when creating its symlink. A later T3 preview recheck timed out twice; the committed desktop captures were taken during the earlier successful real preview session.

Real Google account sign-in, deployed Workers AI inference, production D1 synchronization, and signed-device installation are not verified. No production deployment, migration, TestFlight upload, or downloadable invitation exists. [Release setup](../../ios/release.md) lists the exact remaining account, signing, privacy, and hosting requirements. The coordinator owns any authorized main-branch merge; deployment and upload remain separate approval gates.
