---
"fabric-app": patch
---

Publishing Suite topics now age, then archive themselves out of the inbox, and a read-only planning analysis sizes to its content

Two independent changes the card owner asked for.

**Archive on inactivity, with a snooze exemption that cannot be forgotten.** A
suggestion with no activity for `STALE_AFTER_DAYS` now leaves the Suggested
section instead of sinking to the bottom of it, and the section says so:
"N topics archived after 30 days without activity", with a button to them. They
are reachable through a new Archived filter chip beside the existing Snoozed
one, which is derived exactly as that one is.

Nothing is written and nothing is deleted. Archiving is recomputed every
render, the topic's status is untouched, and any action on it moves `updatedAt`
and brings it straight back — the state is not one a reader can fail to undo.

The exemption FR8/UC5 require is a PROPERTY, not a check. Neglect is measured
from `topicLastActivityAt` — the later of `updatedAt` and `snoozedUntil` — so a
snooze ending counts as activity. A snoozed topic's deadline is in the future,
making its age negative, so it clears no threshold; and a topic returning from
a three-month snooze restarts its clock at the instant the snooze elapsed, so
it comes back visible however old its last real edit is. There is deliberately
no `if (isSnoozed) return null` for a later reader to delete as redundant:
break the property and both halves of FR8 fail together, which four tests
demonstrate.

Because the archive and the old sink select the same topics at equal
thresholds — `composeInboxSections` has already dropped every snoozed topic
before it partitions — the archive supersedes the sink for that set rather than
running alongside it. Reverting is a one-line reroute, and the footer goes
quiet on its own when the array it counts is empty.

**Graduated staleness.** Staleness on the Publishing Suite list was binary: a
suggestion untouched for `STALE_AFTER_DAYS` (30) got a label, a muted surface
and a sink to the bottom of Suggested; anything younger got nothing at all. It
now has an earlier, gentler threshold — `AGING_AFTER_DAYS` (10), exported and
documented as a first guess to tune on exactly the same terms as the existing
constant. A topic past it is de-emphasised WHERE IT STANDS and does not move;
only stale topics still sink.

`topicStaleDays` is replaced by `topicNeglect`, returning `{ days, level }` so
the row's badge and the section's partition read the same value and cannot
disagree about a topic. The Suggested partition stays a two-group stable
partition on purpose — a third group for aging would be a sort by neglect
level, and a sort is the one thing that section may not do to 1B's per-viewer
tier order.

The badge leads with the day count, in the larger of its two type sizes,
because the number is the message; the word behind it ("quiet", then "stale")
is what gives the number meaning and is what tells the two tiers apart with
every colour stripped out (WCAG 2.1 AA). The surface step is taken once, at the
earlier threshold, where the owner asked for "less visible by colour" — a
second step for stale would have to sit between `--card` and `--muted`, about
two units of lightness in light mode, a graduation visible in the code and
nowhere else.

**Planning & Analysis viewer height.** The editor region's
`h-[clamp(24rem,60vh,44rem)]` floor is now gated on edit permission. Both its
reasons are an editor's — stopping the box jumping as the rich/raw toggle swaps
a toolbar and an `EditorContent` for a `Textarea`, and giving `DocumentTocRail`
a definite height to dock against. A read-only viewer has neither toggle nor
toolbar, so it was a tall, mostly-empty box for a problem they cannot trigger.
The rail is kept for viewers rather than hidden or given a smaller floor: it is
a stretch-aligned flex item and takes the row's height, and `DocumentTocPanel`
renders nothing at all when a document has no headings, so a rail with nothing
to stick to cannot arise.

Tests: aging badges and stays put, stale badges and is archived out, a
suggestion inside the aging threshold shows neither, the footer count matches
what left, archived topics stay reachable, a snoozed topic is never archived
(including when its deadline arrives from the wire as a string), a returning
one is visible at 95 days, and the height gate in both directions — each
mutation-checked against an inverted implementation.

Two existing fixtures moved to relative dates, both for the reason that file
already documents. The tier-order control's `tier1` went from 10 days to 8,
because 10 now lands exactly on the inclusive aging boundary. And `makeTopic`'s
DEFAULT `updatedAt` was a literal `2026-08-01`, which drifts: survivable while
stale only meant "sunk and muted", since the row still rendered, but archiving
removes it, so the same literal silently emptied Suggested and took 23
unrelated cases with it.
