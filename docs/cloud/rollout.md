# Centre cloud rollout

The user authorized merge and deployment on 23 October 2026. Centre is deployed at `https://centre-cloud.etphli.workers.dev`, with its own D1 database `16c45b97-0c59-4293-9c79-e1f1aa0ef081` in Oceania. All four migrations are applied. No Organato repository or database was changed. A targeted read-only lookup of the current account's existing verified Google subject supplied the private allowlist.

The Worker has `DB` and `AI` bindings. Google audiences/subjects and Organato encryption/origin settings are Worker secrets. New desktop sync journals and iOS configuration default to the deployed address. Saved alternate addresses, explicit sign-in and opt-in library import remain intact. Cloudflare confirmed Workers Free by rejecting a custom CPU limit. Its native free limits apply. No billing plan, payment setting or spending limit was changed.

## Verified deployment

[The live report](../evidence/cloud/deployment.json) records authenticated D1 writes, exact retries, stale-version rejection, workspace isolation, one-time pairing/revocation, one real Workers AI reply and archived-chat denial. The check used short-lived administrative sessions in isolated dummy workspaces, all subsequently revoked. Run `node --import tsx scripts/verify-cloud-deployment.mjs --bootstrap-test-sessions` with an administrative Cloudflare token to repeat it. Dummy verification records remain isolated from the user's library.

The user's existing Organato key was transferred over TLS into the matching Centre account workspace and encrypted by the Worker. A real hosted snapshot returned 10 subjects, 10 assignments and 2 calendar events. No upstream write or study-library upload was made. Workers rejects `redirect: "error"`; the connector now uses manual redirects and rejects every redirect response. Redirected writes remain ambiguous and cannot replay automatically.

The combined source passes local tests, types and production builds. Native desktop verification passes all 46 flows and text-size persistence. These checks use isolated fixtures and deterministic desktop provider responses. Live Google sign-in, hosted quiz grading and Organato writes were not exercised during deployment.

## Remaining iPhone requirements

The native default now points at the deployed Worker. A dedicated iOS Google OAuth client must be added to the server audiences before direct native Google login is available. Desktop-issued one-time pairing uses the existing authenticated account boundary.

There is no signed iPhone archive or TestFlight invitation. This host has Command Line Tools but no Xcode or simulator, no signing identity/provisioning profile and no App Store Connect credentials. GitHub's new jobs are blocked by its account payment/spending-limit annotation. The final Settings tint correction still needs an actual simulator capture. Earlier native source passed 64 core tests and 12 simulator flows; the final local portable verifier passed five filesystem/timer checks with simulated transport. No membership, paid runner or billing setting was changed.

## Safe operation and rollback

Review future migrations and apply them only to Centre, then deploy the reviewed Worker commit. Never substitute the Organato database ID. Keep the versioned Organato encryption key in private operational storage for recovery; replacing it loses access to already encrypted keys.

Enable study sync through the explicit backup/import action on an isolated copy first. Compare resource/chat IDs, versions, file digests, goals and completed durations. Confirm that transferred active timers pause. Keep the original backup and outbox until validation is complete. Never upload a local library into another account automatically.

Rollback disables sync and revokes the affected device or Worker route. Retain Centre tables, local backups, mutation receipts and tombstones. Do not delete user data or change Organato tables to roll back. Any data correction needs a reviewed forward migration.
