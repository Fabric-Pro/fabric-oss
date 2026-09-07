---
"fabric-app": patch
---

Put the pause control next to unlink on a linked channel or chat, instead of stranded in the middle of the row.

The linked-conversation row is a `justify-between` flex container that had two
children — the label block and the unlink button. Adding the pause control made
it three, so the browser distributed all three evenly: the pause icon landed in
the middle of the row, reading as unrelated to the unlink beside it rather than
as its pair. Both buttons now share one `shrink-0` group, which is what
`justify-between` was always assuming.
