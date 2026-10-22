# Settings selection

BASE-1 reproduced because a single CSS rule gave a hovered category and the current category the same fill and text. The selected category now retains a stronger neutral fill and font weight; hover uses the quieter surface color.

The actual Centre UI was exercised through the T3 collaborative browser. General stayed selected while the pointer hovered Updates. `verification.json` contains measured colors and font weights in dark at 1280 CSS pixels and light at 960 CSS pixels with large text. Both captures were visually inspected. The large-text page had no horizontal overflow.

`npm test`: 117 passed. `npm run build`: passed, including TypeScript. The fixture is isolated synthetic data; it does not verify live sign-in or cloud deployment.

The iOS parity audit found native Settings is a SwiftUI form sheet with sections and pickers, with no category sidebar or hover state. `ios-parity.json` records the source references and platform-only reason.

Code: GPT-6.1 Sol. Read-only iOS parity review: GPT-6 Luna. No other model authored code.
