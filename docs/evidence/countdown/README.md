# Countdown timer verification

`node scripts/verify-study-log.mjs` runs the production Electron renderer, native IPC and local service against temporary synthetic study data. Google OAuth values are nonfunctional local build fixtures. No live profile or model inference is involved.

The [desktop results](desktop-results.json) record 48 passing checks across the initial flow, restart recovery and countdown completion. Coverage includes the 30-minute default, five-minute controls, minimum duration, optional details, countdown display, pause and resume, failed-start retry, and automatic completion at exactly the target duration. The completion fixture begins with 298 seconds of saved study, then resumes the final two seconds through the UI.

- [Dark theme](countdown-dark.png)
- [Light theme with large text](countdown-light-large.png)
- [Minimum desktop window](countdown-narrow.png)
- [Failed-start recovery](countdown-error.png)
- [Completed countdown](countdown-complete.png)

T3 preview failed twice with `Preview automation snapshot timed out after 15000ms.` Verification used the repository's native Electron workflow.
