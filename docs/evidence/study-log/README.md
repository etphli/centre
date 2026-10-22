# Study Log desktop evidence

These screenshots show the built Electron application using isolated synthetic local study data. They contain no user data and do not demonstrate hosted sync or Google authentication.

- `dark.png`: weekly actual hours, explicit aim progress, daily values, and subject attribution. The weekly selection is neutral; zero-time days have no fill.
- `light-large.png`: the existing light theme and larger text setting.
- `manual.png`: the real manual entry form with the existing Centre subject/task menus.
- `recovered.png`: a real second-process restart. The timer recovers paused at its persisted checkpoint and can be resumed or stopped.

Run `node scripts/verify-study-log.mjs` after the production renderer and Electron builds to reproduce the flows and screenshots. The verifier waits for the Log DOM, finite animations, and compositor frames before capture. It exercises actual local API/IPC persistence with temporary data, without hosted fixtures or provider requests. JSON reports and additional screenshots are saved under ignored `.runtime/`.

The independent program design review is a separate quality gate. These captures prove the exercised UI states, not approval of the final design.
