# iOS sync counterpart

The existing iOS owner implements the native counterpart in [PR #13](https://github.com/etphli/centre/pull/13). This PR deliberately coordinates that owner rather than duplicating native account or sync implementation. The iOS branch is still separate; full-program integration is not complete solely because the cloud foundation passes.

The counterpart uses `ios/Sources/CentreCore/CloudModels.swift`, `CloudHTTP.swift` and `StudyLog.swift`, a workspace-partitioned durable outbox, Keychain sessions and HTTPS Worker requests. It preserves unknown records, decimal cursors, transport versions and independent domain revisions. No desktop runtime or CLI credential is required. Attachments use authenticated active-target scope and verify chunk bounds and SHA-256 before publishing cached content.

The owner has integrated the retained-learning-history correction from `70fbc19` into its hosted module and reports passing real central-auth/router/SQLite integration with simulated inference/upstream responses. Native explicit local conflict resolution increments the domain revision beyond both copies; immutable attempts allow only the cloud copy. The owner is checking the timer distinction reported here: Keep Local preserves this device's chosen running lease, while cloud import and restart recover paused at checkpoint.

Reported native evidence includes 61 portable/core checks and an unsigned Release build. The full UI run previously passed 9/10 checks and is being repaired and rerun by the actual owner. This PR does not claim the native app's entire UI or a released-device pairing flow has passed. The latest actual simulator/build evidence and remaining issues belong to PR #13.

The shared desktop `AccountPairing` component originates from the iOS owner and is used here rather than implementing a second pairing flow. The cloud API and hosted modules have actual signed-identity/SQLite handler tests; hosted Workers AI inference, production authentication, real Organato credentials and production deployment remain unverified.
