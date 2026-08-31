---
"fabric-app": patch
---

Give a suggestion card its full width by replacing the text Edit button with a pencil icon, and guard the Decision Log against future model-facing leaks of retracted answers.

On a feature's Summary + Questions tab, each AI suggestion sat beside a text `Edit` button in a
right-hand gutter, so every card was narrower by the button's width plus its gap. The control is
now a pencil icon in the card's own top-right corner, with an "Edit" tooltip.

The suggestion card IS the accept affordance — a `<button>` — so the pencil cannot be nested
inside it. It stays a DOM sibling and is only PAINTED inside, positioned over a corner the card
reserves with `pr-10` so a long first line can never run under it. Two independent hit targets,
same markup shape as before.

The icon is visible at rest at 70% opacity rather than revealed on hover, because a hover-only
control does not exist on touch and is undiscoverable generally; it transitions colour and opacity
only, never scale. The accessible name still interpolates the suggestion text, so a screen reader
can tell several Edit controls apart — the tooltip is for sighted pointer users.

The Amend control on the Decisions tab gets the matching treatment with a `PencilLine` glyph and an
"Amend" tooltip, so the two places a person edits an answer stop looking unrelated. It keeps a
distinct icon and verb because it is a distinct act: Edit refines an answer before it is recorded,
Amend supersedes one that already is. Its accessible name now names the answer being replaced,
since a thread list renders one Amend per live answer.

Also adds a ratchet test pinning the rule that made #1910 safe. `listDecisionLogThreads` defends
retracted answers with `excludeSuperseded`, but the option defaults to false, so a new reader
inherits the unsafe behaviour silently — which is exactly how the MCP tool
`fabric_get_feature_decisions` came to be missing it after being added later. The test fails any
call site that neither passes the flag nor is declared a human-facing surface, and fails loudly if
a refactor empties its sweep rather than passing vacuously.
