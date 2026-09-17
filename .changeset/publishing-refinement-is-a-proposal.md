---
"fabric-app": patch
---

Refining a Publishing Suite draft returns one revision of your working copy instead of three fresh candidates

Refining ran the ordinary generation path, so it inherited the generation
contract. For Short Post and LinkedIn that schema requires exactly three
DISTINCT options — so asking to "remove last line" returned three rewrites, at
least two of which changed something nobody asked about. It also wrote a
candidate row that consumed a version number, appeared in the versions list, and
offered a Restore that took the whole refinement and skipped the diff review.

None of that was a decision; it was inherited by accident. A refinement is a
proposal ABOUT the working copy, so it now lives on the working draft: one
revised document, no candidate row, no version consumed, nothing in the grid.
The generation schemas are untouched — FR16 still requires three for a
generation, and loosening that schema would let a two-option run persist as
READY.

Refine carries a safety note, which generation does not need: on a generation
nobody asked for a specific sentence, but on a refinement the author gave an
explicit instruction, so an unresolved approval that forces the model to write
around it otherwise looks like an instruction silently ignored.

Two defects fixed before they could ship. `updatedAt` is the body's concurrency
token and Prisma moves it on any write to the row, so proposal writes would have
told every open editor their draft had changed underneath them — twice per
refine, by their own refinement. And a shared 40,000-character bound would have
let a 5,000-character refined tweet commit, render, accept cleanly and then be
unsavable by the editor it landed in, since the tweet writer refuses over 2,000.

Also bounds the change-summary model call, which had no output limit: an
unbounded generation fails as a hang rather than an error, and that summary is
advisory, so a reader watching a spinner reads the feature as broken rather than
slow.
