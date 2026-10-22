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

The projection excludes Codex thread/turn IDs, activity, local errors, local paths, credentials and process state. Lineage contains version 1, its operation, parent chat ID, source message ID and checkpoint message ID. References survive tombstones. Sync must not cascade deletion into a parent, child, message, resource or attachment. No separate hosted lineage endpoint is needed.

## Verification evidence

The live local app was exercised with synthetic study values and the signed-in Codex CLI. The original conversation set value 7, then value 99. Editing the first prompt returned value 11 in a separate chat; branching from the first reply returned value 7 without the later value 99. Regeneration and New chat navigation were exercised too. A direct live `thread/fork` probe through the first turn independently returned 7 and excluded 99.

T3 preview failed twice with `Preview automation client server-browser disconnected during open.` Computer-use native startup and its in-app browser were unavailable. Browser verification therefore used standalone Playwright against the real local service at port 4329 and Vite at port 5196. No connected-file or Organato actions were performed. Screenshots show the actual exercised app, not a mock.
