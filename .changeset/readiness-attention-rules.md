---
"fabric-app": patch
---

The readiness panel now asks for attention when something has actually changed, instead of on every visit.

It used to expand on every project open while the project was not Ready — which is most projects
most of the time, so the one gesture it offers, closing it, was undone by walking away and coming
back. Attention that fires constantly stops being attention.

Three tiers replace it. The panel **opens itself** on the first view of the day when the project is
not Ready, capped once per person per project per day, and again whenever things got worse — a
level drop, or an item that was complete and is not any more, which ignores the cap. Anything else
that changed is **marked**: a dot on the collapsed strip and a Done / New / Needs attention chip on
the row. Markers are static and survive a reload, because a pulse someone missed takes the news
with it. Closing the panel silences it for the session, and a Ready project is never opened at all.

**Regressions were invisible until now.** A repository disconnecting, a document regenerating into
failure, someone clearing the terminal statuses — the item silently turned red and nothing said so.
That is the change most worth interrupting for, so it sits in the strongest tier.

"Seen" is recorded when the panel is **expanded**, never on page load: opening a project with the
panel collapsed must not clear markers nobody looked at, or the badge teaches people to distrust
the next one. The day boundary is the viewer's local midnight, because a cap that resets
mid-afternoon for half the team is not "once a day" in any sense a person recognises.

Two schema additions carry it: per-user seen state on the project preference row, and visibility
tracking on the verdict rows — which were written for all 26 items on a project's first read, so a
dependency landing was previously indistinguishable from the row being seeded.

Visibility gets its own timestamp rather than reusing `changedAt`. That column means "when
completion flipped" and the recently-completed list reads it, so bumping it because a dependency
landed would have dated every long-finished item to now and announced the lot as fresh news the
first time this ran — the exact defect this table was corrected for once already. Pinned by a test.
