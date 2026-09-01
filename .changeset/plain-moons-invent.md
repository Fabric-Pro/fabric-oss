---
"fabric-app": patch
---

Let the identifier guard block a two-word name without blocking the ordinary English word its parts spell

The guard matches a term tolerantly on purpose: it splits the entry into word
parts and rejoins them with `[\s\-_]*`, so one entry catches `AcmeCorp`,
`Acme Corp`, `acme-corp` and `acme_corp`. The zero-separator arm is what makes a
branch name catchable, since that is where a name most often turns up in a shape
nobody wrote in the list.

It also means a two-word entry matches the concatenation of its parts — and when
that concatenation is an ordinary word, every innocent use of the word is
blocked: a comment, an env var name, any prose that happens to use it. The guard
scans whole blobs of every file a branch touches, so this surfaces as a branch
failing on pre-existing lines nobody on that branch wrote, and a file untouched
for years fails on its first contact with a relay.

The existing remedy for a colliding term is `~`, which downgrades it to
warn-only — silencing the false positive at the cost of never blocking the real
name either. This adds `+`, which keeps the block for every separated spelling
and drops only the concatenation. Prefixes combine in either order.

Note that parts come from camel-case boundaries as well as explicit separators,
so `+ZephyrCorp` also stops matching the run-together form; the doc comment and
a test pin that, since it is the surprising half. The term list itself lives
outside this repository, so adopting the marker for a specific entry is a
separate change by whoever owns the list.
