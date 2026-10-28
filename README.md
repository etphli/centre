# Centre

Centre is a private macOS study app with a chat-first workspace. It connects to your installed Codex CLI and Organato account. Study data stays on your computer unless you explicitly enable optional Centre cloud sync.

## Run Centre

Use Node.js 22.14 or later on macOS. Install Codex CLI and sign in with `codex login`.

Before you run `npm run desktop`, provide the app's Google Desktop OAuth config. Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or save Google's installed-app JSON as `.runtime/google-oauth-source.json`.

```sh
npm ci
npm run desktop
```

Centre opens in its own Electron window. The local service starts with the app and closes when you quit. Full Xcode is unnecessary.

To run the shared interface in a browser, use `npm run dev` and open `http://127.0.0.1:5186`. Native file dialogs, PDF export, and updates require the desktop app.

## Use Centre on an iPhone

In Centre on your Mac, open **Settings > iPhone** and scan the installation QR. In Safari, choose **Share > Add to Home Screen**, then open the new Centre icon and connect with a one-time account code. The [Home Screen web app](https://centre-cloud.etphli.workers.dev/iphone/) uses Centre Cloud while your laptop is closed. Saved Log, resources, quiz drafts and Review work offline; AI and marking need a connection. See [installation, supported tools and verification limits](docs/iphone-web.md).

## Connect Organato

1. In Organato, open **Settings > API keys**.
2. Create an API key with read and write access.
3. In Centre, open **Settings**, save the key, and sync.

Centre reads your subjects, assignments, and to-dos from Organato. It saves topics, chats, resources, quiz attempts, review notes, and preferences locally. Centre creates calendar study sessions as calendar-enabled Organato to-dos through the `/items` API. Organato has no separate calendar-event endpoint. Add sessions in Calendar or ask chat to add or edit one. Calendar can mark a session complete. Removing a Centre-created session archives that linked item and preserves unrelated assignments. Organato handles any connected calendar provider sync.

A missing key makes Organato sync and writes fail. A read-only key can sync but cannot create, update, or complete work. Centre reports failed writes and does not save a local substitute. Inspect Organato before retrying a write whose result is unclear.

## Study in Centre

Start a chat to ask questions or explain a difficult topic. Use `/quiz`, `/test`, or `/flashcards` to create a resource with guided choices. Type `/diagram` followed by a description, or ask to make something interactive, to create a diagram directly in chat. Centre also creates interactive resources proactively when they make a task easier, such as a checkable list for upcoming work or a quiz for practice questions. Ask for plain text when that is what you prefer. Checklist progress and unfinished quiz answers survive reloads. Compare saved quiz attempts from Log or their resource. Your message stays as you typed it. `/plan` starts a study-planning conversation.

Centre lists the visible models and supported reasoning efforts from your Codex CLI catalog. New chats and resource generation default to `gpt-6.1-sol` with medium reasoning. Quiz marking defaults to `gpt-6-luna` with medium reasoning. Choose its model and reasoning independently in Settings. The message bar changes the model and effort for that conversation only. New chats use the default set in Settings.

Centre remembers facts, learning preferences, and ongoing goals across chats and app restarts. Ask it to remember something, correct a saved fact, list what it remembers, or forget an entry. Clearly stated stable learning preferences and goals can also be saved during conversation. Memories stay in the local data file and are supplied to the model in later chats and resource requests. Centre keeps up to 50 entries of 1,000 characters each; when full, update or forget an entry before adding another.

Quizzes show one question at a time. Your answers stay in place while you move between questions. Marking saves the attempt and sends questions that need more review to **Review**. The default quiz has 8 questions. Flashcards default to **Automatic**, so Centre chooses the number of cards based on the material, up to 30. Select **Choose count** to request an exact number instead. Tests can use a duration or an exact question count. Your default is time, initially 45 minutes. Each paper starts with a cover page showing the topic, section breakdown and mark totals, followed by separate multiple-choice, short-response and long-response sections when selected. Before every quiz or test, review its count or duration and choose multiple choice, short response, long response, or a mix. Settings stores those defaults.

Use **New quiz** or **New test** in **Resources**, or the slash commands, to create a resource with those choices. You can also request any resource in chat, including diagrams, flashcards and notes. Centre saves structured resource responses automatically and tries once to repair invalid output. If guided generation fails, **Try again** keeps the selected format. Creating while the current chat is responding starts a fresh chat. Resources lists saved work newest first, with search by title, subject or topic, resource-type filters, and a subject or personal-learning selector. Open an existing quiz to resume its latest marked attempt or choose **Try again** to practise it again. **Browse by subject** opens the subject and topic lists.

Ask chat to show previous work, such as "show my coffee diagram" or "show my old quizzes". Centre can display the original saved resources in the conversation without creating copies.

Pin chats or place them in folders. Open the side chat beside a page, including a quiz, to keep that page visible while you ask about it. Each message includes the current page context. Centre bundles 29 adapted study, writing and design skills, including 10 official Claude skills. Centre selects relevant skills automatically, shows their names beside the response, and lets you request one by name.

Attach text, PDFs, DOCX files or images with the paperclip or by dragging files into the message bar. Expand the thinking row to see public reasoning summaries, progress updates, and tool activity. The row keeps the varied thinking phrases and shows elapsed time. Clarification questions open in a popup with suggested choices and a custom answer field. Your answer resumes the same response. Answered popup questions appear inside its reasoning row, keeping the conversation free of repeated prompts. **Stop response** cancels the question and the response.

Open **Search** or press **⌘K** to find saved resource bodies, quiz and test questions, explanations, flashcards, connected-file content, and extracted PDF, DOCX and text attachments alongside chats, subjects, topics and calendar work. Results show the source and highlighted text. Open a hit to reach its resource, question or owning message. Search works locally, and deleted resources and chats stay hidden. See [local search](docs/search.md) for limits and the sync boundary.

Resources normally belong to the matching school subject and topic. For learning outside school, choose **Personal learning** in the resource dialog or ask chat to save without a subject. Find those resources under **Resources > Personal learning**. **Move** can file them into a subject later. **Delete** on a resource page or card removes it from the library and Review. Use **Undo** in the confirmation toast to restore it, including its saved attempts and review history.

The school-year profile defaults to Year 9 NSW. If a subject name includes a year, such as `Year 10 Mathematics`, that year takes priority. For supported NSW Mathematics, English, and Science syllabuses through Year 10, Centre tries to fetch official NESA evidence. If it cannot retrieve official evidence, it marks syllabus alignment as unverified. It does not guess school sequencing or Core and Path choices.

Settings has dedicated Appearance, Chat and Study pages. Choose one of four text sizes, a reading font and width, relaxed line spacing, reduced motion or stronger contrast. Chat can send with Enter or ⌘/Ctrl+Enter, start response activity expanded, and use simple or varied greetings. Study defaults include quiz and test sizing, response types, difficulty, and automatic or fixed flashcard counts. Your existing defaults are preserved. General includes your nickname and a preference-only reset that leaves accounts, models, memories and saved work intact.

For the iPhone Home Screen app, open **Settings > iPhone**, or choose **View iPhone setup** in General. Scan the public installation QR and follow the Safari steps. Connect with the separate private account code after opening the new Home Screen icon. Native App Store and TestFlight distribution is not available yet.

Diagrams embed directly into chat and resource pages, resize to fit their content, and follow the active colour theme. **Open file** opens a standalone HTML copy. **Move** corrects a saved resource’s subject and topic. The diagram frame blocks network access and access to the app.

Test questions can have different amounts of ruled or blank working space, graphs beside or below the working, and individual page breaks. For graphing practice, Centre supplies blank axes and plots the solutions in the separate answer key. The model chooses these layouts from your request and reference images. Cartesian diagrams currently support quadratic curves, straight lines and labelled points. Desktop and iPhone display the saved graph data offline.

For PDF papers, install [Tectonic](https://tectonic-typesetting.github.io/). Its first compilation downloads typesetting support files, so an internet connection is required unless the bundle is cached. You can export `.tex` source without Tectonic.

## Google sign-in

Google sign-in opens the system browser and uses a loopback callback with PKCE. App connections identify your local account without uploading study data. Optional Centre cloud sign-in is separate: it uploads no study records until you choose **Import and enable sync** in Connections. That action creates a local backup, then syncs validated study records with Centre's own Worker and D1 database. Credentials, Codex continuation IDs and derived search data stay local. Cloud infrastructure must be configured and deployed before it is available; see [the cloud protocol and rollout plan](docs/cloud/README.md).

The desktop app includes its OAuth client. To use your own Google Cloud project, enter its Desktop OAuth client ID and secret under **Settings > Connections > Google connection setup**. A desktop build reads both environment variables or the installed-app JSON file. The build validates the input and writes an ignored config file. Electron Builder places that file in the app's resources. Never commit the source JSON or OAuth values.

## Connected apps and files

Open **Settings > Connections** to search apps or filter by connected services. Available Google connectors are Drive, Docs, Sheets, Slides, Calendar, Contacts, Tasks, Classroom, Forms, Meet, Chat, YouTube, Analytics and Search Console. Gmail is excluded. Each service requests its own permissions. Enable the corresponding APIs in the OAuth client’s Google Cloud project and configure its consent screen. School or workplace administrators may restrict access.

Notion uses an internal integration token. Create an integration in [Notion](https://www.notion.so/profile/integrations), paste its token into the Notion connection, and add the integration to the pages Centre should read. Tokens and Google refresh credentials stay in macOS Keychain. Connection status and saved content stay in the local study data file.

Ask Centre to find and review a connected file. Reading a Doc, Sheet, presentation, Form, Drive file or Notion page creates a linked resource in **Resources** and attaches it to the conversation. Reading the same file refreshes that resource. Open it to read inside Centre, inspect spreadsheet cells or navigate slides, with the side chat still available. **Refresh** fetches the source again. Saved content remains available offline after disconnecting.

**Google preview** embeds the original Docs, Sheets or Slides viewer when Google permits access. **Centre view** uses the saved content and works without Google browser cookies. It shows text and values, with bounded previews, rather than reproducing every image, layout or spreadsheet formula. Sheets default to A1:Z100; ask Centre for another range. Forms show questions. Drive shows file metadata. Notion shows one page of blocks; ask Centre to read nested blocks or continue pagination when needed.

To edit a Doc, Sheet or presentation, enable editing for that service in Connections and request the exact change in chat. Docs and Slides support exact text replacement with revision checks. Sheets supports bounded cell updates, with literal values by default and an explicit formula mode. Successful edits refresh the linked resource. Other connectors currently provide read access.

API references: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Google scopes](https://developers.google.com/identity/protocols/oauth2/scopes), [Docs edits](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate), [Slides edits](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate), [Sheets edits](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update), and [Notion search](https://developers.notion.com/reference/post-search).

## Claude skills

`npm install` and `npm run build` verify the bundled [official Anthropic skills](https://github.com/anthropics/skills) and automatically download missing or changed files. `npm run skills:download` runs the same check directly. The pinned commit and SHA-256 hashes live in `skills/claude-sources.json`; downloads must match those hashes. Available upstream licence files are preserved. A complete bundle needs no network access.

The additional skills cover document coauthoring, Word content, PDFs, presentations, spreadsheets, algorithmic art, canvas design, themes, frontend design and internal communications. Centre automatically applies relevant writing, design and review methods. Skills do not add terminal access or the Python/Office tools used by their original environment; binary Office or PDF creation remains outside these skills’ Centre adaptation.

## Build a macOS app

Provide the Google Desktop OAuth config described above, then run:

```sh
npm run package:mac
```

The app, DMG, and ZIP appear in `release/`. After four PRs merge into `main` since the latest release, the release workflow publishes Apple Silicon and Intel DMGs in [Releases](https://github.com/etphli/centre/releases/latest). Download a DMG to share with friends. See [the release guide](docs/releases.md) for installation, signing, and automatic updates.

## Verify changes

```sh
npm run check
npm run build:electron
node scripts/verify-flows.mjs
node scripts/verify-interactions.mjs
npm run verify:connectors
npm run verify:search
```

With a signed-in Codex account, run `npx tsx server/live-interaction-check.ts` to check real-model checklist, quiz, plain-text and personal-resource behaviour in temporary local data. Generated checklist HTML is retained under `.runtime/live-interactions/` for browser checks.

See [the architecture](docs/architecture.md) for process ownership, model selection, curriculum evidence, and storage.
