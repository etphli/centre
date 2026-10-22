# Practice visual recheck

The actual Centre renderer and local service were exercised at http://127.0.0.1:5387/ using an isolated temporary Store and deterministic CLI provider. Grade and generation routes seeded the learning evidence. This does not verify hosted AI, cloud sync, iOS, or the packaged Electron app.

| Finding | Fix commit | Corrected captures and interaction check |
| --- | --- | --- |
| PRAC-1 P1 | 032fe1b | failed-save.png has one danger message and Retry save. discard-local-confirmation.png shows explicit destructive confirmation; Keep working preserves inputs. Reload and resource navigation preserve unsaved recovery. |
| PRAC-2 P1 | 5d5c1c4 | new-attempt.png has blank answers and no Done status. Try again and explicit reset create empty drafts. |
| PRAC-3 P2 | 95200ff | marked.png labels marks separately from question count. failed-marking.png has one safe inline error, no provider details or toast. |
| PRAC-4 P2 | 9cec721 | marking-partial.png uses a neutral disabled jump action. model-answer-open.png shows the custom disclosure, exercised by click and Enter. start-over-confirmation.png uses danger styling and focus. |

Follow-up c6d964d retains reset busy state across navigation and serializes Review resolution with resource moves. A delayed reset response was exercised through resource switching; editing remained disabled until the new blank draft was saved. A gated real disk writer regression checks Review/move persistence after reopening the Store.

The owner personally inspected corrected failed-save, discard confirmation, marked, model-answer, blank-attempt and large-text light captures. Selected radio colors were measured against Centre text tokens in all three themes; no generic blue selection remains. The 1024×1000 large-text comfortable layout and 1440×1000 standard compact layouts have no horizontal overflow. ui-proof.json records the completed interactions and zero uncaught browser errors.

T3 preview fallback reason: preview_open returned "Preview automation client server-browser disconnected during open." The corrected ready-URL attempt also failed to return. CUA reported "Sky Computer Use native pipe startup failed". The proof therefore uses Playwright and installed Chrome against the same real service.

No new Claude reviewer was spawned under the resource restriction. These are owner rechecks of the existing independent review findings; coordinator acceptance remains pending.
