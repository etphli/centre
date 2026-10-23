# iPhone release setup

The Centre Worker is deployed at `https://centre-cloud.etphli.workers.dev` with Centre-owned D1 database `16c45b97-0c59-4293-9c79-e1f1aa0ef081`, four migrations, `DB` and Workers AI bindings, and the Free plan. Google subject/audience and connector encryption/origin secrets are configured server-side. No signing, archive, App Store Connect upload, or TestFlight invitation has been completed. The user has authorized Apple upload, but the available host has no full Xcode/iOS simulator, signing identity or provisioning profile, Apple team configuration, or App Store Connect authentication. No membership purchase, enrollment fee, billing change, or spending-limit change was made.

## Build configuration

Install Xcode with an iOS simulator runtime and XcodeGen. Generate `ios/Centre.xcodeproj` with:

```sh
xcodegen generate --spec ios/project.yml
```

`project.yml` owns the generated plist properties. Keep launch-screen, account URL schemes, and Google keys there so regeneration cannot erase them. The UI tests reject 320×480 compatibility mode.

The tracked `ios/Config.xcconfig` sets the deployed Worker URL by default. It includes the optional ignored `ios/Config.local.xcconfig` afterward, so local settings can override defaults without changing tracked deployment configuration. Use this file for per-build public settings:

```text
GOOGLE_IOS_CLIENT_ID = your-iOS-client-ID
GOOGLE_SERVER_CLIENT_ID = your-verified-server-client-ID
GOOGLE_REVERSED_CLIENT_ID = your-reversed-iOS-client-ID
DEVELOPMENT_TEAM = your-Apple-team-ID
```

The Worker URL uses `https:/$()/` so xcconfig does not treat `//` as a comment. The iOS client ID must belong to a dedicated iOS OAuth client; do not reuse the desktop OAuth client. Keep the Google IDs and Apple team unset until the actual iOS client and an existing signing team are available. Do not put tokens, provider keys, OAuth client secrets, or Organato keys in this file.

Register the `app.centre.ios` bundle identifier or change it deliberately in `project.yml`. Configure the matching iOS Google client and reversed callback scheme. Set the server audience and allowed Google subjects in the Centre Worker. The app forwards a short-lived ID token directly to that configured service, then stores only Centre's device session in device-only Keychain storage.

## Cloud deployment inputs

The deployed endpoint is `https://centre-cloud.etphli.workers.dev`. It uses Centre's own D1 database (`16c45b97-0c59-4293-9c79-e1f1aa0ef081`), with four migrations and `DB` plus Workers AI (`AI`) bindings. The account is on Workers Free. The central Google audience and subject allowlist, Organato origin allowlist, and versioned connector encryption key are configured as server-side secrets. Do not copy those secret values into the app or repository.

The mobile build needs the public Worker URL and a dedicated iOS Google OAuth client ID, verified server client ID, and reversed callback scheme. The Worker URL is already the tracked default; `Config.local.xcconfig` can override it for local builds. Real remote API and provider smoke checks are separate from the native signing checks and must pass before calling the end-to-end release ready.

## Apple installation

[TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/) requires a signed uploaded build associated with an App Store Connect application. External invitations can require beta review. Builds expire after 90 days. An arbitrary IPA download is not a general iPhone installation method.

The app target and unsigned Release build are prepared. Remaining distribution setup is:

- An existing Apple Developer Program team with signing/provisioning access and an App Store Connect application. No team or Apple credentials are configured on the available host.
- A dedicated iOS Google client ID, verified server client ID, and reversed callback scheme. Desktop OAuth credentials are not valid substitutes.
- Review metadata, a real privacy-policy URL, export-compliance answers, age rating, and access for Apple's reviewers.
- A decision on the applicable [login-service requirements](https://developer.apple.com/app-store/review/guidelines/#login-services). This private allowlisted app does not assume a Google-only public release is exempt from guideline 4.8. Resolve that before external submission.
- A reviewed privacy declaration matching the final deployed storage and AI provider. The included manifest declares user content, user identifiers, and container-file timestamp access. Google SDK manifests remain part of the archive.
- A signed archive, validation, upload, beta approval if required, and a real invitation. Apple upload is authorized, but blocked until a host with Xcode and usable signing/App Store Connect access is available. No TestFlight link is configured or published.

`ios/ExportOptions.plist` uses App Store Connect export without an automatic upload. It is not a signing identity or a release permission.

Once an approved invitation or listing exists, set `VITE_CENTRE_IOS_DISTRIBUTION_URL` during the desktop build. Only validated Apple TestFlight `/join/<code>` or App Store `/app/.../id...` links generate the installation QR. An empty or invalid setting shows that no iPhone release is available. Account pairing remains a separate one-use flow and never embeds a long-lived bearer token.

Account QR codes use `https://<Centre Cloud origin>/pair#code=<one-time-code>` so the iPhone camera can open a normal web page. The fragment is not sent in the HTTP request. The page clears it from the address bar, then opens the existing `centre://pair` invitation only after **Open Centre** is tapped. Native Centre asks for confirmation before redeeming it. iOS also accepts the HTTPS link through **Paste pairing link**. This is a web handoff, not a registered Apple universal link.

The public Worker page shows installation availability separately. When Apple distribution exists, set the Worker's `CENTRE_IOS_DISTRIBUTION_URL` to the same validated Apple link used by the desktop build. Leave both values unset until an actual invitation or listing is ready. Opening `/pair` never creates a device session or consumes the pairing code.
