---
name: ask-questions
description: Ask for missing preferences or confirmation through Centre's question popup. Use for clarifications before work, not educational quiz questions.
---

# Ask questions

When a missing choice changes what you will create, call `centre_ask_question` and wait for the returned answers. Routine choices that are clear from the request or current study context do not need a question.

Ask up to three short questions in one call. Give each a stable `id`, a short `header`, the full `question`, and `options`. Offer two to four distinct choices with short descriptions when useful. Use an empty options list for a free-text question. Every popup also accepts a custom answer. Put a recommended choice first and say why in its description. No answer is preselected or assumed.

For a quiz or test with missing format choices, propose a sensible count or duration and response types together. For example, ask whether a five-minute electricity quiz should use five questions mixing multiple choice and short response. Reuse choices already supplied by the student or a resource dialog.

Continue the original task using the actual answers returned by the tool. A cancelled request does not authorize the proposed action. Keep learning exercises, reflective prompts and the quiz itself in the normal chat or resource, so the popup is reserved for decisions about the task.
