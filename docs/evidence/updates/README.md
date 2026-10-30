# Public desktop updates

Verified on 31 October 2026. The repository is public. An unsigned Electron fixture at version 0.1.0 used the real unauthenticated GitHub API to find Centre 0.1.20 and select its arm64 DMG. The public DMG returned HTTP 200 to a HEAD request.

Before the fix, `createUpdater().check()` returned `unavailable` before contacting GitHub. Afterward it returned `available` with the correct public download URL. No GitHub token was supplied. Unit tests also use a local upstream fixture to verify both architectures, version comparison, GitHub rate limiting and rejection of an unexpected installer origin.

`npm test`: 483 passed. Type checking, desktop/iPhone web production builds and the Electron build passed. `npx tsx scripts/verify-updates.mjs`: eight UI checks passed. The verifier uses isolated data, intercepts external opening to check the actual DMG URL, and simulates ready/downloading/error IPC statuses. It does not claim that a signed automatic installation occurred. Signed download/restart remains unverified because current public releases have no ZIP/manifest and no Developer ID signing credentials were used.

- [Available update in the sidebar](update-available-light.png)
- [Settings in dark mode](updates-settings-dark.png)
- [Settings at narrow desktop width](updates-settings-narrow.png)
- [Simulated download progress](update-progress.png)
- [Retry after a simulated network error](update-error-retry.png)
- [UI report](report.json)

The iOS parity audit found a specific platform-only difference. Native iOS uses Apple distribution; the iPhone web app already offers Review update and Update and reload with work preservation. Neither downloads macOS DMGs. No iOS update changes were required.

GPT-6.1 Sol authored the updater, UI, tests and local-install work. GPT-6 Luna audited iOS parity and authored no code for this updater task.

The unsigned Apple Silicon local bundle was built as `0.1.20-local.20261031.1`. Its bundled renderer assets, package version, public updater and notification ingestion were checked. An actual packaged-app run with isolated data passed its public release check, declined a downgrade to 0.1.20 and displayed the Notifications category. See [packaged-app screenshot](packaged-local-build.png) and [report](packaged-report.json).

The app was installed at `~/Applications/Centre.app`, matching the tested package by SHA-256. The previous app was moved into `~/Applications/.centre-backups/20261031-090047/`, and the closed profile snapshot was backed up under Centre's `backups/pre-update-20261031-090047.json`. The data file was unchanged during replacement. After launch, all previous resource, chat, assignment and topic IDs remained present. The updated app was launched with the existing profile. No GitHub release, push or deployment was performed.

Follow-up: the sidebar prompt is now conditional. It renders only for an available, downloading or ready update. Initial loading, checking, current-version and error states stay out of the sidebar; manual checks and recovery remain in Settings. The independent iPhone web updater already waits for a waiting service worker before displaying a prompt, so no mobile change was needed.

The conditional-prompt follow-up passed the production build, the eight updated UI checks and the packaged-app smoke check. The local installation was replaced and reopened as `0.1.20-local.20261031.2`, with a fresh app/data backup and all previous study record IDs preserved. The packaged check explicitly confirms that a current build has no sidebar prompt.
