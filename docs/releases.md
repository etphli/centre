# Release Centre for macOS

## Build a local copy

Run `npm run package:mac` on macOS. Before building, provide both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or save Google's installed-app OAuth JSON as `.runtime/google-oauth-source.json`. The build validates the config and packages it with the app. Do not commit the JSON file or the OAuth values.

The app, DMG, and ZIP appear in `release/`. Local builds are unsigned and do not install automatic updates.

## Publish a signed release

Add the Apple signing and notarization secrets to the repository's `release` environment:

- `CSC_LINK` and `CSC_KEY_PASSWORD` for the Developer ID Application certificate.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for notarization.

Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as repository secrets. The desktop checks and release workflow use them to build the app-owned Desktop OAuth config.

The **Signed macOS release** workflow stops if any required secret is missing. Set a new version in `package.json` and update the lockfile, then run the workflow. It checks types, runs tests, builds the renderer and Electron process, signs and notarizes the app, and uploads a draft release to `etphli/centre`.

The release includes a DMG, ZIP, and update metadata. Automatic updates require a signed release and its ZIP metadata. Keep the application's signing identity consistent between releases.

## Download private releases

In the installed app's Settings, save a GitHub token with read access to the private repository. Centre stores the token in macOS Keychain. Each user supplies their own token; the app does not include one.

Click **Check for updates**. After a download completes, click **Restart and install**. Settings reports a missing token, missing signed release, or download failure.

Apple signing credentials and a first signed release must exist before automatic installation can be verified. An unsigned local build cannot verify that flow.
