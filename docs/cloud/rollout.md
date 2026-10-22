# Approval-gated cloud rollout

No remote D1 creation, migration or Worker deployment has occurred. No Organato repository or database was changed.

Before production work, the user must approve deployment and remote schema changes separately from this PR. Required access/configuration is:

- A Cloudflare account permitted to create the independent **Centre** database and Worker on free-only infrastructure. Confirm the account's free plan and free-limit behavior; do not purchase or upgrade a plan.
- The newly created Centre D1 ID, replacing the all-zero placeholder in `cloud/wrangler.jsonc`. Never use the Organato database ID.
- Approved Google desktop/native OAuth audiences and allowed Google subject IDs configured for the Worker. The repository build also needs its existing Google Desktop OAuth configuration; local verification placeholders do not enable login.
- An approved HTTPS Worker address for desktop configuration and native pairing. Native distribution/signing belongs to the iOS owner.
- If hosted AI is approved, the optional Workers AI binding and confirmation that the pinned model/limits fit the free allowance. The committed default has no AI binding. Local simulated inference is not hosted verification.
- If hosted Organato connection is approved, encryption key material via Worker secrets, key version and the exact allowed Organato API origins. Its credentials stay encrypted per workspace. No credential is supplied in committed files.

After approval, create the Centre D1 database, set its binding, configure authentication and secrets, review the four committed migrations, and apply them **only to Centre**. Deploy the reviewed Worker commit. Run live smoke tests with two approved private accounts/devices: denied unauthenticated access, workspace isolation, one-time pairing, offline/retry/conflict, active-branch file access after parent archive, immutable grading replay and Review evidence. Verify live provider behavior separately before describing it as working online.

Enable sync through the explicit backup/import action on an isolated copy of a local library first. Compare resource/chat IDs, versions, file digests, goals and completed study durations. Confirm that a transferred active timer pauses. Keep the original backup and outbox until validation is complete. Never overwrite an existing library to switch accounts.

Rollback disables sync and revokes the affected device or Worker route. Keep Centre tables, local backups, mutation receipts and tombstones; do not roll back by deleting user data or touching Organato tables. Any data correction needs a reviewed forward migration and later user approval.
