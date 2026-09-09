---
"fabric-app": patch
---

You can now refine a saved publishing draft with an instruction instead of only regenerating it from scratch

Fizzy #1851. Regeneration rebuilt every draft from the planning analysis, so "keep this, just make the tone warmer" was impossible — the guidance field steers a fresh generation and cannot express an edit. The only way to make a small change was to make a large one.

Refine passes the draft you saved to the model along with your instruction, and the model revises it: same structure, same sections, same facts, changing only what you asked for and what that leaves inconsistent. It will not reinstate something the draft leaves out — omissions are decisions, not gaps to fill.

The result arrives as a new candidate in the existing compare-and-adopt flow. Nothing writes back over your saved draft, and that stays structural rather than conventional: generation writes to the candidate table and only adopting moves text into the working draft, so no future writer can quietly make regeneration destructive.

A saved draft is not treated as evidence that anything in it was approved. Every grounding rule and unresolved approval applies to a revision exactly as to a first draft, so refining is not a route around them. The draft and the instruction reach the model as fenced data, never as instructions.
