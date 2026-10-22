# Checklist content height

The independent combined review found a valid minimal checklist clipped at its final row. The first heading’s collapsed margin offset the body, while the bridge reported only body height. The trusted inner frame therefore ended before its final controls.

The bridge now measures content height plus the body’s document offset, without changing generated layout styles or either sandbox. The native regression adds a first heading and final checkbox, asserts the checkbox is inside the visible frame, and retains live theme and interaction checks. It failed on the old production bundle and passed after rebuilding Electron. All46 native flows pass with zero renderer and shutdown IPC errors. Eleven focused tests and type checking pass.

The actual T3 browser was rechecked at1280,960 and760 CSS pixels with Large text. All controls and wrapped labels are contained. The root inspected all captures. `verification.json` records exact bounds, before/after evidence and the specific native platform difference. This is synthetic fixture data, not a production account.

Code and root verification: GPT-6.1 Sol. Independent finding: GPT-6.1 Sol, medium Fast.
