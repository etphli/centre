# Centre for iPhone

Centre has two iPhone clients. The Safari web app at [the public iPhone address](https://centre-cloud.etphli.workers.dev/iphone/) is intended for Safari's Add to Home Screen flow and does not require a signed native release. That device flow has not been verified here. The native SwiftUI app targets iOS 17 and later, reads and writes Centre Cloud directly, and is still awaiting Apple distribution setup. The two clients use separate local storage.

For the Safari install and account-pairing steps, see [iPhone web installation and native parity](web-installation-parity.md). There is no published TestFlight invitation or downloadable native release yet. See [native release setup](release.md) before signing or distributing the SwiftUI app.

## Architecture

`ios/CentreApp` owns the native app's navigation, controls, Google Sign-In, Keychain access, and Quick Look. `ios/Sources/CentreCore` contains the portable Foundation domain, transport, replica, and operation journals. XcodeGen defines the native application and UI-test targets in `ios/project.yml`. The Safari app is a separate browser client; it does not wrap or execute these Swift modules.

The Safari app and SwiftUI app use Centre Cloud rather than the Mac's local Electron service or desktop Codex process. They keep separate local state and have different platform features. The native target provides native text sizing, navigation, file previews, and Keychain storage. The portable Swift package lets persistence and timer rules run without the iOS SDK. Canonical JSON fixtures check parity with the TypeScript domain.

The app mirrors Centre's dark, midnight, and light palette and Iowan titles. Controls and selected states use neutral Centre ink. The reading-size preference adjusts ordinary Dynamic Type sizes; accessibility sizes remain unchanged.

## Native app features

- Chats read portable messages and ancestry from Centre Cloud. New replies use the hosted tutor, with explicit first-use data permission and honest waiting, quota, and failure states.
- Saved notes, quizzes, tests, flashcards, and static diagrams remain readable offline. Notes and quiz drafts save locally before network work. A draft is not shown as a graded attempt.
- Hosted marking validates every question and atomically commits an immutable attempt, the draft tombstone, and canonical learning evidence. `sourceDraftId` is the durable deduplication key. There is no previous-attempt comparison interface.
- Review resolutions save through generic `reviewMemory` records. The central trusted adapter commits linked evidence atomically using `resolvedAt` as the retry time.
- Calendar reads cached subjects, work, and events from the hosted Organato connector. Create, edit, complete, archive, link verification, and uncertain-operation reconciliation call that connector directly. Planned time never becomes actual Log time.
- Log supports a timer, manual sessions, and Monday/IANA-zone weekly goals. Restart, import, and background recovery pause timers at their saved checkpoint. A second phone never acquires a running timer from synchronization.
- Settings support account pairing, Google sign-in, conflicts, appearance, reading size, time zone, study preferences, hosted Organato connection setup, and private-data removal on sign-out.
- Chat attachments download through authenticated, target-scoped metadata and chunk routes. Size, base64, and SHA256 checks precede atomic publication. Previously downloaded files open offline through Quick Look. HTML uses a text extension.

Diagrams are deliberately static on iPhone. The renderer disables JavaScript, handlers, navigation, windows, downloads, and remote requests. Script-dependent drawings can show only their static content. Desktop checklist progress stays in the replica, but this release does not execute generated checklist scripts or fabricate progress for them.

## Native persistence and retries

The following replica and retry rules describe the SwiftUI client. The Safari app has browser-managed storage and its own offline behavior. See [iPhone web installation and native parity](web-installation-parity.md) for the shared record and hosted-AI contracts.

One atomic replica file belongs to one HTTPS server and workspace. It holds the cloud shadow, cursor, local edits, explicit conflicts, and AI requests. Unknown kinds and schema versions stay on disk. Visible or archived projections never imply deletion of hidden records.

`CloudRecord.version` is transport CAS. Domain `data.revision` remains separate. The optional `createdCursor` is retained through pending edits. Equal-timestamp messages sort by its arbitrary-precision numeric value; records without it retain their tie-group positions.

A sent mutation keeps the same UUID and body through lost acknowledgements. Later edits become successors whose expected version changes only after acknowledgement. A conflict preserves both sides until an explicit choice. Keeping the iPhone copy advances the domain revision above both copies and uses the cloud transport version separately. Keeping an owned running timer also preserves its lease, state, and segments. Choosing cloud data still imports running timers paused at their checkpoint, and an ordinary restart still recovers them paused. Marked attempts are immutable and only offer the cloud copy. No timestamps choose the winner.

Calendar writes use a separate journal. An uncertain sent operation only polls its receipt. An authenticated `operation_not_found` enables **Try saved change**, which resends the exact original method, route, operation ID, and body. It never creates new preconditions or silently closes the operation. The hosted ledger prevents concurrent copies of that same request from repeating an upstream write. Existing `pending` or `unknown` receipts require explicit reconciliation.

Sign-out blocks producers, cancels scheduled sync, invalidates retained actors, removes local files and Keychain access, then attempts device revocation. Unsynced changes require an explicit discard choice. Failed remote revocation does not preserve local account data.

## Contracts and integration dependencies

[contract.json](contract.json) records the exact API and owner boundaries. Required companions are [Centre cloud PR 19](https://github.com/etphli/centre/pull/19) and the hosted connector in [calendar PR 17](https://github.com/etphli/centre/pull/17). This branch does not create another database, auth service, Organato connector, or Organato repository change.

Canonical sources are:

| Domain | Source |
| --- | --- |
| Study Log | Main `9064c7f`, `shared/study-log.ts`, `shared/study-log-sync.ts`, and copied fixture `34f6d14a…` |
| Practice | `8095205` and `9ec445d`, included `shared/practice.ts`; portable question concepts and `practiceFocus` added from PR 16 |
| Cloud authority | `65ba298` plus retained-history fix `b48b673`, `cloud/worker.ts`; atomic `putMessage`, `commit`, `getPracticeAttempt`, and `resolveReview` |
| Calendar | PR 17 portable `5d3946d`, `603ec3b`, `2d96ba0`; hosted `f4b3131`, `bf25350`, `7e357ac`, `b1a1394` |
| Chat ancestry | `98d76b0`, exact portable chat/message projections; feature 10 PR 14 |
| Checklist progress | PR 15 `shared/checklist-progress.ts`; deterministic resource/document UUID v8; retained without script execution |

The hosted AI source is `cloud-ai/index.ts` and `cloud-ai/grade.ts`. It mounts after the central Worker's authentication. Assistant persistence requires `entities.putMessage(mutation, chatId)`, whose active-chat check runs in the same D1 batch. A soft-archived chat keeps metadata and messages, but cannot receive AI or serve attachment bytes as a direct active target. Valid active descendants can retain inherited associations through the canonical server ancestry gate.

## Hosted AI

The fixed provider model is [`@cf/meta/llama-3.1-8b-instruct-fp8`](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/). It is a small hosted Llama tutor, with different quality and capabilities from desktop Codex. It does not run desktop tools or arbitrary actions. A Codex or ChatGPT subscription does not authorize this API path.

The server loads bounded saved messages, accepts no model or provider URL from clients, limits admissions, and stores durable results before assistant publication or grading commits. Provider timeouts and expired computation leases never silently restart inference. Retries can finish a saved result or prepared atomic commit. Written grading uses canonical validation and evidence transitions; objective questions are graded deterministically. Saved question concepts remain authoritative. The 500-record Learning Need cap includes transport tombstones: an existing concept can still evolve at the cap, while a new concept is skipped without blocking the attempt.

Chat limits are 20 admissions per workspace per UTC day, 120 globally, and 2/16 active. Chat inputs are at most 8,000 characters plus 20 saved messages bounded to 8,000 history characters; output is capped at 1,024 tokens. Grading limits are 10 admissions per workspace per day, 60 globally, and 2/8 active, with 30 questions and 20,000 quiz/answer characters. Written output is capped at 4,096 tokens. Provider waits end after 45 seconds.

[Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/) keep provider access in `env.AI`. No provider key belongs in the binary. Cloudflare currently grants 10,000 Neurons per day on Workers Free; excess operations fail. These app limits do not guarantee a particular neuron budget. Keep the account on Free and do not enable paid overage or prepaid gateway credits. See [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

## Verification

Run from the repository root:

```sh
npm run test:ios-core
npm run test:ios
npx tsx scripts/verify-mobile-cloud.mjs --database-checkout /path/to/database-owner --calendar-checkout /path/to/calendar-owner
```

`test:ios` generates the Xcode project, builds the unsigned Release target once, and runs real simulator UI tests. Its EXIT trap exports screenshots, recordings, the result bundle, and logs even when a test fails. CI runs these commands on macOS with Xcode. `.runtime/ios-evidence` contains raw artifacts; selected reviewed captures belong in `docs/evidence/ios`.

The integration script executes the real central auth/router/entity code, AI handlers, and hosted Organato module against isolated SQLite. Identity signing keys, inference, and upstream responses are explicitly simulated. It asserts workspace isolation, one-use pairing, exactly-once grading, encrypted connector credentials, calendar ambiguity rules, and inherited attachment access. It never contacts production or the desktop service. It is not live Workers AI proof.

The local machine has Swift and XcodeGen but no Xcode application or T3 iOS simulator. The standalone `CentreCoreVerify` executable exercises real filesystem reopen, stable lost-ACK retries, conflicts, timer recovery, and DST. XCTest and actual iOS UI proof come from the PR's macOS CI. See the [evidence record](../evidence/ios/README.md) for actual results and outstanding gates.
