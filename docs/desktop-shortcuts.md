# Desktop icons

In the installed macOS app, open **Settings → Desktop**. Choose **Add icon** beside each action you want on your Desktop.

Centre creates named macOS Internet Location (`.webloc`) files. Each contains one allowlisted `centre://action/…` URL; no scripts are installed. The packaged app declares the `centre` URL scheme.

**Refresh icons** checks files changed in Finder. **Repair** restores a missing icon that Centre owns. **Remove** removes only the selected, unchanged icon. If a file has been changed or replaced, Centre leaves it untouched; move or rename that file in Finder before repairing the original icon.

## Actions

- **Log study** opens the canonical Log manual-entry form.
- **Study timer** focuses the canonical timer controls. It never starts or resumes a session automatically.
- **This week’s study** opens Log at the current week in the selected time zone and focuses its summary.
- **New chat** opens and focuses Centre’s existing fresh-chat composer. The existing send flow creates the saved chat.
- **Search Centre**, **Resources**, **Calendar**, and **Settings** open their existing destinations.

Actions restore or reopen Centre’s window. An open dialog delays the action until you close it, preserving unfinished input. A renderer restart does not replay an already delivered action; click its icon again if the previous window closed before applying it.

## Study Log integration

The study actions require the separate Study Log change. Without it, study icon setup is disabled and direct study URLs report that the feature is unavailable. This PR adds no Log screen or timer state.

The canonical consumer is `StudyLogProvider` in `src/data/useStudyLog.tsx`. Its exported `requestStudyLogAction({id, mode})` sends `centre:study-log-action` with `mode: 'manual' | 'timer' | 'week'`. The desktop dispatcher uses that same event boundary without importing an absent module on main. The provider waits for study data and deduplicates request IDs.

## Verification

Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run build:electron`. Electron builds require the existing Google Desktop OAuth configuration.

Run `node scripts/verify-shortcuts.mjs` after building. The verifier uses temporary profile, data, and Desktop directories. It writes native screenshots and a report under `.runtime`; it does not install files on your Desktop. See the verifier’s options for packaged and Study Log integration runs.

`CENTRE_USER_DATA_DIR` isolates the Electron profile before the single-instance lock. `CENTRE_DESKTOP_DIR` redirects explicitly requested icon operations for verification; development setup is enabled only when both overrides are present. Neither override changes the renderer’s filesystem permissions.

Ownership records and immutable source links live under the Electron profile’s `desktop-launchers` directory. Exclusive hard-link publication requires the profile and Desktop to share a filesystem. Conflicts and corrupt ownership records fail closed. Signing, notarization, and release installation are separate from local unsigned verification.
