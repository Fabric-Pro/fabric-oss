---
"fabric-app": patch
---

The onboarding tour now opens by telling you an AI provider key is required, and closes with how to connect external AI tools over MCP.

Fizzy #2361 asked for three things. FR3 — the "Create your first project" slide repeating at steps 4-6 — already shipped separately as part of Fizzy #2360, so this change is the two new slides and the sequencing around them.

- **FR1/FR2** — a new `aiKey` step at index 1, immediately after the greeting and ahead of every feature step. It states that most of Fabric stays quiet until a provider key exists, and its "Take me there" link goes to the AI provider settings the viewer can actually use: the organization page for an admin, the account page for everyone else. That split is not cosmetic — the organization form renders read-only for non-admins, so a single destination would tell a member to add a key and then hand them a form they cannot submit, which is the exact trap Fizzy #1875 split those two pages to avoid. The copy names the personal-key fallback explicitly, which is the difference between a member believing they are blocked on an admin and knowing they can unblock themselves.
- **FR5** — a new `apiKey` step immediately before the wrap-up, covering minting a key under Settings → API Keys and pointing an external AI or CLI tool at this organization over MCP. Deliberately at the tail rather than beside `aiKey`: a provider key is required for the product to work, a Fabric API key is an optional way to drive it from outside, and stacking both at the top would open the tour with two settings detours before the viewer has seen a single feature.
- **FR4** — no renumbering code was needed. The step counter already derives from the resolved list, so ordering falls out of the registry array. The tests assert it rather than implement it.

Mechanism: `NavHref` now receives the viewer alongside the base path, so a step's destination can depend on who is taking the tour. `OnboardingStepTarget`'s `center` arm gained an optional `navigate`, and the spotlight now populates `ctaHref` for centered steps the same way it already did for anchored ones. Neither settings page has persistent chrome to spotlight — the settings nav only mounts once you are already in settings — so a centered card with a link is the right shape, and it avoids adding two anchors and two pages to the drift test's anchor graph.

Both new steps are centered, so `projectTabOf` returns null for them and the Fizzy #2360 no-project collapse passes them straight through. That interaction is pinned by explicit assertions rather than left to luck.

Test upkeep: several suites hardcoded registry counts (9 steps, 5 collapsed) and fixed click-counts to reach a named step, so inserting a step failed thirteen assertions for no signal. Those now derive their totals from the registry and advance until they reach the step they care about; the literal step sequences stay as the teeth. One genuine behavior change: a viewer standing past the end of a shrinking list now resolves to `apiKey` rather than the wrap-up, which is a better landing.

Pending Product sign-off, flagged on the PR: final copy for both slides, and whether the AI-key slide should be skipped for viewers who already have a key. It is unconditional here — conditioning it needs a third tri-state probe in the controller alongside `hasProject`, and the Fizzy #2360 post-mortem is explicit that an unsettled probe must not strip steps.
