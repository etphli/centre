# Install Centre on an iPhone

Open **Settings > iPhone** in Centre on your Mac and scan the installation QR. It opens [Centre for iPhone](https://centre-cloud.etphli.workers.dev/iphone/) in Safari. Choose **Share > Add to Home Screen**, enable **Open as Web App** if Safari shows that option, and tap **Add**. Open Centre from its new Home Screen icon before connecting your account.

On the Mac, sign in to Centre Cloud and create a private account code in the same settings section. Scan that account QR, copy its code, then paste it into the installed Home Screen app. Codes expire after five minutes and work once. The installation QR is public and contains no account access. Safari and the installed web app can keep separate account storage, so install first and connect inside the app.

This is a Home Screen web app. It does not require a native Apple download or an Apple Developer subscription. The separate SwiftUI app still needs Xcode, signing and distribution setup before it can be downloaded through TestFlight or the App Store.

## Available study tools

- **Log:** weekly chart and aims, completed study entry, a foreground countdown timer, saved sessions and quiz history. Countdown minutes and measured UTC segments use the same portable rules as macOS and native iOS.
- **Resources:** search saved titles and note text, read notes and flashcards, save unfinished quiz answers, request cloud marking and inspect immutable attempts. Generated HTML uses a static reading view. Checklists retain their canonical item IDs and progress; generated scripts, remote images and custom animations do not execute.
- **Review:** read due items and resolve them offline. The Worker applies linked learning evidence when resolutions sync.
- **Chat:** saved conversations, durable unsent text and explicit Centre Cloud AI replies. Sending commits the message, request identity and cleared composer together. Lost responses are checked with the same request ID.
- **Calendar:** saved Centre plans and a refresh of connected Organato dates and assignments. Editing plans and viewing chat attachments remain available in the desktop and native clients.
- **Settings:** shared theme and text size, connection status, explicit conflict choices and disconnect. A disconnected account's cache is hidden; reconnecting another account never imports it.

Import and enable cloud sync on the Mac to make existing local study data available. The web app talks directly to Centre Cloud while the laptop is closed. Written marking and AI replies require the internet and the server's configured allowance. They do not use the Mac's Codex credentials.

## Offline and timer behavior

The service worker caches only the public files under `/iphone/`. API responses, bearer tokens and account codes never enter Cache Storage. A separate IndexedDB replica holds the browser's account access, saved records, offline queue and private request journals. Clearing website data removes that local copy; sync important work first.

Edits and their queued mutations commit atomically before networking. Never-sent edits to one record coalesce; a sent mutation retains its exact ID and body for replay. Transport CAS versions remain separate from domain revisions. Conflicting edits require a choice. Old screens and requests are bound to their original workspace, including during account switching.

Keep Centre open while using its timer. Leaving the app pauses it where the browser allows the visibility event to finish. An interrupted or closed app recovers paused at its last 15-second checkpoint. It never assumes that time spent with a suspended app was study time. Idle and hourly check-in limits, countdown completion and imported-running recovery use `shared/study-log.ts`. A browser without Web Locks can still log completed study but cannot start a timer.

## Develop and verify

```sh
npm run dev:iphone
npm run typecheck
npm test
npm run build
npm run cloud:build
```

The development client is at `http://127.0.0.1:5318/iphone/`. Production assets are built into `dist-iphone/iphone/` and served by the existing Centre Worker through its `ASSETS` binding. No database migration is added by this feature.

The browser verifier starts its own disposable localhost fixture with the real Worker router, authenticated record store, SQLite transactions and central grading. Google identity and inference are explicitly simulated. Provide an existing Playwright Core installation:

```sh
CENTRE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core node scripts/verify-iphone.mjs
```

The verifier checks real IndexedDB writes and reloads, offline service-worker launch, quiz/checklist/review progress, post-commit lost responses, terminal grading recovery, timer ownership, light/large layouts, account isolation and static-only caches. Its temporary browser and server are closed on completion. `scripts/iphone-fixture.ts` can also run separately for manual inspection; it binds only to loopback and must never be deployed.

## Verification boundary

See [the evidence](evidence/iphone-web/README.md) for exact results and screenshots. Chromium phone-sized rendering is not a physical iPhone test. This host has no full Xcode or iOS device, and GitHub's native runners are blocked by account billing. Safari's Share sheet, Home Screen launch and device storage behavior have not been exercised on a physical iPhone here. Apple documents the installation flow in its [iPhone guide](https://support.apple.com/en-lamr/guide/iphone/iphea86e5236/ios); WebKit documents [Web Locks support](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/).
