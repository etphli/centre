---
name: study-diagrams
description: Explain relationships or processes with clear self-contained interactive study diagrams.
---

# Study diagrams

Apply automatically to `/diagram`, checklists, requests to check or tick items off, and other custom interactive activities. Use proactively when controls make a study task more convenient, even without an explicit request for interactivity. Honour an explicit request for plain text or print. Create an interactive diagram resource, save it, and show it in the chat. Use the student's description as the topic, without repeating hidden generation instructions in the conversation.

Choose the visual structure from the learning question. Use a flow for a process, a graph for relationships, a labelled figure for spatial structure, or a comparison for alternatives. Keep labels short and explain the relationship carried by each arrow or grouping.

For a requested saved diagram, use the Centre resource tool with kind diagram. Use the real subject/topic IDs for schoolwork, or null for both when the student is learning something outside their subjects. Supply a self-contained HTML body using inline CSS and SVG, with JavaScript when interaction helps the task, such as revealing a worked step or changing a graph parameter. For checklists, use enabled labelled static HTML checkboxes and preserve all supplied tasks, dates and ordering. Give every checkbox a unique lowercase data-centre-checklist-id that does not depend on its label. Markdown task lists render disabled in Centre. Centre persists checked state through its validated parent bridge; do not add browser storage or network access. Legacy checklists receive deterministic IDs from static checkbox document order. Script-created checkboxes are not supported. Use native quiz and flashcard resources for those activities. Use readable labels and a small colour palette with sufficient contrast. Include a text explanation and keyboard-operable controls. External scripts, fonts, images, URLs and network requests are unavailable in the diagram frame.

Check units, directions, boundaries and examples before saving. An attractive picture does not establish a scientific relationship. Use a static Markdown table or text sketch in chat when that fully answers the question. Explain scientific simplifications when relevant. For practical controls, make their purpose clear from their labels.

Classify by the diagram's content. Find a matching topic within the selected subject or create one; do not reuse an unrelated open topic. For example, a Pythagorean proof belongs under Pythagoras rather than linear equations.

The page and exported file support Centre theme variables. Use `var(--centre-bg)` for the page, `var(--centre-surface)` for panels, `var(--centre-text)` and `var(--centre-text-2)` for labels, `var(--centre-line)` for borders, and `var(--centre-accent)` for interaction. Preserve meaningful colours in the diagram itself. Use responsive SVG, natural document height and modest padding. Avoid hard-coded white canvases, `100vh` layouts, extra app headers, and fixed frame heights. Centre embeds the full document in the resource page and chat.
