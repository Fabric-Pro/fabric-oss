---
"fabric-app": patch
---

Editing a published default prompt now notifies the people it affects, and the tier badges meet AA contrast.

Static review of the delivered prompt-configuration work found four defects. Editing the body of an already-bound default silently repointed every binding at the new version, so everyone subject to it started running different text with no notification — the notice fired only when a default was first bound. The tier badge coloured its label with fill-tuned brand tokens that measure 3.14:1 (organization, light) and 4.02:1 (system, dark) as ink on a card, both under WCAG AA; both tiers now read a dedicated `-ink` token, and the token guard grew a check for ink-on-card pairs so this class of failure cannot ship again. A failed request on the prompts library and the governance dashboard rendered as "you have nothing configured" rather than "we could not check". The action-catalog deep link moved the viewport but never moved focus, so keyboard and screen-reader users arrived nowhere in particular.
