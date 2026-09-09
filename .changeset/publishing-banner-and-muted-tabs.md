---
"fabric-app": patch
---

Put the regenerate action in the banner that asks for it, and mark format tabs that have nothing to show yet

Two things reported from staging (Fizzy #1851).

**The "answers were recorded after this analysis was written" banner said what to do but could not do it.** It ended "— regenerate to fold them in", pointing at a button in the header strip which, on a real analysis, is a long scroll away from the sentence explaining why to press it. The action now sits in the banner, the way Feature Maturation's does. It shares the existing handler and disabled rule rather than adding a second path, so two controls that start the same run cannot disagree about whether one is already going, and a reader without edit permission still gets the sentence without a button that could only produce a 403.

**The format tabs now say when there is nothing in them yet.** Every panel in that row opens on "No planning analysis yet — run one on the Planning & Analysis tab", so before an analysis exists there is nothing to do in any of them, and a reader had to open each one to discover that. They are **muted, not disabled**: generation still works without an analysis, and disabling would hide that from someone who wants to draft anyway. The hint is added beside the existing state badge and never in place of it — that badge is what carries a tab's state into its accessible name, including for a type that deliberately shows no visible badge. A type that already has a draft is never hinted at, because a generated tab is useful whatever the analysis says.
