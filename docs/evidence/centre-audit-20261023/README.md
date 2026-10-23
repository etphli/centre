# Centre audit — 23 October 2026

Implemented and locally verified audit fixes and expanded Settings. The audit was integrated onto main after explicit push authorization. No local installation or cloud deployment was performed. Pre-existing assignment/attachment work was preserved and is not attributed to this audit.

## User-visible changes

- Settings: ten new portable preferences, Extra large text, explicit Standard reset, Appearance/Chat categories, reading preview, and reset limited to preferences. Font, width, line spacing, motion, contrast, send shortcut, activity disclosure, greeting and flashcard defaults have actual consumers.
- Settings reliability: serialized saves preserve newer choices; failed disk writes leave settings unchanged; older preference payloads retain omitted values. Model-effort failures restore the saved choice; Cancel requests backend sign-in cancellation; failed credential forms retain drafts. Test duration accepts the canonical integer range, including 7 minutes.
- UI: readable light-theme hover and muted text, visible composer focus, consistent keyboard order, flashcard Space activation, stable search during replies, Log navigation, preserved modal drafts, and explicit clarification cancellation. Cancelling resource preparation no longer sends a later generation request. Cancelled exports no longer claim success.
- Recovery: guided resource retries preserve choices across restart, block connected actions, deduplicate saves and recover committed resources even when the model catalog is offline. Private execution metadata stays local. Hosted grading preserves prepared results after lost acknowledgements.
- Sync/calendar: foreground/background admission budgets, verified-device caching and idle retry backoff; canonical archive tombstones prevent calendar resurrection; imported durations stay accurate.
- iOS: stale edit protection, calendar validation/recovery, archived Review filtering, auth-origin consistency, timer-version preservation and note ownership validation. Canonical preferences and atomic field updates preserve offline edits; Settings inherits text scaling. Reading/accessibility and hardware-send settings were implemented.

The reported historical text-size failure did not reproduce during normal fixture clicks. A real overlapping-save race that can revert text size was reproduced and fixed. Sizes now measured 14/16/18/20px at the root, with chat/resource text scaling and reload persistence verified.

## Verification

- Full Node test suite: **467 passed, zero failures/skips**; recorded in the local audit evidence. The last renderer-only fixes additionally passed 25 controlled real-component checks.
- Final TypeScript check, Vite production build, isolated Electron main/preload bundles, and git diff --check passed. Vite retains its large-chunk warning. Electron bundles are unsigned build checks, not a distribution.
- Cloud deployment dry-run passed; no deployment occurred.
- Original UI sweep: 84 rendered view checks across three themes/sizes. Settings: 50 saved values, 12 theme/page layout checks plus narrow-window check, keyboard, reload, reset, failures and recovery. These use disposable fixtures and simulated upstream responses.
- Native Electron: 69 shortcut checks; export bridge checks used simulated OS panel responses and actual temporary file writes.
- Integrated iOS CentreCoreVerify executable checks and app/test syntax parsing passed. XCTest and simulator execution were unavailable.

## Limits and release dependencies

This is not proof that every button and every line works in production. The local coverage ledger maps the original 570-file inventory using full reads, hash checks, skims and existence checks; 426 renderer action templates and 119 iOS controls were inventoried, not all clicked. Backend r3 subsequently read the remaining local skill bodies; Astra UI r3 read the ten vendor skill bodies. Licenses/source locks retain hash-level review; planning HTML retains skim-level review.

Full Xcode, native iOS build/UI/IME, VoiceOver, forced colors, actual OS reduced-motion/theme changes, live OAuth/providers/connectors, native Save panels/PDF toolchain, clipboard, signed updates and production sync remain unverified. Some iPhone settings explicitly apply on Mac because native guided creation, activity disclosure and home greeting do not exist. Native width/spacing follow phone layout. Foundation and Intl timezone alias/offset acceptance still differs; named zones are offered on iPhone and imported records are retained.

The new portable fields require matching cloud validators before distributing clients. Older deployed strict validators reject them. No production rollout was authorized. Keychain and state.json are separate systems: a credential write can succeed before a later disk failure. Stop requests cancellation; a resource save already in progress may finish and remain in Resources.

Pinned vendor skills reference optional support files not shipped in the reduced bundle. Runtime tools limit their execution, but complete upstream workflows were not established.

## Authorship and evidence

GPT-6.1 Sol medium authored backend, native Electron, generation-cancellation, settings interaction and iOS fixes. GPT-6 Astra medium authored renderer/settings changes and parent recovery/calendar/hosted-grading fixes. Claude Opus 5.5 medium supplied design review, fixtures and sweeps; Astra resumed after Claude usage limits. Existing unrelated dirty changes are excluded from these author attributions.

Detailed reports, logs and the coverage ledger remain in the original workspace and /tmp/centre-audit-20261023; they are excluded from this commit to keep it reviewable. Screenshots are real rendered fixture states, not mockups. The final visual is visual.html.

## Main integration

Integrated onto origin/main a0c2908, retaining the seven intervening commits including draft persistence, iPhone installation/continuity, timers and attempt comparisons. Unrelated pre-existing assignment evidence was excluded. The combined 467-test suite, typecheck, desktop/iPhone web production builds, Electron build with fixture OAuth credentials, real Electron four-size/reset/reload checks and iOS portable executable passed. Native XCTest/simulator remain unavailable. Detailed scratch reports/logs were kept out of the commit.
