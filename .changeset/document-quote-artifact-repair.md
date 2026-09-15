---
"fabric-app": patch
---

A document already carrying stray tilde characters around quoted phrases is now repaired when it is opened, instead of rendering damaged forever.

The repair for this artifact already existed and was correct. What was missing
was a caller on the read side: it ran at five seams that persist model output
and nowhere else, so a document damaged before those guards existed was never
reached by any of them.

That mattered because the load/save round trip is a fixed point for this
damage. markdown-it emits a lone tilde as literal text, and the Turndown escape
override never escapes a bare one, so a reader could open the document, edit
it, save it, and see the identical characters indefinitely. Nothing short of
repairing on read puts it in front of them fixed. `repairMarkdownDocument` now
does, and the next ordinary save then persists the clean text.

It runs outside that function's diff-marker guard, deliberately. The guard is
there to stop bullet merging from splitting a diff marker from its pair; this
repair rewrites no structure at all, so a document under review is no reason to
keep showing the damage.

**Not on the write path, and not widened to straight quotes.** Both were tried
and reverted, for the same underlying reason: the repair recognises a damage
*signature* but has no idea where in a document it is looking, and in
particular cannot see a code fence. Curly quotes essentially never sit beside a
tilde inside code; ASCII quotes do constantly — `cd ~"$HOME"`, `col ~'regex'`,
`rm -rf ~'/tmp'`. In a document the signature had already condemned, every one
of those lost its tilde: a different home directory, a broken Postgres
operator, a different path, silently and indistinguishably from a repair.
Putting the same transform on the save path spread that to every write and
re-introduced the silent rewriting of user text this pipeline removed
deliberately. Under-repairing prose is recoverable; rewriting someone's shell
command is not. An ASCII-quote instance of this damage is therefore still not
repaired, and covering it needs fence-aware scanning first, not a wider
character class. The reasoning is recorded beside the code so the next person
to notice the gap finds it.

Separately, the PM-sync conflict dialog and the prompt editor each build their
own HTML-to-markdown service and persist what it produces — story descriptions
and prompt content — and neither had the override that turns the bundled
plugin's invalid single-tilde strikethrough into valid GFM. Both now do.

That override had to be split first. It was bundled with a rule that drops the
*content* of diff-marked deletions, which is right in the document pipeline
because the tags are stripped before it runs and anything left is a deletion
the diff owns. Those two components serialize inbound HTML verbatim and strip
nothing, so the same rule would have deleted text that merely carried the
class — turning a cosmetic tilde bug into content loss. They now take the
strikethrough half alone, and the two entry points are pinned by opposing tests
asserting the same markup loses its content under one and keeps it under the
other.
