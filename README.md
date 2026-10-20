# Centre

Centre is a private macOS study app with a chat-first workspace. It connects to your installed Codex CLI and Organato account. Study data stays on your computer.

## Run Centre

Use Node.js 22.14 or later on macOS. Install Codex CLI and sign in with `codex login`.

Before you run `npm run desktop`, provide the app's Google Desktop OAuth config. Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or save Google's installed-app JSON as `.runtime/google-oauth-source.json`.

```sh
npm ci
npm run desktop
```

Centre opens in its own Electron window. The local service starts with the app and closes when you quit. Full Xcode is unnecessary.

To run the shared interface in a browser, use `npm run dev` and open `http://127.0.0.1:5186`. Native file dialogs, PDF export, and updates require the desktop app.

## Connect Organato

1. In Organato, open **Settings > API keys**.
2. Create an API key with read and write access.
3. In Centre, open **Settings**, save the key, and sync.

Centre reads your subjects, assignments, and to-dos from Organato. It saves topics, chats, resources, quiz attempts, review notes, and preferences locally. Centre creates calendar study sessions as calendar-enabled Organato to-dos through the `/items` API. Organato has no separate calendar-event endpoint. Add sessions in Calendar or ask chat to add or edit one. Calendar can mark a session complete. Centre has no action for deleting a session. Organato handles any connected calendar provider sync.

A missing key makes Organato sync and writes fail. A read-only key can sync but cannot create, update, or complete work. Centre reports failed writes and does not save a local substitute. Inspect Organato before retrying a write whose result is unclear.

## Study in Centre

Start a chat to ask questions or explain a difficult topic. Use `/quiz`, `/test`, or `/flashcards` to create a resource with guided choices. Type `/diagram` followed by a description, or ask to make something interactive, to create a diagram directly in chat. Centre also creates interactive resources proactively when they make a task easier, such as a checkable list for upcoming work or a quiz for practice questions. Ask for plain text when that is what you prefer. Checklist controls work while the resource is open; checked progress resets when it reloads. Your message stays as you typed it. `/plan` starts a study-planning conversation.

Centre lists the visible models and supported reasoning efforts from your Codex CLI catalog. New chats and resource generation default to `gpt-6.1-sol` with medium reasoning. Quiz marking defaults to `gpt-6-luna` with medium reasoning. Choose its model and reasoning independently in Settings. The message bar changes the model and effort for that conversation only. New chats use the default set in Settings.

Quizzes show one question at a time. Your answers stay in place while you move between questions. Marking saves the attempt and sends questions that need more review to **Review**. The default quiz has 8 questions. Tests can use a duration or an exact question count. Your default is time, initially 45 minutes. Each paper starts with a cover page showing the topic, section breakdown and mark totals, followed by separate multiple-choice, short-response and long-response sections when selected. Before every quiz or test, review its count or duration and choose multiple choice, short response, long response, or a mix. Settings stores those defaults.

Pin chats or place them in folders. Open the side chat beside a page, including a quiz, to keep that page visible while you ask about it. Each message includes the current page context. Centre bundles 19 adapted study and writing skills. Centre selects relevant skills automatically, shows their names beside the response, and lets you request one by name.

Attach text, PDFs, DOCX files or images with the paperclip or by dragging files into the message bar. Expand the thinking row to see public reasoning summaries, progress updates, and tool activity. The row keeps the varied thinking phrases and shows elapsed time. Clarification questions open in a popup with suggested choices and a custom answer field. Your answer resumes the same response. **Stop response** cancels the question and the response.

Resources normally belong to the matching school subject and topic. For learning outside school, choose **Personal learning** in the resource dialog or ask chat to save without a subject. Find those resources under **Resources > Personal learning**. **Move** can file them into a subject later. **Delete** on a resource page or card removes it from the library and Review. Use **Undo** in the confirmation toast to restore it, including its saved attempts and review history.

The school-year profile defaults to Year 9 NSW. If a subject name includes a year, such as `Year 10 Mathematics`, that year takes priority. For supported NSW Mathematics, English, and Science syllabuses through Year 10, Centre tries to fetch official NESA evidence. If it cannot retrieve official evidence, it marks syllabus alignment as unverified. It does not guess school sequencing or Core and Path choices.

Settings include your nickname, response length, theme, spacing, text size, school year, time zone, quiz question counts, test duration and response types, and default difficulty. Greetings change automatically with the time of day and can use your nickname.

Diagrams embed directly into chat and resource pages, resize to fit their content, and follow the active colour theme. **Open file** opens a standalone HTML copy. **Move** corrects a saved resource’s subject and topic. The diagram frame blocks network access and access to the app.

For PDF papers, install [Tectonic](https://tectonic-typesetting.github.io/). Its first compilation downloads typesetting support files, so an internet connection is required unless the bundle is cached. You can export `.tex` source without Tectonic.

## Google sign-in

Centre provides one **Sign in with Google** button. It opens the system browser and uses a loopback callback with PKCE. Google sign-in identifies your local account; it does not upload study data.

The OAuth client belongs to the app, so you do not enter its ID or secret in Settings. A desktop build reads both environment variables or the installed-app JSON file. The build validates the input and writes an ignored config file. Electron Builder places that file in the app's resources. Never commit the source JSON or OAuth values.

## Build a macOS app

Provide the Google Desktop OAuth config described above, then run:

```sh
npm run package:mac
```

The app, DMG, and ZIP appear in `release/`. Every push to `main` also publishes Apple Silicon and Intel DMGs in [Releases](https://github.com/etphli/centre/releases/latest). Download a DMG to share with friends. See [the release guide](docs/releases.md) for installation, signing, and automatic updates.

## Verify changes

```sh
npm run check
npm run build:electron
node scripts/verify-flows.mjs
node scripts/verify-interactions.mjs
```

With a signed-in Codex account, run `npx tsx server/live-interaction-check.ts` to check real-model checklist, quiz, plain-text and personal-resource behaviour in temporary local data. Generated checklist HTML is retained under `.runtime/live-interactions/` for browser checks.

See [the architecture](docs/architecture.md) for process ownership, model selection, curriculum evidence, and storage.
