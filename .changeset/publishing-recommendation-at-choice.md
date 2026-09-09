---
"fabric-app": patch
---

The Publishing Suite's post-type picker now shows what the analysis recommended and why, instead of presenting four unexplained options

Fizzy #1851. The recommendation and its per-type rationale already existed — on the topic row and inside the Planning & Analysis document — everywhere except the one screen where the choice is actually made. "Edit post types" opened a blank form, so overriding a recommendation looked identical to filling one in from nothing.

Each option now carries the analysis's own verdict (Recommended / Needs confirmation / Deferred) and the reason it gave. A type the analysis never mentioned shows no badge at all rather than a verdict it never issued.

The verdict is a word, not only a tint, so it survives being read without colour.
