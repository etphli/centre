# Shared Centre date and time fields

Import `DateField`, `TimeField`, `DateTimeField` and `DurationField` from `src/ui/DateTimeField.tsx`. Its stylesheet is included by the module. The controls use Centre's existing theme and text settings.

| Export | Props | Value |
| --- | --- | --- |
| `DateField` | `label`, `value`, `onChange` | ISO local date, `YYYY-MM-DD` |
| `TimeField` | `label`, `value`, `onChange` | Local time; shows `HH:mm` and emits edited `HH:mm` |
| `DateTimeField` | `label`, `value`, `onChange` | ISO local date-time, including any measured fractional seconds |
| `DurationField` | `label`, `value`, `onChange`, optional `min`/`max` | Integer minutes, default bounds 1–10080 |

The date button shows Australian order, such as `22 Oct 2026`. The Monday calendar supports arrow keys, Home/End and PageUp/PageDown. Escape closes the picker and restores focus without closing the containing dialog. Time accepts exact typed minutes in 24-hour format. Its optional suggestions use 15-minute steps without forcing rounding. Duration exposes hours and all 0–59 minute choices.

`shared/date-time-fields.ts` exports `withLocalDate(value, date)`, `withLocalMinute(value, minute)` and `formatDurationMinutes(minutes)`. The latter displays `1 h 30 min` consistently in Log and Calendar.

Keep authoritative UTC instants and the IANA timezone in the parent. These controls do not convert timezones. `DateTimeField` preserves all stored seconds when the displayed minute stays unchanged. A date edit preserves time precision; an edited minute resets seconds and fractions. When wall time is unchanged, retain the original UTC instant, including an instant within a repeated DST hour. For changed wall times, use the feature's canonical Temporal conversion with `disambiguation: 'reject'` to reject missing or repeated local times.

Neutral interface tokens live in `centre.css`: `--action-ink`, `--data-ink`, `--selected-bg`, `--selected-ink`, `--focus-ring`, `--selection-bg`, and `--selection-ink`. Legacy `--accent` resolves to neutral action ink in every existing theme. Subject identity colours remain independent.

Run `npx tsx --test server/date-time-fields.test.ts` for precision/DST checks. `node scripts/verify-study-log.mjs` exercises the actual shared controls in the built Electron form, including selected focus, arrows, Escape and persisted exact UTC milliseconds.
