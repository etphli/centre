# Release Centre for macOS

## Download and share Centre

Every push to `main` checks whether four PRs have merged since the latest published release. Once that batch is ready and checks pass, the **macOS release** workflow publishes a GitHub release with two installers:

- `Centre-<version>-arm64.dmg` for Apple Silicon Macs.
- `Centre-<version>-x64.dmg` for Intel Macs.

Download installers from [Releases](https://github.com/etphli/centre/releases/latest). Send the DMG directly to friends. The repository is private, so friends need repository access to use its download links. Sharing a DMG does not require sharing repository access or a GitHub token.

Open the DMG and drag Centre into Applications. Builds are unsigned until Apple credentials are configured. macOS may require approval in **System Settings > Privacy & Security > Open Anyway** after the first launch attempt. Replace unsigned installations by downloading a newer DMG.

Each person keeps their own study data and credentials on their Mac. AI features require the Codex CLI and their own login. Organato sync requires their own Organato API key. Google sign-in uses the app's bundled Desktop OAuth client and remains subject to that client's Google consent-screen audience.

## Automatic releases

The workflow counts distinct PRs merged into `main` after the latest release tag, using the commits included in the build. Merge commits, squash merges, and rebase merges count. Direct pushes do not count as PRs. The first three PRs wait; the fourth triggers a release containing the whole batch. A failed release leaves the batch pending for the next run. Before the first release, the count starts at the beginning of the repository.

When a release is due, the workflow checks types, runs tests, builds the renderer and Electron process, and verifies text-size controls in the running app before packaging both architectures. It publishes the release immediately, rather than leaving a draft. Desktop checks still run on every push and PR.

Versions use the major and minor from `package.json`, with its patch plus the GitHub workflow run number. For example, base `0.1.0` and run 12 produce `0.1.12`. Skipped batches can leave gaps in version numbers. The workflow changes the version only in its build checkout. Keep the base version stable within a release series; increase its major or minor for a new series.

The workflow also supports **Run workflow** on `main` to retry a pending batch. Manual runs use the same four-PR check. Once a release publishes, its PRs no longer count toward the next batch. Release jobs run serially so an older build cannot replace a newer release as latest.

Required repository secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

The build validates these and packages the app-owned Desktop OAuth config. Never commit the OAuth values or source JSON.

## Enable signed releases

Add all five Apple credentials as repository secrets:

- `CSC_LINK` and `CSC_KEY_PASSWORD` for the Developer ID Application certificate.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for notarization.

The workflow automatically signs and notarizes when all five exist. Partial configuration fails rather than silently publishing an unsigned build. Without Apple credentials it publishes unsigned DMGs. Signed releases also include ZIPs and update metadata. Keep the signing identity consistent between releases.

Automatic updates require a signed app. In Settings, save a GitHub token with read access to the private repository, then click **Check for updates**. Centre stores the token in macOS Keychain. Each user supplies their own token; Centre does not bundle one. After downloading, click **Restart and install**.

Signing, notarization, and automatic installation need Apple credentials and a signed release before they can be verified.

## Build locally

Run `npm run package:mac` on macOS. Provide both Google OAuth environment variables or save Google's installed-app OAuth JSON as `.runtime/google-oauth-source.json`. The app, DMG, and ZIP appear in `release/`. Local builds do not publish releases.

To verify text sizing after building the renderer and Electron process, run `node scripts/verify-text-size.mjs`. It clicks each size, checks computed font sizes in settings, navigation, messages, Markdown and the composer, restores Default, then verifies Large persists after reload. Screenshots appear in `.runtime/text-size-*.png`.
