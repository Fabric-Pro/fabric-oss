---
"fabric-app": patch
---

A deleted organization is now recoverable for 30 days rather than 7, and the docs say so.

Product raised the window at the 2026-09-10 standup and confirmed it on the card (Fizzy #2462).
Projects keep their 7-day window; only organizations move. The reasoning is blast radius: a
deleted project is one team's work and its owner notices within the day, whereas deleting an
organization takes everyone in it offline at once, including the people best placed to notice.

`ORGANIZATION_RETENTION_DAYS` was already the single source of the number, so the behaviour is a
one-line change. What was not single-sourced was the copy: three strings
(`deleteOrganization.confirmation`, `deleteOrganization.description` and
`confirmDeletion.warning`, in en and de) had "7 days" typed into them, while their neighbours two
keys away already took `{days}`. They are parameterised now and fed from the constant through the
two server pages that render them, so the screens cannot promise one number while the purge
honours another.

The migration re-stamps `scheduledPermanentDeleteAt` for organizations already inside the corridor.
That column is stamped at deletion time and never recomputed — the property that makes "recoverable
until <date>" honest — so without it an organization deleted before this change would be destroyed
on day 7 while every screen said 30. The statement only ever extends a date and is idempotent, so a
future shortening of the window cannot reach a row through it.

Docs: `features/organizations` had no mention of retention or restore at all — it documented
deletion as owner-only and stopped. It now describes the two-proof confirmation, the 30-day
self-service restore, the pre-purge warning email, and the planned six-month inactive-organization
cleanup. Publishing the window ahead of that cleanup was asked for on the standup, for legal
reasons.
