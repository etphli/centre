# iPhone web installation and native parity

Centre's iPhone web app is a browser client served at `/iphone/`. Its installation path is Safari's Add to Home Screen, without distributing a signed native app. The SwiftUI app remains a separate iOS client. This page records the shared cloud contracts, offline scope, and platform differences for the web path.

## Install the web app before pairing

Open `https://centre-cloud.etphli.workers.dev/iphone/` in Safari on the iPhone. Use **Share > Add to Home Screen**, then open Centre from the Home Screen. Pair after installation. Safari tabs and Home Screen apps may use separate local storage, so a session created in a tab may not appear in the installed app.

The public installation QR contains only the `/iphone/` address. It carries no account code, device token, or account authority. It is safe to share.

To pair, create a new one-time code in Centre on the Mac and scan the account QR. The `/pair` page offers **Copy account code** and **Install Centre for iPhone**. Open Centre, paste the code, and submit it there. Loading `/pair` does not redeem the code. The code expires after five minutes and can be used once. Treat it as a secret until it expires or is redeemed.

The account code is in the URL fragment, as in `/pair#code=...`. Browsers do not send a fragment with the HTTP request. The page clears the fragment from the address bar. The native app's **Open native Centre** action uses `centre://pair` and shows an explicit confirmation sheet. `centre://pair` is a custom URL scheme. The HTTPS `/pair` page is not an Apple universal link, and this feature does not claim an associated domain.

## Cloud authority is shared, local storage is separate

Both iPhone clients connect to the existing Centre Worker and Centre-owned D1 database. Pairing creates a device session in the same cloud workspace. The Worker derives the workspace from the bearer session and scopes records and hosted AI requests to that workspace. The `/iphone/` install address has no authority. In the pairing flow, the Worker creates a session only after an app explicitly submits a valid one-time code.

The native client stores its replica in an app-local file and keeps its session in device-only Keychain storage. The web client uses browser-managed storage for its local data and session. Neither client can read the other's local cache. Pair each installed client separately. The Mac's local study data also remains separate until it has been imported into Centre Cloud.

The cloud record envelope remains canonical across clients. `CloudRecord.version` is the transport compare-and-swap version. Domain `data.revision` is separate. Clients must retain unsynced changes through network failures and report version conflicts for an explicit choice. They must not silently select a winner by timestamp.

## Offline behavior follows the shared record rules

The web app's offline scope covers saved Log data, saved resources, Review items, and saved chat history in its own browser storage. Cached content remains readable without a network connection. Log edits and Review resolutions can be staged locally and synchronized when the app is online. Saving locally does not mean that Centre Cloud has accepted the change.

The Study Log uses the exact `studySession` and `studyGoal` records from Study Log v1. Sessions store UTC time segments. Goals use an IANA time zone and a Monday week start. The timer checkpoints every 15 seconds and uses a 45-second lease. Idle timers pause after 10 minutes. Active timers require a check-in every 60 minutes. Restart, import, or background recovery pauses a timer at its saved checkpoint; a closed app receives no timer credit. Planned calendar time never counts as Log time. These rules come from `shared/study-log.ts` and `shared/study-log-sync.ts`.

Review resolutions use `reviewMemory` cloud records. `resolvedAt` is the stable retry time. The Worker applies linked learning evidence atomically, so a retry does not apply the resolution twice. Marked practice attempts remain immutable. These rules come from `shared/practice.ts` and the central `resolveReview` adapter.

Saved resources and chat history can be read offline. Hosted generation and marking require a network connection. A typed chat message is not an AI request until the Worker accepts it. The web app does not run a local AI model or the Mac's Codex process. Browser sync runs only while the app can execute; this document does not promise background synchronization after Safari suspends or closes the app.

## Hosted AI uses the existing Worker

The web app uses the same authenticated AI routes as the native client. `cloud-ai/index.ts` and `cloud-ai/grade.ts` run after the Worker's central authentication and use the `env.AI` binding. The provider is the fixed `@cf/meta/llama-3.1-8b-instruct-fp8` model. The client cannot select a provider URL or supply a provider secret.

Chat runs use `POST /v1/ai/runs` and `GET /v1/ai/runs/:id`. The Worker builds context from saved cloud messages. Chat admissions are limited to 20 per workspace per UTC day and 120 globally, with 2 per workspace and 16 globally active. Inputs are limited to 8,000 characters plus 20 saved messages bounded to 8,000 history characters. Output is capped at 1,024 tokens.

Grading uses `POST /v1/ai/grades` and `GET /v1/ai/grades/:id`. The shared `validateGradeResult` and `applyGradeEvidence` rules validate and record the result. Grading is limited to 10 admissions per workspace per day and 60 globally, with 2 per workspace and 8 globally active. A grade accepts at most 30 questions and 20,000 quiz and answer characters. Written output is capped at 4,096 tokens. Provider waits end after 45 seconds. Interrupted or expired work does not silently start inference again.

The browser and native clients therefore share the cloud AI provider and admission limits. They do not share local AI execution. Chat and marking are unavailable offline, though previously saved results remain readable.

## Native-only behavior remains separate

The web app does not become a native `.ipa`, use SwiftUI, access native Keychain or Quick Look, or add an Apple signing requirement. This installation path does not create an App Store listing, TestFlight invitation, associated domain, or universal link. Native release setup remains blocked on Xcode, signing, provisioning, and App Store Connect access, as described in [native release setup](release.md).

The native pairing parser in `ios/Sources/CentreCore/CloudModels.swift` validates both `centre://pair` invitations and HTTPS `/pair` links with a fragment code. `ios/CentreApp/CentreApp.swift` asks the user to confirm before sending that code to the Worker. `ios/CentreApp/Views.swift` also lets the user paste a pairing link before connecting. The parser tests live in `ios/Tests/CentreCoreTests/CloudHTTPTests.swift`. The web app needs no native-source change because it opens in Safari and uses the existing cloud records, pairing endpoint, and hosted AI routes.

## Verification limits

The current host has Xcode Command Line Tools but no iOS Simulator. The filtered native pairing-parser test could not launch SwiftPM's generated manifest because macOS returned `Permission denied`. The parser result is unverified, and a passing macOS package test would not verify iOS UI behavior. This work has not exercised Safari installation, Home Screen launch, storage separation, offline recovery, or hosted AI on a physical iPhone. Record a real device or Safari test before describing those behaviors as verified.

## Canonical sources

| Contract | Source |
| --- | --- |
| Study Log records and timer rules | `shared/study-log.ts`, `shared/study-log-sync.ts` |
| Practice marking and learning evidence | `shared/practice.ts`, `cloud-ai/grade.ts` |
| Cloud records, session auth, and one-time pairing | `shared/cloud.ts`, `cloud/worker.ts` |
| Hosted chat and marking | `cloud-ai/index.ts`, `cloud-ai/grade.ts`, `docs/ios/contract.json` |
| Native offline replica | `ios/Sources/CentreCore`, `docs/ios/contract.json` |
