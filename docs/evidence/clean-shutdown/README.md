# Clean desktop shutdown

Quitting used to leave requests racing a closed local service. On unchanged main, the real native flow runner passed 45 checks but logged two `centre:request` failures, `UND_ERR_SOCKET` and `ECONNREFUSED`. The accepted-save regression also failed with `ECONNRESET`.

The app now destroys its renderer before closing the service, and the HTTP server drains accepted requests instead of cutting their sockets. Service failures cross IPC as a validated result and still reject the renderer promise with the original message. This keeps an intentional cancellation from becoming an Electron handler exception. Authorization stays outside that result boundary.

Actual checks:

```text
node --import tsx --test server/service-shutdown.test.ts
PASS: real accepted HTTP save finishes, returns 200 and persists to disk
npm test
117 passed, 0 failed
npm run typecheck
PASS
node scripts/verify-clean-shutdown.mjs
45 native checks passed, 0 renderer errors, 0 centre:request handler errors
```

The native runner uses temporary app data and the unchanged production renderer from tested main, with the Electron process rebuilt from this change. Its build uses explicit nonfunctional Google OAuth values. It does not prove production login or model reasoning. `verification.json` records the actual result. The rerunnable script retains the full output in `.runtime/clean-shutdown/` and fails on any handler error; it does not filter cancellation messages.

There is no new visual behavior to screenshot. The evidence is the actual save response, reopened disk state and native process output. This is platform-only lifecycle behavior: iOS uses its own app lifecycle and hosted transport, so it does not use this Electron IPC/local-service shutdown path. No iOS change is required.

Code author: GPT-6.1 Sol. No other model authored this fix.
