# Centre architecture

Centre uses Electron, React, and a local Node service. The renderer owns the interface. Electron's main process owns native dialogs, printing, updates, and the service lifecycle.

## Process boundaries

`electron/main.ts` starts `server/index.ts` on a random loopback port and creates a random bearer token. The preload bridge keeps that token out of the renderer and permits only the HTTP methods and paths listed in `electron/security.ts`.

The renderer has no Node.js access. Context isolation and sandboxing are enabled. Centre rejects navigation from the app window and opens validated external URLs in the system browser. Generated HTML previews use an iframe with no same-origin access and a policy that blocks network requests.

During web development, Vite proxies `/api` and reads the service token from ignored `.runtime/connection.json`. The service still requires bearer authentication and listens only on loopback.

## Local data

`shared/schema.ts` defines the stored data. Subjects and assignments come from Organato. Topics belong to subjects, school resources belong to topics, while personal resources use null subject and topic IDs, and review notes point to a resource and question. Quiz attempts retain answers and marking feedback. Chats retain their messages, pin state, folder, ordering, and optional model override. Deleted resources retain their content and history locally, while state responses hide them and their review items until restored.

The service stores local JSON under `~/Library/Application Support/Centre/data` on macOS and writes it atomically. `CENTRE_DATA_DIR` overrides the path for isolated runs. Organato and updater credentials use macOS Keychain. Credential values do not appear in app state responses.

Google app connections store the selected account on this computer. Optional Centre cloud uses a separate Worker and D1 database with a server-derived private account workspace. It preserves local-first use through an explicit backup/import, durable outbox, compare-and-swap records and deletion tombstones. Account switching never uploads a local library into another workspace. Local and cloud mutations share the staged Store writer queue. See [the cloud foundation](cloud/README.md) for authentication, attachment authorization, domain contracts, exclusions and deployment prerequisites.

## Codex models

`server/codex.ts` reads the visible model catalog from the installed Codex CLI. Centre exposes the supported reasoning efforts for each catalog model and validates a selected model and effort before resource generation. New chats and resource generation default to `gpt-6.1-sol` with medium reasoning. Quiz marking defaults to `gpt-6-luna` with medium reasoning. Choose its model and reasoning independently in Settings.

The model catalog does not prove that an account can use each model. A completed turn is the check for access. The Codex app-server uses the existing CLI sign-in. Centre disables shell, terminal, and unrelated configured integrations, then exposes only its validated app tools.

Guided resource submissions send a validated `resourceRequest` alongside the chat message and attachments. `Resources.generate` uses that chat's model and thread to request structured educational content, validates it, and saves it directly. Invalid generated output receives one repair attempt; transport and disk errors are not retried. The normal chat save tool is blocked during guided generation to prevent duplicate saves. Cancellation is checked before each turn and before saving. The service persists the structured request and a stable resource ID on the user message. Retry restores those choices after a restart and reuses an already saved resource if the earlier turn stopped before linking it to chat. Guided retries do not run connected-file or calendar actions. This execution metadata stays local to macOS. Ordinary chat can also return `response.kind="resource"` with a creation request and complete generated content. The service validates and saves that result, attaches it to the conversation, and repairs invalid output once. This route supports every resource kind, including `/diagram`, without requiring a save-tool call. `structuredOutputSchema` converts Zod's discriminated unions to the `anyOf` syntax accepted by strict model output, while runtime validation retains the original schema.

## Curriculum and skills

The learner profile defaults to Year 9 NSW. If a subject name contains a year from 7 to 12, that year overrides the profile year for the request. Through Year 10, Centre retrieves official NESA curriculum pages for supported Mathematics, English, and Science syllabuses in `server/curriculum.ts`. It caches successful reads in memory for 15 minutes. The assistant must cite fetched official evidence for exact outcomes or dates and say when alignment is unverified. It does not infer school sequencing or Core and Path choices.

The `skills/manifest.json` file lists 29 bundled, adapted skills. The service loads relevant skills from the manifest for chat and resource requests. The `unslop` skill loads by default. Centre also exposes the skill list and lets a chat request another skill by its listed name. Electron sets `CENTRE_SKILLS_DIR` to the packaged `Resources/skills` directory; development uses the project-root `skills` directory.

## Preferences and greetings

Preferences store a nickname, response length, theme, spacing, text size, school year, time zone, default quiz question counts, test duration or question count and response types, and default difficulty. The profile year defaults to Year 9. The home view chooses a time-aware greeting each visit and uses the nickname when one is set.

## Chats and quizzes

Chat messages and organization are local. Chats can be pinned or placed in ordered folders. The side chat stays beside the current page and sends that page's context with each message.

Persistent assistant memory is separate from resource-linked review notes. `assistantMemories` stores up to 50 keyed facts, preferences, or goals in the same atomic local snapshot. Existing snapshots default this field to an empty array. `centre_remember` validates a concise key and content, then creates or replaces that key without changing its ID or creation time. `centre_forget_memory` removes an entry by ID. Both tools wait for the disk save before returning success. Chat context and resource generation and marking requests include the current entries, including after a service restart. Model instructions treat memory as student data, prefer current requests and settings over remembered preferences, and prohibit saving secrets or reviving corrected or forgotten entries from earlier turns.

Online quizzes show one question at a time. Moving between questions preserves answers. Submission sends the complete attempt to Codex for marking. The app stores the result and adds questions flagged for review to the local review list.

## Diagrams and attachments

`server/diagram.ts` wraps HTML with network restrictions, theme variables and a small frame bridge. The parent sends only palette colours. The child reports its content height, and the parent accepts size messages only from that iframe. The iframe has scripts enabled and no same-origin access. Legacy diagrams with light-only colours adapt neutral panels and text while keeping meaningful coloured geometry. Standalone files include the same restricted document and current theme. They are private files in the app's user-data directory.

Attachment bytes and extracted text live in private sidecars under the local data directory. PDF and DOCX extraction enforce size and expansion limits. Images become Codex local-image inputs. Prompts label attachment content as untrusted student data. PDF.js remains an external production module so its worker resolves inside the packaged app.

Prompts have no attachment-count limit. Native selection, the composer, recovery, stored messages and synced message records retain every attachment ID. Files remain limited to 20 MB each and 30 MB combined per message. iOS currently sends text-only prompts and displays all attachment IDs in synced messages, so it has no upload-count limit to remove.

Chat stores public reasoning summaries and tool progress. The service ignores raw reasoning deltas. A completed turn saves its bounded activity list alongside the assistant message.

The light theme uses Claude's live `bg-100`, `bg-200`, `bg-300`, `bg-400` and text tokens read on 20 October 2026 from its [official stylesheet](https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-styles-Ca_9Kdqp.css). The page uses `#f9f9f7`, the sidebar `#f3f3f0`, and inputs `#ffffff`.

## Organato and calendar

Centre reads subjects and work from Organato. A write operation requires an Organato API key with write access. A missing key or rejected write returns an error. Centre does not save a local substitute for a failed Organato write. If a write result is unclear, inspect Organato before retrying.

Centre's `/api/events` routes map study sessions to Organato `/items` to-dos with `calendarEnabled` set to true and a deadline. Organato has no separate calendar-event endpoint. Centre can create, update, and complete a session. Remove archives the linked Organato to-do after confirmation. Organato handles synchronization to any connected calendar provider. Centre does not verify that provider sync has finished or access Google Calendar directly.

## Google sign-in

Google sign-in uses an app-owned Desktop OAuth client. A developer build reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or validates the installed-app JSON at `.runtime/google-oauth-source.json`. `scripts/build-electron.mjs` writes the normalized config to ignored `dist-electron/google-oauth.json`. Electron Builder copies that file into the app's resources, and `electron/main.ts` loads it before starting the service.

The sign-in button opens the system browser and uses a loopback callback with PKCE and state validation. Google app connections identify the local account and do not upload study data or sync a Google account's files or calendar. The separate Centre cloud sign-in verifies the identity with the configured Worker; only a later explicit import enables study sync.

## Papers and review

The service renders test questions in an A4 document with a separate title page. `shared/test-paper.ts` groups selected response types, totals the marks and assigns continuous question numbers. The LaTeX export, HTML preview and reflection question picker use that same ordering. Existing papers use the current template when exported. Native PDF export compiles that source with Tectonic in untrusted mode and saves a separate answer section. Tectonic downloads its support bundle on first use unless that bundle is cached. Centre can export the `.tex` source when PDF compilation is unavailable.

Each question can carry optional `paperLayout` data validated by `shared/paper-layout.ts`. The model selects ruled, blank or no working space, graph placement, question and answer graphs, and a page break. Legacy questions derive spacing from response type and marks. A graph below the working limits that space to eight lines or 64 mm. The renderer owns TeX packages and drawing commands; generated text retains its restricted LaTeX command set. Cartesian graphs contain bounded numeric quadratic or linear coefficients and labelled points. `shared/paper-graph.ts` computes clipped curves and point keys for both SVG and TeX, keeping crowded coordinate labels off the plot. Graphs in the question and answer key are separate, so a sketching workspace can remain blank.

The desktop preview and iPhone web app render the same SVG. Native iOS validates and plots the portable graph data in `PaperGraph.swift` and `PaperGraphView.swift`. Graphs stay inside existing question records and survive sync and offline storage. Desktop model credentials and Codex identifiers stay local. Native iOS has no TeX compiler; PDF export remains a macOS feature.

Run `npx tsx scripts/verify-test-papers.ts` to create a deterministic layout fixture in `.runtime/paper-verification/fixture`. Add `--live --image /absolute/path/reference.png` to generate ten graphing questions using GPT-6.1 Sol with medium reasoning in isolated data. The verifier checks blank student axes, plotted answer curves and labelled point coordinates, and writes `.tex`, JSON and HTML evidence. Compile the resulting source with `tectonic --untrusted --keep-logs --outdir <output-directory> <output-directory>/paper.tex`, then inspect the rendered pages.

Review notes preserve the student's description of difficult questions. Quiz marking also creates review notes for answers that need more work. The service includes unresolved notes in later chat and resource context.

## Integration references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Organato API reference](https://github.com/etphli/organato/blob/main/docs/16-organato-api.md), private repository

## Questions and response activity

Chat completions use `server/chat-response.ts` to distinguish messages from questions. A structured question opens the popup even when the model does not call `centre_ask_question`. The service keeps the Centre response open while the student answers, then starts a continuation turn using the returned answer. The question tool remains available and suspends its current Codex turn until answered.

Message responses can include `resourceIds` to display existing work. Chat context supplies saved resource summaries, and the service checks every referenced ID against visible resources before attaching it to the assistant message. IDs already shown during that turn are omitted to avoid duplicate cards. Showing a saved resource does not create another copy.

Both routes create in-memory requests in `server/questions.ts`. The authenticated state response exposes pending requests to the renderer. The popup submits validated answers to `/api/questions/:id/answer`. The service saves the answer in chat history before continuing. Cancellation and shutdown clear both request types. Renderer reloads recover pending questions from the service; restarting the service clears them. Model execution timeouts do not run while a structured question waits, and the question tool pauses its turn timer.


Automatically applied skills and tool-loaded skills appear by name in response activity. The activity panel contains public reasoning summaries, completed progress messages, and tool status. It never requests private reasoning text. The composer reads the chat's optional model override; Settings owns defaults for new chats and the separate marking model.

## iPhone Home Screen client

`mobile-web/` is an independent React client built by `vite.iphone.config.ts`. The existing Worker serves public static files only under `/iphone/` through `ASSETS`; generic authenticated APIs and their workspace repository remain unchanged. The service worker caches the public shell only. `MobileStore` owns an origin/workspace-scoped IndexedDB replica, atomic outbox and private journals. Canonical portable schemas validate every known record. `MobileModel` binds screen actions to their originating workspace and serializes local domain edits. Hosted AI uses the existing durable run/grading routes. See [the client design and verification](iphone-web.md) and [native parity](ios/web-installation-parity.md).

## Reading and interaction preferences

`preferencesSchema` is the canonical portable settings record. Appearance includes Small, Standard, Large and Extra large text, reading font and width, relaxed line spacing, system or reduced motion, and higher contrast. Chat preferences control the send shortcut, initial activity disclosure state, greeting style and response length. Study preferences include automatic or fixed flashcard counts. Defaults preserve existing behavior. System theme and motion resolve against the current device.

The renderer applies text size through root `rem` scaling, including an explicit Standard reset. Reading overrides affect prose, leaving code and maths fonts intact. Reading width affects chat and resource columns; diagrams and externally embedded documents retain their own layout. Motion reduction suppresses CSS animation and transitions, including when requested by the operating system.

Settings saves use the existing validated partial `/api/settings` endpoint. Controls display pending and failure states, and a successful refresh supplies the confirmed values. Reset sends only `preferencesSchema` defaults. It does not touch accounts, models, credentials, sync enablement, memories or study records. The cloud preferences record uses this same schema; cloud validators and iOS must accept the additive fields before distributing the change.
