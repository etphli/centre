# Centre agent instructions

## Keep macOS and iOS aligned

When changing a macOS feature, behavior, shared record, sync contract or AI action,
spawn one iOS parity subagent at the start of the work. Give it the desktop change,
acceptance criteria, canonical schemas and ownership of the corresponding iOS
implementation. Use a separate worktree for concurrent edits. Coordinate with an
existing iOS owner before starting overlapping work.

The parity subagent must update the iOS behavior and its tests, including affected
offline, sync and error states. Share portable domain definitions and preserve
their validation and duration rules. Keep desktop execution credentials and
Codex continuation identifiers local to macOS.

The parent reviews the iOS diff and verifies the combined result. Before calling
the feature complete, record either the implemented iOS counterpart with evidence
or a specific platform-only difference and why it needs no iOS change. If the iOS
app is still on a separate PR, coordinate its actual owner and record that
dependency. A desktop-only implementation is not a completed cross-platform task.

Follow the user's current model, concurrency and usage restrictions. If delegation
is unavailable or forbidden, do the parity work yourself and report the fallback.
Never start a new top-level chat just to satisfy this rule.

## Verify the result

- Read `README.md` and `docs/architecture.md` when changing feature behavior.
- Inspect the existing implementation and reproduce a bug before fixing it.
- Run relevant tests, type checks, production builds and real app flows. Verify
  combined branches when a feature depends on another unmerged PR.
- For iOS changes, run the portable tests and an actual simulator build/UI flow
  locally or in CI. Label missing simulator evidence as unverified.
- Inspect rendered dark/light states, narrow layouts, keyboard focus, loading,
  failed saves and recovery when the UI changes. Capture the final behavior.
- Preserve user data and unrelated changes. Keep fixtures and temporary accounts
  separate from the user's live profile.

## Write reviewable PRs

Use `.github/pull_request_template.md`, replacing every placeholder. Keep this order:

1. Start with concise bullets explaining what was added or fixed and its effect
   on users. Describe the resulting behavior, including the iOS counterpart.
   Include the final number of changed files and lines added/deleted, measured
   against the PR's actual base. Use `git diff --shortstat <base>...HEAD`; distinguish
   a stacked PR's own changes from changes inherited from its parent.
2. List the actual tests and checks run, their results, and anything unverified.
   Identify fixture reasoning, simulated upstream responses and unsigned builds.
3. Embed or link real screenshots or recordings from the final implementation.
   Include macOS/iOS evidence where both changed. For changes with no visual
   behavior, explain that and provide relevant command output instead.
4. Name the actual model or models that authored code and each contribution.
   List design/review-only models separately. Use recorded model IDs; never guess
   an author's model or count a reviewer as a code author.

Update the title, description, diff counts and evidence when the scope or final
head changes. Record dependencies and unresolved findings accurately. Register
every PR layer with T3's `link_pull_request` when available.

## Merge and distribution

Read `docs/releases.md` before merging, packaging or installing Centre. Main has
an automatic release cadence, so a merge may publish a distribution. Keep PR
creation, merge permission, local installation and production deployment as
separate scopes. Obtain the user's authorization for the applicable action and
preserve explicit holds on deferred features.
