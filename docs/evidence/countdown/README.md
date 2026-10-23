# Countdown timer verification

`node scripts/verify-study-log.mjs` runs the production Electron renderer, native IPC and local service against temporary synthetic study data. Google OAuth values are nonfunctional local build fixtures. No live profile or model inference is involved.

The [desktop results](desktop-results.json) record 48 passing checks across the initial flow, restart recovery and countdown completion. Coverage includes the 30-minute default, five-minute controls, minimum duration, optional details, countdown display, pause and resume, failed-start retry, and automatic completion at exactly the target duration. The completion fixture begins with 298 seconds of saved study, then resumes the final two seconds through the UI.

- [Dark theme](countdown-dark.png)
- [Light theme with large text](countdown-light-large.png)
- [Minimum desktop window](countdown-narrow.png)
- [Failed-start recovery](countdown-error.png)
- [Completed countdown](countdown-complete.png)

T3 preview failed twice with `Preview automation snapshot timed out after 15000ms.` Verification used the repository's native Electron workflow.

## iOS counterpart

The native iOS panel uses the same 30-minute default, five-minute increments, optional title, persisted `targetMinutes`, exact completion boundary and recovery rules. Portable tests cover validation, old records, pauses, completion, restart and cloud preservation. Simulator tests also cover the picker and starting without metadata.

The parent rebuilt and ran `CentreCoreVerify` from the combined checkout. All nine runtime checks passed, including countdown completion, pause accounting, cloud recovery, idle and hourly check-in boundaries. The transport responses in this verifier are simulated; persistence and timer rules execute against the real core. See [the actual output](ios-portable.txt).

Full XCTest execution is unverified. `swift test` fails because the selected Command Line Tools cannot resolve `XCTest`. `npm run test:ios` stops because `xcodebuild` requires full Xcode. This host has no iOS simulator, so no final iOS app build or screenshot is available. See [the environment errors](ios-environment.txt). GitHub's simulator job is blocked before execution by the account's payment or spending limit.
