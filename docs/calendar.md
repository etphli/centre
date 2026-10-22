# Planned calendar sessions

Calendar owns planned events. Actual elapsed study time, timer state and goals belong to the shared study Log domain. Completing, moving or removing a plan does not write study Log time.

`shared/schema.ts` exports `calendarEventSchema` and its derived `CalendarEvent` type for Centre-origin plans. `eventSchema` / `StudyEvent` also support imported Organato projections. `shared/calendar-time.ts` exports the pure week aggregation and `projectCalendarEvent` / `upsertCalendarEventProjection` hooks.

Only Centre-origin plans are cloud `calendarEvent` records. Their stable Centre UUID differs from `organatoId`. `data.revision` is the domain revision; cloud `expectedVersion` is transport compare-and-set. Imported subjects/items/calendar projections never become generic Centre cloud records.

The month view and Monday-first week view share selected-day keyboard navigation. The week grid uses the configured IANA timezone, elapsed duration, overlap lanes and a separate deadline lane. Skipped/repeated wall-clock hours are marked. The explicit editor uses canonical shared date/time/duration fields. Unchanged existing wall times preserve their original precise instant; changed ambiguous or nonexistent times are rejected.

## Organato archive semantics

The adapter follows Organato's public API: `POST /items/:id/archive` with `{version}`. Removing a study session archives the linked item. Done marks completion and leaves the session on the calendar. Assignments and unrelated items are preserved.

The desktop route `POST /api/events/:id/archive` accepts `expectedRevision`. It checks the current domain revision and linked upstream version, requires a matching confirmed archived item, and only then writes a local tombstone. Conflict, failure or uncertain responses leave the session active with an error. Sync preserves tombstones and never resurrects their linked remote IDs. Missing active remote items remain visible for inspection rather than silently disappearing.

## Hosted connector

See [cloud-organato/README.md](../cloud-organato/README.md) for the authenticated extension hook, exact routes and receipts, encrypted credential provisioning, module migration and operation-ledger rules. The database owner mounts that module after central Worker auth and rate limits. The mobile client uses this hosted boundary and an offline command journal; it does not require a laptop.

Centre has its own D1 database and Worker. No Organato repository or production database changes are part of this work. Deployment, migration application and merge require user approval.

[Verification and screenshots](evidence/calendar/README.md)
