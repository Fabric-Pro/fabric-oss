---
"fabric-app": patch
---

Prompt catalog action rows keep all their buttons on the card at phone width, and the "No longer listed" label now matches the groups above it.

Fizzy #2248 follow-up.
- Label: it was an h2, and the unlayered `h2 { font-size: 1.25rem }` rule in globals.css overrode its `text-sm`, so it rendered larger than the feature-type groups. It is now a plain label naming the section via aria-labelledby, matching those groups.
- Buttons: since #551 an organization's override that a viewer's personal default shadows carries Use this, Set for org and Clear override on one row. The button group was `shrink-0` with no wrap, so at 390px Clear override was clipped by the card. The group now wraps below `sm` and holds one line from `sm` up. Pre-checked on staging by applying the classes client-side: clipped buttons went from ["Clear override"] to none at 390px and 768px.
