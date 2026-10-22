# Desktop shortcut verification

These captures come from the production renderer in actual Electron windows with the real preload and filesystem IPC. All created icons, profiles, and study fixtures were temporary. The user’s Desktop was untouched.

- `unavailable-light.png`: SHORT-1, fixed in `be9e267`. Each disabled study action states its dependency even when the introduction is scrolled away.
- `repair-light.png`: missing owned icon with matching outlined Remove and Repair buttons.
- `installed-conflict-dark.png`: repaired New chat icon, Add/Remove with matching chrome, and a user-owned Calendar file preserved as a conflict.
- `packaged-newchat.png`: opening the actual setup-generated `.inetloc` through macOS focused New chat in the unsigned packaged app.

`verification.json` records the checks. The native wrapper suite labels synthetic lifecycle events and separately launches a real second process. The packaged suite verifies actual cold macOS URL delivery, system handler identity, native icon opening, and warm URL delivery. It uses a verification-only bundle ID to avoid other Centre builds and unregisters that bundle afterward.

Study actions are checked against the isolated combination with [Study Log PR #10](https://github.com/etphli/centre/pull/10), without merging either branch into main. The standalone PR disables study setup until that dependency is present. Release signing, notarization, installed-release URL association, and Google authentication were not verified. Local builds used fixture OAuth values.
