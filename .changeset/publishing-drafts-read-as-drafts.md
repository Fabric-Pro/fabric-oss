---
"fabric-app": patch
---

Publishing drafts read as drafts: short-post candidates preview as posts, and a regenerated long-form draft sits beside the one you saved.

A PO clicked Generate on a short post and read the result as more questions —
"ah, its not question, its options of ready post" — and then, told a rename
would be enough: "rename options as questions wont fix it fully, it also looks
visually as questions". They were right. The three candidates rendered in the
exact vocabulary this product uses for answering a question: a stacked list of
bordered cards, each headed by a label with a paragraph and a button under it,
directly below a guidance field and a generate button. Feature Maturation uses
that shape for suggested answers, where it is correct; Publishing had borrowed
it for a content-selection task.

Three changes, all presentational — no generation, adoption or export
behaviour moves:

- Short post: every user-facing string now says "draft" rather than "option" —
  "Use this draft", "Regenerate drafts", "Writing three drafts", "No short post
  drafts yet". The word was the PO's own reading of the screen, and a heading
  saying "Candidate drafts" over a button saying "Use this option" reintroduces
  a smaller version of the same confusion. The stored field, the schema and
  `selectShortPostOption` keep their names; only what a reader sees moved.
- Short post: each candidate renders as a preview of the post itself, inside a
  neutral frame carrying the character count and a marker for where a feed
  folds it behind "see more" (`FEED_FOLD_ESTIMATE`, 200 characters — an
  estimate to tune, not any platform's published limit). The variant label
  drops from the card's headline to a quiet tag. No platform chrome: what is
  previewed is the text under a constraint, not a screenshot of a network.
- Blog post, case study and stakeholder email: the saved draft and an
  unadopted new version now sit side by side on wide viewports and stack below
  `lg`, each labelled for what it is. The panels had promised the comparison
  in prose — "regenerating writes a new version to compare against" — while
  stacking the two texts several sections apart. The candidate's prose scrolls
  in its own frame; the adopt control sits outside that scroll area so a long
  draft cannot bury it.
- "How this was generalized" (and the email's "What the draft wrote around")
  breaks into one entry per thing the draft wrote around. `safetyNote` is a
  single free-text string with no structured per-approval field, so the split
  is a presentation heuristic over the note's own boundaries: newlines first,
  conservative sentence boundaries otherwise, and the whole note as one
  paragraph when it cannot split confidently. Every character survives it.

One correctness fix the side-by-side forced: the generalization note is read
off the latest generated version, while the editor beside it holds the working
draft — different documents after any regeneration nobody adopted. The note's
three sibling safety surfaces have been qualified since 2C and this one never
was, against the case-study and email panels' own header comments claiming
every surface is. Stacked, the note followed the generated draft it describes,
which was an unstated but correct cue; side by side it is equally adjacent to
both, and the layout invites the comparison that makes attribution matter. All
three long-form panels now qualify it with the sentence the other surfaces
already use, which moved to one shared export instead of being declared
identically in two panels. `BlogPostPanel` had no qualifier of any kind and now
has the same derivation as its siblings.

New shared components `DraftComparison.tsx` and `GeneralizationNotes.tsx`.
14 new panel tests; the 177 existing ones pass unedited.
