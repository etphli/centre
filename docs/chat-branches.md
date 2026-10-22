# Chat branches

Completed prompts offer **Edit prompt** and **Branch from here**. Replies offer **Regenerate** and **Branch from here**. Editing and regeneration create an alternate chat; the original messages remain intact. Branch from here copies through the chosen completed reply and opens a composer in the new chat. A user prompt checkpoints through its following completed reply.

Branches inherit the selected model, pin and folder. Retained messages get independent message IDs and keep attachment IDs, resource IDs, page context, and public activity summaries. Archiving either chat does not archive its relatives or remove their references.

An active or stopping response, or a pending clarification, must finish before branching. An unfinished response survives restart as a saved prompt with a manual retry. Retry reuses that prompt instead of adding a duplicate. The first edited or regenerated reply, and retries, cannot invoke app tools or save structured resources. The UI explains that actions are not repeated; a subsequent student message can request a new action.

## Provider continuity

The installed `codex-cli 0.163.0` protocol was inspected with:

```sh
codex app-server generate-json-schema --experimental --out /tmp/centre-codex-app-server-schema-feature10
```

`v2/ThreadForkParams.json` defines `thread/fork` with `beforeTurnId` to exclude a turn and later turns, or `lastTurnId` to include through a completed turn. Centre records app-server turn IDs against the user message that initiated them. Edits and regeneration fork before the replaced response; continuation forks through the checkpoint. Forks defer automatic goal continuation.

When a checkpoint cannot be mapped or forked, Centre starts a new thread with the selected app transcript, available referenced resources and attachments. Alternate replies explicitly include retained app history even after a successful fork, because a fork may exclude the original turn that seeded a legacy conversation. Failed or interrupted threads are detached before any later response. A response never resumes its parent's later continuation.

## Portable records

`shared/schema.ts` exports `chatLineageSchema`, `messageSchema`, `chatSchema`, `ChatLineage`, `Message`, and `Chat`. Older local snapshots default to root lineage, null page context, empty local turn references, and no response error.

`shared/chat-sync.ts` exports strict `syncedChatSchema`, `syncedMessageSchema`, `projectChatForSync(chat)`, and `projectMessageForSync(message, chatId)`. The Centre database integration uses these through generic `chat` and `message` records at `POST /v1/records` and `GET /v1/changes`.

| Kind | Exact data projection |
| --- | --- |
| chat | id, title, createdAt, updatedAt, deletedAt, pinnedAt, folderId, sortOrder, modelSelection, lineage |
| message | id, chatId, role, content, createdAt, responseDurationMs, resourceIds, attachmentIds, requestContext |

The projection excludes Codex thread/turn IDs, activity, local errors, local paths, credentials and process state. Lineage contains version 1, its operation, parent chat ID, source message ID, checkpoint message ID and the copied prompt message ID. The prompt anchor keeps labels visible after the original chat is archived. References survive tombstones. Sync must not cascade deletion into a parent, child, message, resource or attachment. No separate hosted lineage endpoint is needed.

## Verification evidence

The live local app was exercised with synthetic study values and the signed-in Codex CLI. The original conversation set value 7, then value 99. Editing the first prompt returned value 11 in a separate chat; branching from the first reply returned value 7 without the later value 99. Regeneration and New chat navigation were exercised too. A direct live `thread/fork` probe through the first turn independently returned 7 and excluded 99.

T3 preview failed twice with `Preview automation client server-browser disconnected during open.` Computer-use native startup and its in-app browser were unavailable. Browser verification therefore used standalone Playwright against the real local service at port 4329 and Vite at port 5196. No connected-file or Organato actions were performed. Screenshots show the actual exercised app, not a mock.


## Attachment integration ordering

[PR 12](https://github.com/etphli/centre/pull/12) supplies the canonical portable lineage helper in `shared/chat-lineage.ts`. Its `canShareChatAttachment` validates an attachment-specific chain of retained associations across each branch checkpoint, using trusted workspace IDs and all persisted chats, including archived sources. Unrelated chats, later excluded attachments, cycles and foreign workspaces fail closed. Attachment bytes are not copied.

[PR 11](https://github.com/etphli/centre/pull/11) consumes that helper in SearchIndex and AttachmentStore. It is stacked on PR 12. Merge ordering requires user approval: canonical contract first, then retarget the dependent PRs. The feature PR remains blocked on combined search/service verification; its independent tests do not substitute for that integration gate. The independent Centre D1/Worker sync consumes the projections above, without any separate hosted lineage routes.

## Design corrections and checks

| Finding | Fix commit | Actual rendered evidence |
| --- | --- | --- |
| CHAT-1 | `9fe41ea` | [Different edited siblings, branch glyph and parent line](evidence/chat-branches/CHAT-1-sibling-branches.png) |
| CHAT-2 | `14e8ccf` | [Explicit connected-file, event and resource note](evidence/chat-branches/CHAT-2-explicit-action-note.png) |
| CHAT-3 | `baa424a` | [Compact editor hint above a single action row](evidence/chat-branches/CHAT-3-compact-edit-footer.png) |

An independent GPT-6.1 Sol worker inspected all three actual PNGs against the updated round-one findings and found each satisfied, with no new P1/P2 issues in those captures. No new Claude worker or duplicate full build was used for these corrections.

- `npm run check`: passed typecheck, 106 tests and the production Vite build before the three UI corrections. Existing chunk-size and Zod annotation warnings remain.
- Title-specific tests after CHAT-1: 3 passed, including distinct edits and bounded excerpts.
- Final `npm run typecheck`: passed after all three corrections.
- Boundary-focused tests after the last backend change: 10 passed, including real sidecar service tests and resource creation.
- Real browser flows: edit an early prompt, continue at an earlier reply, regenerate, open original, full-page New chat, compact side-panel branching/edit cancellation/New chat. Light/large/comfortable and midnight/compact layouts were also inspected.
- iOS, the packaged Electron app and combined Search/AttachmentStore integration are not verified by this feature's browser captures.
