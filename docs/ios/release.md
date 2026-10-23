# Native iPhone release setup

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

## Safari Home Screen installation

The Centre Worker serves the browser app at `https://centre-cloud.etphli.workers.dev/iphone/`. The public iPhone QR in Mac Settings points to this address. It contains no account code, session token, or other account authority. This browser app does not need a native build, Apple signing, TestFlight, or an App Store listing.

To install it, open the public iPhone address in Safari on the iPhone, tap **Share**, choose **Add to Home Screen**, and add Centre. Open Centre from the Home Screen before pairing. Safari tabs and Home Screen apps may keep separate local storage. Pairing before installation can leave the installed app signed out.

To connect the installed app, create a fresh account code in Mac Settings. Scan its separate account QR with the iPhone. The `/pair` page offers **Copy account code** and **Open web app**. Open Centre, paste the code, and confirm the connection there. The page does not redeem a code when it loads. A code expires after five minutes and can be used once. Create a new code if it expires or was redeemed in another browser context.

The web app reads and writes the same Centre Cloud records in D1 and uses the existing hosted AI routes. Its offline and sync scope is limited to the browser features described in [iPhone web installation and native parity](web-installation-parity.md). Its browser storage remains separate from the native app's replica and Keychain.

The local host has Command Line Tools but no iOS Simulator. This work has not verified the Safari installation flow, Home Screen storage behavior, or installed-app launch on a physical iPhone. Do not treat the steps above as device-tested evidence.

## Native Apple distribution

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

Native account QR codes use `https://<Centre Cloud origin>/pair#code=<one-time-code>` so the iPhone camera can open a normal web page. The fragment is not sent in the HTTP request. The page clears it from the address bar. **Open Centre** passes the invitation to `centre://pair`; native Centre asks for confirmation before redeeming it. Native Centre also accepts the HTTPS link through **Paste pairing link**. This is a web handoff, not a registered Apple universal link. For the browser app, use **Copy account code** and **Open web app**, then paste and confirm inside Centre.

The public browser app at `/iphone/` is separate from native distribution. The desktop `VITE_CENTRE_IOS_DISTRIBUTION_URL` and Worker `CENTRE_IOS_DISTRIBUTION_URL` accept validated Apple links for the native app only. Opening `/pair` never creates a device session or consumes the pairing code. Explicit code submission from an app uses `POST /v1/auth/pair`.
