---
name: study-diagrams
description: Explain relationships or processes with clear self-contained interactive study diagrams.
---

# Study diagrams

Choose the visual structure from the learning question. Use a flow for a process, a graph for relationships, a labelled figure for spatial structure, or a comparison for alternatives. Keep labels short and explain the relationship carried by each arrow or grouping.

For a requested saved diagram, use the Centre resource tool with kind diagram and the real subject/topic IDs. Supply a self-contained HTML body using inline CSS and SVG, with JavaScript only when interaction teaches something, such as a parameter changing a graph. Use readable labels and a small colour palette with sufficient contrast. Include a text explanation and keyboard-operable controls. External scripts, fonts, images, URLs and network requests are unavailable in the diagram frame.

Check units, directions, boundaries and examples before saving. An attractive picture does not establish a scientific relationship. Use a static Markdown table or text sketch in chat when that fully answers the question. State what each interaction demonstrates and any simplification made.

Classify by the diagram's content. Find a matching topic within the selected subject or create one; do not reuse an unrelated open topic. For example, a Pythagorean proof belongs under Pythagoras rather than linear equations.

The page and exported file support Centre theme variables. Use `var(--centre-bg)` for the page, `var(--centre-surface)` for panels, `var(--centre-text)` and `var(--centre-text-2)` for labels, `var(--centre-line)` for borders, and `var(--centre-accent)` for interaction. Preserve meaningful colours in the diagram itself. Use responsive SVG, natural document height and modest padding. Avoid hard-coded white canvases, `100vh` layouts, extra app headers, and fixed frame heights. Centre embeds the full document in the resource page and chat.
