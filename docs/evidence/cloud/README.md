# Cloud settings verification

Actual rendered Centre UI, captured through T3 preview at `http://127.0.0.1:14741` with `scripts/cloud-preview.ts`. The fixture runs real local service/Worker handlers, signed fixture identities, isolated SQLite, private local files and a fixture Keychain session. These captures do not show a deployed service or production Google login.

| Finding | Fix commit | Corrected evidence |
| --- | --- | --- |
| CLOUD-1 | `2f3bd64` | `authenticated.png`, `ready.png`: sidebar shows the signed-in cloud email and sync off/enabled; account row agrees. |
| CLOUD-2 | `2f3bd64` | `ready.png`, `pairing.png`: account/device labels replace workspace IDs; shared QR and Copy link replace the raw invitation URL. Captured invitation was immediately invalidated. |
| CLOUD-3 | `2f3bd64` | `empty.png`, `authenticated.png`, `ready.png`, `error.png`, `pending.png`: address is one row, check/pause/warning glyphs distinguish states, Disconnect uses Centre's danger token. |

`conflict.png` shows a real persisted local preference edit racing a second authenticated device write. The local/cloud choice was exercised and sync returned to ready. `pending.png` shows a local edit persisted while the fixture's cloud bridge returned 503; it is not a browser-only disconnected badge. `error.png` shows a failed sync without pending edits. `disconnect.png` shows the confirmation that preserves local and cloud data.

`native-connections.png` and `native-checks.json` come from the packaged Electron connector regression flow: 12 checks passed, no renderer errors. The Electron build required explicit local OAuth placeholders because real Desktop OAuth configuration is absent from this worktree. It verifies packaged UI/IPC behavior, not live OAuth.

The final local run after integrating main desktop actions passed 232 tests, typecheck, production web build, Worker dry run and all four migrations against fresh local Wrangler D1. Tests include real SQLite handler isolation, retry receipts, atomic grading and Review evidence, two-device archive/file authority, failed filesystem writes, queued/direct concurrent edits and abandoned staged-file cancellation. AI inference and Organato upstream responses were simulated in their boundary tests.

GitHub Desktop checks passed on tested implementation head `2874db8`. Fresh independent visual recheck is pending. Live Google authentication, production D1, Workers AI inference, real hosted Organato credentials and native account pairing across released devices remain unverified. No production migration/deployment, signing or release was performed.

To reproduce the local UI, run:

```sh
CENTRE_PREVIEW_SERVICE_PORT=52800 CENTRE_PREVIEW_CLOUD_PORT=52801 CENTRE_CONNECTION_FILE=.runtime/cloud-preview-connection.json npx tsx scripts/cloud-preview.ts
CENTRE_SERVICE_PORT=52800 CENTRE_CONNECTION_FILE=.runtime/cloud-preview-connection.json npm run dev:web -- --port 14741
```

Set `CENTRE_PREVIEW_AUTH=0` for the unconfigured state. Only this isolated fixture exposes `/fixture/offline`, `/fixture/online`, `/fixture/pending`, `/fixture/conflict` and `/fixture/invalidate-pairings`. These are not application or deployed Worker routes. Restart the fixture for a clean independent library.
