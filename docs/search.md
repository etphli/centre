# Local search

Centre searches its local saved data through `GET /api/search?q=...`. The desktop IPC bridge permits the same route. Both require the existing private service boundary; the response contains result metadata and snippets, never attachment bytes or storage paths.

The index includes active chat titles and messages, subjects, topics, resource titles and bodies, question prompts, choices, answers and explanations, flashcard fronts and backs, saved connected-file text, events, assignments, and extracted attachment text. Supported attachments reuse `AttachmentStore`'s existing PDF, DOCX and UTF-8 text sidecars. Images have no OCR index.

Queries use Unicode letters, numbers and combining marks. Case, accents and punctuation normalize for matching while highlight offsets refer to the returned snippet. Every query term must match. The final term supports prefixes of at least two characters. Adjacent complete phrases rank first. A query accepts at most 160 characters and uses at most 16 terms. Prefix expansion stops after 64 indexed terms; ranking considers at most 160 matching documents and returns at most 40 results. Snippets contain at most 280 characters and 24 highlight ranges.

## Source ownership and navigation

Resources and their question records appear only while the resource is active. A question hit opens its exact quiz question, flashcard or test question. Other resource hits open the resource. Connected files open their saved Centre resource.

Attachments retain immutable IDs through verified chat branches. Same-chat retries and retained parent, child, sibling and nested branch associations are allowed without copying bytes. Every persisted owner, including archived ancestors, must authorize each active target through the canonical lineage helper. Unrelated roots, forged or disconnected references, invalid ancestry and attachments beyond a checkpoint fail closed. Orphan uploads and deleted-only owners produce no results. Archive and restore rebuild the searchable documents. Attachment hits open the first referencing message in each authorized active chat; existing sidecars contain no page map, so PDF page anchors are unavailable.

Subjects and topics open their existing pages. Calendar events and assignments open the calendar context.

## Index lifecycle

`SearchIndex` builds an in-memory inverted index at service startup. Successful resource creation/moves, connected-file reads/refreshes/edits, message persistence, chat/resource archive and restore, and Organato mutations refresh it. New uploads become searchable when a persisted message references them. The saved user message and its attachments remain searchable if the AI response fails.

Queries read postings and token positions in memory. They do not scan attachment files or resource bodies. Rebuilds read attachment sidecars in batches of 16 and cache immutable extraction results. The cache drops inactive or ambiguous owners; failed reads can be retried by a later rebuild. A rebuild publishes its documents atomically, and an older asynchronous rebuild cannot overwrite a newer one.

The index is disposable derived data. It adds no search records to persisted snapshots or Centre's independent Cloudflare D1 database. Future sync code must refresh the index after applying source changes to the caller's local Store. A hosted or mobile search equivalent must enforce account/workspace visibility, deletion and attachment ownership in Centre's own Worker and D1. Desktop search has no dependency on that later implementation or on a cloud search service.

Search and `AttachmentStore.assertMessageOwnership` consume `canShareChatAttachment` from the canonical `shared/chat-lineage.ts`. Each persisted owner authorizes the requested active target. Checks are directional because an archived owner may remain a valid source while an archived target is forbidden. One disconnected owner keeps the attachment suppressed. Validation follows retained parent/source/checkpoint edges carrying that attachment, rather than a shared family ID.

`AttachmentStore` derives a stable desktop scope from its trusted data directory and uses separate storage and caches per local workspace. Requests cannot supply a workspace ID. A later authenticated service may pass a verified workspace ID to the constructor. It must preserve the same storage isolation and pass only that caller's scoped records.

The canonical-only dependency is [PR 12](https://github.com/etphli/centre/pull/12), commit `98d76b06637517657ba9c56064e3c0b592d5a17e`. Search [PR 11](https://github.com/etphli/centre/pull/11) is stacked on `feat/chat-lineage-contract`. PR 12 must merge first, then PR 11 can target `main`. Feature 10's server and UI implementation is a separate change.

## Verification

Run `npx tsx --test server/search-index.test.ts server/search-branches.test.ts shared/chat-lineage.test.ts electron/security.test.ts` for extraction, source fields, lifecycle, Unicode, ownership, API bounds and scale coverage. The scale fixture has 240 resources and 120 attachment sidecars of 20 KB each. It checks that repeated queries perform zero attachment reads and reports timing without a machine-dependent pass threshold.

After `npm run build` and `npm run build:electron`, run `npm run verify:search`. The verifier launches the production Electron renderer with a temporary persisted fixture and real private IPC. It extracts real PDF/DOCX fixtures, exercises keyboard selection, follows resource/question/attachment hits, checks the long-chat anchor, and captures dark, light, DOCX and empty result states. Results and screenshots are written to `.runtime/search-ui/`. The Electron build needs the repository's existing Google Desktop OAuth configuration; synthetic values can build an offline UI test but do not verify authentication.


### Review fixes and verification

- SEARCH-1: commit `037528d` marks matching messages and question/card targets with a neutral arrival tint and left rule; the next interaction clears it. A separate navigation counter replays the arrival even when selecting the same hit. Actual captures: [message](evidence/search-attachment-target.png), [question](evidence/search-question-target.png).
- SEARCH-2: commit `2ab33cc` merges highlight ranges across whitespace, underlines matches in selected and unselected rows, increases source-label readability, and attaches a clipped snippet's ellipsis with a nonbreaking space. Actual captures: [dark](evidence/search-results-dark.png), [light](evidence/search-results-light.png).
- Verification: combined suite before the visual fixes passed 113 tests; the focused post-fix search/branch/canonical/security run passed 36 tests. Typecheck and production renderer/Electron builds passed. The final production Electron search verifier passed 15 checks, including destination visibility, clearing, and same-hit reopening for chats, quizzes and flashcards. [Machine-readable UI report](evidence/search-ui.json).
- The coordinator reran the native flow verifier against freshly built main `a9634ae` and exact search `ee94690`: both passed all 45 checks, including diagrams, with zero renderer errors. [Baseline comparison](evidence/search-diagram-baseline-comparison.json). The original run's `Diagram child frame missing` failure did not reproduce; its cause remains unknown. Unchanged source alone does not establish its cause.
- The coordinator verified local combined merge `c1a4cfef89b3a4e60f28cef582316e28a33b82b9` of search `ee94690` and full chat `2150871`: typecheck, 137 tests, production renderer/Electron builds, 15 search UI checks and 45 native flows passed with zero renderer errors. [Combined verification](evidence/search-combined-verification.json) and [actual combined UI report](evidence/search-combined-ui.json). A real integration regression exposed a missing index refresh after a continued branch save; the coordinator added that refresh and a service/store/attachment regression proving immediate prompt/attachment hits and archived-parent/live-child visibility. That fix belongs to full chat PR14; it is not imported into PR11. PR14 must retain AttachmentStore's ownership boundary checks when stacked on PR11.
- The final PR11 fixture uses `messageSchema.parse` so future canonical message defaults are populated without hard-coding fields. Its focused typecheck passed; no full build or runtime runs were repeated for this fixture-only update. PR11 remains draft for remaining program review and user approval. No merge or deployment is authorized.
- No authenticated Google flow, hosted sync, mobile search surface, deployment or merge was verified or performed. Offline Electron bundles used synthetic OAuth configuration solely to satisfy build prerequisites.
