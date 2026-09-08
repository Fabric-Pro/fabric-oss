---
"fabric-app": patch
---

Reserve part of the generator prompt budget for the structured planning-analysis half when the prose half would otherwise consume it

The blog-post, case-study, short-post and stakeholder-email prompts composed the author's prose and the structured analysis into one 8,000-character budget, prose first, truncated from the end. A prose body past the cap therefore deleted every structured section — content types, supporting assets, source signals, recommended questions — from the model input for all four generators, with no error and no test.

The structured half now carries a floor inside that same total budget, and the floor engages only in the regime where the alternative is deleting it outright: prose long enough to fill the whole budget on its own. Below that threshold the composition is unchanged — the complete prose plus whatever structured block still fits — because buying a fuller structured block with the END of the prose would cut the risks and pre-draft guidance sections, which are rendered last and are the ones the writer templates instruct the model to act on.

What the floor buys is the LEADING structured sections, not all of them. It is a fixed share of one shared budget, so a structured half larger than the floor still loses its later collections in order; the change converts an all-or-nothing deletion into a bounded, ordered one. Whenever either half is truncated the composition now logs both halves' input and emitted lengths, so the degradation is visible rather than silent.
