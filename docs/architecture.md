# Centre architecture

Centre uses Electron, React, and a local Node service. The renderer owns the interface. Electron's main process owns native dialogs, printing, updates, and the service lifecycle.

## Process boundaries

`electron/main.ts` starts `server/index.ts` on a random loopback port and creates a random bearer token. The preload bridge keeps that token out of the renderer and permits only the HTTP methods and paths listed in `electron/security.ts`.

The renderer has no Node.js access. Context isolation and sandboxing are enabled. Centre rejects navigation from the app window and opens validated external URLs in the system browser. Generated HTML previews use an iframe with no same-origin access and a policy that blocks network requests.

During web development, Vite proxies `/api` and reads the service token from ignored `.runtime/connection.json`. The service still requires bearer authentication and listens only on loopback.

## Local data

`shared/schema.ts` defines the stored data. Subjects and assignments come from Organato. Topics belong to subjects, resources belong to topics, and review notes point to a resource and question. Quiz attempts retain answers and marking feedback. Chats retain their messages, pin state, folder, and ordering.

The service stores local JSON under `~/Library/Application Support/Centre/data` on macOS and writes it atomically. `CENTRE_DATA_DIR` overrides the path for isolated runs. Organato and updater credentials use macOS Keychain. Credential values do not appear in app state responses.

Google sign-in stores the selected account on this computer. Centre has no cloud sync or multi-account workspace switching.

## Codex models

`server/codex.ts` reads the visible model catalog from the installed Codex CLI. Centre exposes the supported reasoning efforts for each catalog model and validates a selected model and effort before resource generation. New chats and resource generation default to `gpt-6.1-sol` with medium reasoning. Quiz marking defaults to `gpt-6-luna` with medium reasoning. Choose its model and reasoning independently in Settings.

The model catalog does not prove that an account can use each model. A completed turn is the check for access. The Codex app-server uses the existing CLI sign-in. Centre disables shell, terminal, and unrelated configured integrations, then exposes only its validated app tools.

## Curriculum and skills

The learner profile defaults to Year 9 NSW. If a subject name contains a year from 7 to 12, that year overrides the profile year for the request. Through Year 10, Centre retrieves official NESA curriculum pages for supported Mathematics, English, and Science syllabuses in `server/curriculum.ts`. It caches successful reads in memory for 15 minutes. The assistant must cite fetched official evidence for exact outcomes or dates and say when alignment is unverified. It does not infer school sequencing or Core and Path choices.

The `skills/manifest.json` file lists 18 bundled, adapted skills. The service loads relevant skills from the manifest for chat and resource requests. The `unslop` skill loads by default. Centre also exposes the skill list and lets a chat request another skill by its listed name. Electron sets `CENTRE_SKILLS_DIR` to the packaged `Resources/skills` directory; development uses the project-root `skills` directory.

## Preferences and greetings

Preferences store a nickname, response length, theme, spacing, text size, school year, time zone, default quiz question counts, test duration or question count and response types, and default difficulty. The profile year defaults to Year 9. The home view chooses a time-aware greeting each visit and uses the nickname when one is set.

## Chats and quizzes

Chat messages and organization are local. Chats can be pinned or placed in ordered folders. The side chat stays beside the current page and sends that page's context with each message.

Online quizzes show one question at a time. Moving between questions preserves answers. Submission sends the complete attempt to Codex for marking. The app stores the result and adds questions flagged for review to the local review list.

## Diagrams and attachments

`server/diagram.ts` wraps HTML with network restrictions, theme variables and a small frame bridge. The parent sends only palette colours. The child reports its content height, and the parent accepts size messages only from that iframe. The iframe has scripts enabled and no same-origin access. Legacy diagrams with light-only colours adapt neutral panels and text while keeping meaningful coloured geometry. Standalone files include the same restricted document and current theme. They are private files in the app's user-data directory.

Attachment bytes and extracted text live in private sidecars under the local data directory. PDF and DOCX extraction enforce size and expansion limits. Images become Codex local-image inputs. Prompts label attachment content as untrusted student data. PDF.js remains an external production module so its worker resolves inside the packaged app.

Chat stores public reasoning summaries and tool progress. The service ignores raw reasoning deltas. A completed turn saves its bounded activity list alongside the assistant message.

The light theme uses Claude's live `bg-100`, `bg-200`, `bg-300`, `bg-400` and text tokens read on 20 October 2026 from its [official stylesheet](https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-styles-Ca_9Kdqp.css). The page uses `#f9f9f7`, the sidebar `#f3f3f0`, and inputs `#ffffff`.

## Organato and calendar

Centre reads subjects and work from Organato. A write operation requires an Organato API key with write access. A missing key or rejected write returns an error. Centre does not save a local substitute for a failed Organato write. If a write result is unclear, inspect Organato before retrying.

Centre's `/api/events` routes map study sessions to Organato `/items` to-dos with `calendarEnabled` set to true and a deadline. Organato has no separate calendar-event endpoint. Centre can create, update, and complete a session. Centre has no action for deleting a session. Organato handles synchronization to any connected calendar provider. Centre does not verify that provider sync has finished or access Google Calendar directly.

## Google sign-in

Google sign-in uses an app-owned Desktop OAuth client. A developer build reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or validates the installed-app JSON at `.runtime/google-oauth-source.json`. `scripts/build-electron.mjs` writes the normalized config to ignored `dist-electron/google-oauth.json`. Electron Builder copies that file into the app's resources, and `electron/main.ts` loads it before starting the service.

The sign-in button opens the system browser and uses a loopback callback with PKCE and state validation. Google identifies the local account. Centre does not upload study data or sync a Google account's files or calendar.

## Papers and review

The service inserts test questions into a fixed A4 LaTeX template with a separate title page. `shared/test-paper.ts` groups selected response types, totals the marks and assigns continuous question numbers. The LaTeX export, HTML preview and reflection question picker use that same ordering. Existing papers use the current template when exported. Native PDF export compiles that source with Tectonic in untrusted mode and saves a separate answer section. Tectonic downloads its support bundle on first use unless that bundle is cached. Centre can export the `.tex` source when PDF compilation is unavailable.

Review notes preserve the student's description of difficult questions. Quiz marking also creates review notes for answers that need more work. The service includes unresolved notes in later chat and resource context.

## Integration references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Organato API reference](https://github.com/etphli/organato/blob/main/docs/16-organato-api.md), private repository
