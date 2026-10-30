# Assignment notifications

Desktop verification on 31 October 2026 used an isolated synthetic Science resource in an unsigned Electron build. `npx tsx scripts/verify-notifications.mjs` checks the Notifications category, opening the saved reader, keyboard focus, and captures light, dark and the minimum supported desktop width. The Codex-unavailable banner is intentional in the UI fixture.

- [Library in light mode](library-light.png)
- [Reader in light mode](reader-light.png)
- [Reader in dark mode](reader-dark.png)
- [Reader at narrow desktop width](reader-narrow.png)
- [UI checks](report.json)

`npm test` passed 478 tests. The final targeted `npx tsx --test server/organato-notifications.test.ts` passed both tests, including an additional chat prompt/reader-reference check using a simulated Codex response. Production desktop and iPhone web builds passed. Type checking and `git diff --check` passed.

A separate read-only live check used Centre's saved Organato key with temporary local storage, leaving the installed profile unchanged. It imported eight brief attachments from 13 work records, with seven readable document bodies. One formula-sheet DOCX has no extractable text and produces an explicit sync warning. Original file bytes, credentials and live student content are excluded from these committed fixtures.

Notifications retain readable text for offline use. PDF/DOCX formatting and embedded images are not reproduced. OCR and binary document sync are not implemented.

The combined mobile/hosted-chat tests passed 54 checks. Mobile web uses the shared resource schema after integration; no fallback schema remains. Hosted chat loads cached source content separately from the saved student message and excludes deleted resources. Native and web chat references open saved readers.

The device inventory returned no iOS devices, so native simulator UI execution and screenshots remain unverified. Initial import/extraction runs on macOS. Phone readers receive the portable text through optional Centre cloud sync.

Code authors: GPT-6.1 Sol authored the desktop/shared changes and integration corrections. GPT-6 Luna authored the initial native iOS and iPhone web parity implementation.

The combined portable iOS suite ran 102 tests: 101 passed, with one existing clock-dependent countdown failure in `testCountdownValidationAndCanonicalEncoding`, reporting "Actual study cannot be in the future." This is outside notification handling. The final focused mobile/hosted-chat/desktop notification run passed 31 tests.

Final combined verification also passed:

- `npm run typecheck`.
- `npm run build` and a final `npm run build:iphone` after the mobile chat integration corrections.
- The final focused run of `server/organato-notifications.test.ts`, `mobile-web/notifications.test.ts` and `scripts/cloud-ai.test.mjs`: 31 passed.
- `swift test --disable-sandbox --scratch-path .runtime/swift-build --package-path ios --filter NotificationResourcesTests`: 2 passed.
- `TMPDIR="$PWD/.runtime/swift-tmp" xcodebuild build-for-testing -project ios/Centre.xcodeproj -scheme Centre -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath .runtime/ios-build CODE_SIGNING_ALLOWED=NO`: `TEST BUILD SUCCEEDED`. This compiles the app and UI-test bundle but does not execute the simulator UI tests.

The workspace-local temporary directory avoided an initial package-manifest execution permission failure in the system temporary directory. No app was installed, and neither desktop nor hosted changes were deployed.

Release preparation corrected the previously failing countdown fixture: its manual interval now ends at the injected clock instead of one minute in the future. The complete portable suite then passed all 102 tests. The verification executable's `@main` entry point was also renamed from `main.swift` to `CentreCoreVerification.swift` for the CI Swift toolchain, which otherwise treated the filename as a top-level entry point. This changes no production study rules.

CI run 41136874568 executed the native UI flow and opened the notification's cached text successfully. [Native reader evidence](ios-reader-ci.png) is a frame extracted at 54 seconds from that test's recorded CI video, using synthetic fixture data. The overall simulator suite failed later: the Calendar assertion did not scroll to its row, older history checks used stale labels, and keyboard/scroll accessibility needed correction. The release branch now adds a composer keyboard-dismiss button, preserves individual saved-answer/outcome accessibility children, and corrects the UI test navigation/selectors without relaxing the data assertions. The corrected simulator suite must pass before merge.

CI run 41140860500 passed 17 of 19 native UI tests, including the notification category, cached reader, linked Calendar assignment, deleted-resource history, large-text controls, and returning to a chat after rapid input. Two failures remained: the history test expected a bare value while iOS exposed its field label too, and a new-chat draft contained missing characters. The next revision accepts the exact saved value with or without its accessibility field label and asserts prompt text immediately after typing, before navigation or saving. The composer bridge now replaces UIKit text only when its bound value changes, preserving provisional keyboard edits during unrelated SwiftUI refreshes, and avoids resetting an unchanged font. This addresses a suspected input-refresh cause; the CI rerun must verify it. The portable 102-test suite and unsigned simulator app/UI-test bundle build pass locally. Local simulator execution remains unavailable because CoreSimulator 1174.9.2 is older than Xcode's required 1174.21.0.
