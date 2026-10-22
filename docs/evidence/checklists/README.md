# Checklist verification evidence

The screenshots show the real Centre app at the isolated local fixture on port 5186. Native checkbox changes passed through the generated iframe, trusted relay, React parent, authenticated local service and atomic disk store. A fresh browser session after service restart restored the checked items. The fixture has no real account data or model credentials.

| Finding | Fix commit | Corrected evidence |
| --- | --- | --- |
| Network/navigation P1 | `9fcf6bd` | `electron-sandbox-report.json`, `independent-recovery-review.json`, `navigation-recovered.png` |
| CHECK-1 and X-2 | `f1d45e0` | `keyboard-focus.png`, `resource-light-large.png`, `forced-colors.png` |
| CHECK-2 | `b38b404` | `aligned-saved.png`, `saved-dismissed.png`, `persistent-error.png`, `control-review.json` |
| Reload and navigation | `9fcf6bd` | `restart-restored.png`, `navigation-restored.png`, `browser-result.json` |

The independent Sol review ran the actual React frame and service/storage chain in Electron 44.9.1. All 23 attacks executed in loaded generated HTML. All 19 unrestricted HTTP positive controls reached the canary. Attack HTTP requests and invalid-message saves were zero. Four self-navigation attempts recovered to loaded `about:srcdoc` checklists with visible controls and working saves. Ten supplemental Electron/Chromium probes covered immediate, microtask, load-time and timer navigation, genuinely pending saves, escaped label markup and absence of reset/replay loops. The reports include source hashes and explicit counters.

Run the committed probes with an installed Playwright module:

```sh
CENTRE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CENTRE_SANDBOX_ENGINE=electron node --import tsx scripts/verify-checklist-sandbox.mjs
CENTRE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CENTRE_SANDBOX_ENGINE=electron PROBE_MODE=pending node --import tsx scripts/verify-checklist-recovery.mjs
```

The recovery probe supports `immediate`, `microtask`, `load`, `timer` and `pending`. For Chromium, omit `CENTRE_SANDBOX_ENGINE` and set `CENTRE_CHROMIUM_EXECUTABLE` if needed. Both scripts create isolated fixtures and preserve screenshots/reports in temporary directories.

`control-review.json` records actual keyboard focus, neutral custom appearance, forced-color fallback, status indentation, the two-second Saved removal, and persistent error/Retry after a real disk write failure. `t3-preview-fallback.txt` preserves the two exact collaborative browser disconnect errors that required Playwright fallback.

Local verification passed 44 focused tests, TypeScript, and the real browser checks. A local production build was not run under the user's saturated-host restriction. iOS, hosted D1 integration and deployment were not verified here. No new Claude worker was created for the corrected captures; the owner rechecked the UI and the independent Sol verifier checked controls and navigation behavior. These limits remain explicit for final program review.
