# Attempt comparison verification

All desktop captures use synthetic attempts in an isolated local profile, the production renderer, and real Electron IPC. No personal account, production data or live AI inference was used.

- [Score history](desktop-dark.png), [saved answers and feedback](desktop-answers.png), [light theme and large text](desktop-light-large.png), [760px viewport](desktop-narrow.png), [keyboard focus](desktop-keyboard.png), and [archived resource after restart](desktop-restart-archived.png).
- [Initial checks](desktop-initial.json) and [restart checks](desktop-restart.json) contain the exact passing assertions and empty renderer-error lists.
- Base includes iOS PR #13, merge `9d7ef1f`, and countdown PR #27, merge `f3fa603`. Only this feature branch was rebased; no main branch change or deployment was performed.

## Checks

- `npm run typecheck` passed.
- `npm test` passed, 418 tests on the countdown base.
- Focused domain/service/sync run passed 35 tests, including changed question sets and marks, unanswered questions, repeated mistakes, deterministic ties, sparse data, archive/restore, offline restart and workspace isolation through the local D1-backed Worker harness.
- `npm run build` and `npm run build:electron` passed. Electron used a nonfunctional local OAuth fixture. Vite reports its existing large-chunk advisory.
- `node scripts/verify-attempt-comparison.mjs` passed 17 checks. It asserts unchanged saved attempts on disk and after restart, actual rendered theme/text size, keyboard operation, resource links, count/score caveats and the Study time shortcut.
- `node scripts/verify-study-log.mjs` passed 48 checks across initial, restart and countdown-completion runs, including the existing timer, manual entries, weekly goals and countdown behavior.

The cloud tests run the real Worker and local SQLite-backed D1 adapter with synthetic identities. Hosted production synchronization and live grader quality were not tested.

## Native verification limitation

The local device service returned no iOS devices. `device_open` returned `No ios devices were found on host local`. The selected developer directory is `/Library/Developer/CommandLineTools`; `xcrun simctl` is unavailable and `xcodebuild -version` requires full Xcode. No Xcode application was found locally. Native simulator UI, unsigned iOS build and iOS screenshots therefore require the repository's iOS CI workflow or a machine with full Xcode. Existing screenshots from earlier features are not evidence for this change.
