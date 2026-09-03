---
"fabric-app": patch
---

Mark the Publishing Suite as Beta on its project tab and page heading while the rollout is still work in progress

Fizzy #2348, FR5. The Publishing Suite reaches its first organizations through
per-organization feature-flag overrides while it is still unfinished, and
nothing said so — an enrolled organization saw a feature indistinguishable from
a finished one.

A new registry flag, `PUBLISHING_SUITE_BETA_LABEL`, paints the marker. It is a
decoration and never a gate: access stays governed by `PUBLISHING_SUITE` alone,
so this flag can never grant or remove anything. Default ON with no env var set
in any environment, so it is on everywhere the feature is; at general
availability an admin turns it off in the console, which is why it is a flag
rather than a literal in the markup — retiring the marker costs a switch, not a
release. Deliberately not `orgScopable`: whether a feature is finished is a
property of the deployment, not of a tenant.

Two surfaces carry it, and they paint differently because a project tab may be
showing its icon alone, its title alone, or both (card #1837). The tab puts
"(Beta)" in its accessible name in every paint mode — that name is the only
thing all three modes have — and paints a chip beside the title when there is a
title, a dot on the icon when there is not. The list page heading gets an amber
`Badge`, `--highlight` rather than the primary rose, because the primary colour
is what calls to action use and a "Beta" chip in it reads as something to click.

Tab membership lives in a `BETA_TAB_IDS` set beside the `tabs` array rather than
as a field inside it: `tabs` is `as const`, so a field on one entry is absent
from the union every other entry belongs to, and three tests parse that array by
source.

Six tests pin both directions on both surfaces. The off case is the one that
matters — a test that only asserted the label is present would stay green if the
flag were ignored entirely.
