# iPhone release setup

No deployment, production migration, signed public archive, or TestFlight/App Store upload has been performed. Those actions require the user's later green light.

## Build configuration

Install Xcode with an iOS simulator runtime and XcodeGen. Generate `ios/Centre.xcodeproj` with:

```sh
xcodegen generate --spec ios/project.yml
```

`project.yml` owns the generated plist properties. Keep launch-screen, account URL schemes, and Google keys there so regeneration cannot erase them. The UI tests reject 320×480 compatibility mode.

Create ignored `ios/Config.local.xcconfig` with these public settings:

```text
CENTRE_CLOUD_URL = https:/$()/your-approved-centre-worker.example
GOOGLE_IOS_CLIENT_ID = your-iOS-client-ID
GOOGLE_SERVER_CLIENT_ID = your-verified-server-client-ID
GOOGLE_REVERSED_CLIENT_ID = your-reversed-iOS-client-ID
DEVELOPMENT_TEAM = your-Apple-team-ID
```

The `$()` prevents xcconfig from treating `//` as a comment. Replace the example host with the real approved Centre endpoint. Do not put tokens, provider keys, OAuth client secrets, or Organato keys in this file.

Register the `app.centre.ios` bundle identifier or change it deliberately in `project.yml`. Configure the matching iOS Google client and reversed callback scheme. Set the server audience and allowed Google subjects in the Centre Worker. The app forwards a short-lived ID token directly to that configured service, then stores only Centre's device session in device-only Keychain storage.

## Cloud prerequisites

The database owner must integrate the central Worker and entity adapters. The calendar owner supplies `cloud-organato`. The iOS owner supplies `cloud-ai`. Apply all migrations only to an isolated local D1 during review.

After deployment approval:

1. Create Centre's own D1 database and bind it as `DB`. Do not bind Organato's physical database.
2. Configure the central Google audience and server subject allowlist. Do not open access by email supplied in a request.
3. Mount both authenticated extensions and their migrations in the central entry point.
4. Add `"ai": {"binding":"AI"}` to that Worker's Wrangler configuration. Use Workers Free without paid overage or gateway credits.
5. Configure the Organato origin allowlist, versioned AES-GCM encryption key, and active key version as server secrets. Provision the account's connector key explicitly in app settings.
6. Verify real sign-in, pairing/revocation, sync, attachments, calendar reconciliation, and a real model reply in an approved development environment with the desktop service stopped.
7. Inspect Cloudflare account usage and validate quota/unconfigured states. Local inference fixtures do not satisfy this step.

Cloudflare access is needed to create bindings, set secrets, deploy, and use an approved development service. A provider secret is not needed in the mobile client. If the agent needs a secret, supply it through the private `request_secret` tool, never chat or a committed file.

## Apple installation

[TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/) requires a signed uploaded build associated with an App Store Connect application. External invitations can require beta review. Builds expire after 90 days. An arbitrary IPA download is not a general iPhone installation method.

The app target and unsigned Release build are prepared. Remaining distribution setup is:

- An Apple Developer Program team with signing/provisioning access and an App Store Connect application.
- Actual iOS Google client settings and approved Centre Cloud configuration.
- Review metadata, a real privacy-policy URL, export-compliance answers, age rating, and access for Apple's reviewers.
- A decision on the applicable [login-service requirements](https://developer.apple.com/app-store/review/guidelines/#login-services). This private allowlisted app does not assume a Google-only public release is exempt from guideline 4.8. Resolve that before external submission.
- A reviewed privacy declaration matching the final deployed storage and AI provider. The included manifest declares user content, user identifiers, and container-file timestamp access. Google SDK manifests remain part of the archive.
- A signed archive, validation, upload, beta approval if required, and a real approved invitation. All upload/release steps remain behind approval.

`ios/ExportOptions.plist` uses App Store Connect export without an automatic upload. It is not a signing identity or a release permission.

Once an approved invitation or listing exists, set `VITE_CENTRE_IOS_DISTRIBUTION_URL` during the desktop build. Only validated Apple TestFlight `/join/<code>` or App Store `/app/.../id...` links generate the installation QR. An empty or invalid setting shows that no iPhone release is available. Account pairing remains a separate one-use flow and never embeds a long-lived bearer token.
