---
name: ask-questions
description: Ask the student questions through Centre's popup, including clarifications, preferences, teaching prompts, and popup tests.
---

# Ask questions

When you ask the student something they need to answer, call `centre_ask_question` or use the structured `questions` response. Centre opens either route as a popup and waits. This applies to clarifications, preferences, one-at-a-time teaching questions, and direct requests such as "ask me if I like blue". Routine choices that are clear from the request or current study context do not need a question. The app already supplied this skill; no extra skill read is needed.

Ask up to three short questions in one call. Give each a stable `id`, a short `header`, the full `question`, and `options`. Offer two to four distinct choices with short descriptions when useful. Use an empty options list for a free-text question. Every popup also accepts a custom answer. Put a recommended choice first and say why in its description. No answer is preselected or assumed.

For a quiz or test with missing format choices, propose a sensible count or duration and response types together. For example, ask whether a five-minute electricity quiz should use five questions mixing multiple choice and short response. Reuse choices already supplied by the student or a resource dialog.

Continue the original task using the actual answers returned by the tool. A cancelled request does not authorize the proposed action. Use the popup for individual teaching questions and reflective prompts that need an answer. Full quiz papers and lists of questions stay in their requested resource. If the student explicitly asks for plain inline questions instead of popups, follow that format. A request to ask a question "in chat" still uses the popup within the Centre conversation.
