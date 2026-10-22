# Round 1 study-log corrections

Source report: the updated program `reviews/design-round1.json` and `round1-fix-assignments.json`, owned by the coordinator. Claude Opus 5.5 medium produced the independent screenshot-backed review. This response covers only this owner's assigned changes.

| Finding | Fix commit | Corrected capture and verification |
| --- | --- | --- |
| X-1, shared fields | `eb050d8` shared controls; `faa90f8` Log integration | [Manual](manual.png), [date picker](date-picker.png), [time suggestions](time-suggestions.png), [aim](aim.png). Australian dates, minute-only editable time, optional 15-minute suggestions, full minute duration choices. Native arrow/Escape/focus checks pass. Exact UTC milliseconds persist after a title/notes or same-minute edit. Calendar owns adoption of this same component in its PR. |
| X-2, neutral states | `eb050d8` global tokens/focus/selection; `faa90f8` local chart/actions | [Dark](dark.png), [light with large text](light-large.png), [midnight](midnight.png). Native checks confirm neutral action/data tokens in all three themes. Global token scope is documented in `docs/date-time-fields.md`; other owners retain their local selectors. |
| LOG-1, one actual-time encoding | `faa90f8`; zero fill removed in prior `1d506d8` | [Dark](dark.png), [760px](browser-760.png). All four measures use `--data-ink`. Selection is the column background; actual zero values have no filled sliver. Native zero-height assertion passes. |
| LOG-2, aligned daily labels | `faa90f8` | [760px browser](browser-760.png), [minimum desktop](minimum-desktop.png). Compact hour labels, nowrap/tabular figures and a fixed label row. At exactly 760px, all seven chart track tops measure 533.5px. |
| LOG-3, zero labels and formats | `faa90f8` plus shared formatter `eb050d8` | [760px browser](browser-760.png). Empty visible labels retain zero values in accessible summaries. `formatDurationMinutes` produces `1 h 30 min`; entry times drop the leading zero. Calendar can import the same formatter. |
| LOG-4, action targets | `faa90f8` | [760px browser](browser-760.png). Quiet Edit/Delete buttons measure at least 28px; native assertion passes. |

The read-only Sol correctness review also caught selected-time focus, restricted minute values and short-window clipping while the shared controls were built. They were corrected before the focused shared commit. [Minimum-height capture](date-picker-small.png) and native assertions verify picker bounds.

All owned findings have implementation and capture evidence. They remain pending the coordinator's visual recheck. No new Claude review was started. Nothing was merged, deployed or migrated remotely.
