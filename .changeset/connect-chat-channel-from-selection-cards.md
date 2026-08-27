---
"fabric-app": patch
---

Let a project reach chat-channel setup from the settings cards that select channels, including when channels are already linked.

Three project-settings pickers let a project choose which linked Teams/Slack
channels receive something — release notes, review alerts, topic suggestions —
and none of them can link a channel; linking happens on the Knowledge tab. Each
carried its own "Connect a channel" button rendered ONLY in its empty-state
branch, which is the branch a project with channels never renders. Linking a
first channel therefore removed every route to a second. The publishing card
was worse still: the same empty-state copy, naming a destination, with no
button under it at all.

The affordance now renders in both branches of all three pickers, from one
shared component, and the click scrolls to the monitor cards rather than only
switching tabs — they sit well below the fold of a long tab, so a bare tab
switch lands the reader at the top with nothing visibly different.

The scroll anchor is a new `id`, deliberately NOT the `data-onboarding-target`
already on that element. That attribute belongs to the Get Started registry and
is drift-tested against it; sharing it would give one attribute two owners, and
a rename would stay green on the side that has a test while silently breaking
this navigation, which does not.

Pinned by tests that assert the affordance in the LIST branch specifically —
the branch that had no way out — and by a count rather than a presence check,
so a half-fix reaching only one of the newsletter's two pickers fails. The
publishing card's existing empty-state case asserted only the copy, and had
passed for months against a dead end; it now follows the button.

Verified by deliberate break rather than assumed: removing the null guard, the
scroll anchor, and one of the two newsletter affordances each failed exactly
the intended case and nothing else, and each file was restored byte-identical
from a backup copy. One break initially did not land — the precondition check
caught it before its result could be misread as evidence.
