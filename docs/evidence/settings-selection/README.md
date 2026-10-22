# Settings selection

BASE-1 reproduced because a single CSS rule gave a hovered category and the current category the same fill and text. The selected category now retains a stronger neutral fill and font weight; hover uses the quieter surface color.

The actual Centre UI was exercised through the T3 collaborative browser. General stayed selected while the pointer hovered Updates. `verification.json` contains measured colors and font weights in dark at 1280 CSS pixels and light at 960 CSS pixels with large text. Both captures were visually inspected. The large-text page had no horizontal overflow.

`npm test`: 117 passed. `npm run build`: passed, including TypeScript. The fixture is isolated synthetic data; it does not verify live sign-in or cloud deployment.

The iOS parity audit found native Settings is a SwiftUI form sheet with sections and pickers, with no category sidebar or hover state. `ios-parity.json` records the source references and platform-only reason.

Code: GPT-6.1 Sol. Read-only iOS parity review: GPT-6 Luna. No other model authored code.

The final narrow pass also fixes FINAL-NARROW-2: breadcrumbs truncate inside their own flex cells, resource actions wrap so Mark done stays visible, theme tiles wrap inside Settings, and the timer error stays on one line. Actual 760x900 large-text captures and bounds are in `resource-narrow-large.png`, `settings-narrow-large.png` and `narrow-verification.json`. These widths are below the native 960px minimum, and were checked as additional browser coverage. The checklist fixture predates Log routes, so its visible timer error is a fixture mismatch rather than a claim about the combined service. The final all-feature service pass remains separate. Native SwiftUI navigation/form/timer layout does not consume these CSS rules; the current native picker tint correction remains awaiting simulator verification.
