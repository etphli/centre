# Study Log desktop evidence

These are actual captures of Centre with isolated synthetic local study data. They do not demonstrate hosted sync or Google authentication.

- `dark.png`, `midnight.png`, `light-large.png`: built Electron weekly/daily hours, aims and subject totals using neutral ink and the existing theme/text settings.
- `manual.png`, `date-picker.png`, `time-suggestions.png`: actual shared date/time controls in the manual/edit form, Australian date order and exact typed minutes without visible seconds.
- `date-picker-small.png`: the shared picker stays inside Centre's minimum 960×660 desktop window.
- `aim.png`: the hours/minutes control allows a 5 h 20 min aim, beyond quarter-hour choices.
- `minimum-desktop.png`: Centre's existing 960px minimum width. The verifier preserves that desktop behavior.
- `browser-760.png`: T3 browser at exactly 760×900 against the real local fixture server, reproducing the review's 1 h 30 min wrapping case. All seven track tops measured 533.5px. Edit/Delete targets measured 28px.
- `recovered.png`: a real second-process restart. The timer recovers paused at its persisted checkpoint.

Run `node scripts/verify-study-log.mjs` after renderer and Electron builds. It drives the real production Electron app through desktop IPC and temporary disk state, waits for navigation/animation/paint, then captures the exercised UI. The final run passed 29 initial and 5 restart checks with no renderer errors. Reports and additional captures are written under ignored `.runtime/`.

See [verification.json](verification.json) for actual commands, results and limitations, and [design-review-fixes.md](design-review-fixes.md) for the per-finding response. The coordinator live-rechecked charts, date/time fields and narrow layouts. The final hours spinner correction is shown in `duration-light.png`; type=number and keyboard semantics remain. The user subsequently authorized merging after the AI logging check.

`ai-chat.png` and `ai-entry.png` show the real built app sending a chat request through the AI tool protocol and displaying the persisted entry. Model reasoning is substituted by the deterministic CLI fixture, while Electron, IPC, tool validation and disk are real. The separate AI UI verifier passed five checks with no renderer errors.
