---
"fabric-app": patch
---

New project members now appear in an enabled newsletter's recipient list as soon as they join, instead of only after the next send or a disable/re-enable toggle.

Fizzy #2290.

Diagnosis: auto-enrolment fired at exactly two moments — the `false -> true`
transition of `enabled` in `newsletter.settings.update`, and the reconcile
inside `loadActiveSubscribersActivity` immediately before each send. Neither is
"a member joined". Because the send-time reconcile exists, the runtime was
already correct — a member who joined since the last send did receive the next
newsletter — so this was a visibility defect: no subscriber rows existed
between the join and the next send, and the settings panel under-reported who
would be included. The disable/re-enable workaround worked because it replays
the enable-transition backfill.

Fix: `enrollProjectMemberIfNewsletterEnabled({ projectId, email })` in
`packages/database/prisma/queries/projects/newsletter.ts` reads
`NewsletterSettings.enabled` and, when enabled, delegates to the existing
`enrollProjectMembersAsSubscribers` for that one address. It is scoped to the
joining member rather than the whole roster because it runs on a request path:
re-enrolling everyone on each join would make one accept cost a roster read
plus an N-row insert payload, all but one row a no-op. The roster-wide pass
still runs where the roster is the intent — the enable transition, and the
pre-send reconcile that remains the backstop. It is called best-effort, after
commit, from both membership-creation paths: `acceptProjectInvitation` (hooked in the
database function rather than the oRPC procedure, because a Next server action
reaches it from three places in `ProjectInvitationModal` that the procedure
does not cover) and the auth-layer invite-reconciliation wrapper, inside its
existing loop over created project memberships.

Enrolment runs on every branch of `acceptProjectInvitation` that returns a
membership, not only the genuine create. Adversarial review found the
interleaving that the narrower hook loses: two runners both see no member, one
commits and the other resolves to the existing row or collides with P2002; if
only the winner enrolled and it then failed, nobody would write the subscriber
row. The helper is idempotent, so the redundant attempts cost two indexed
reads.

Reusing `enrollProjectMembersAsSubscribers` preserves its semantics:
`createMany({ skipDuplicates })` on `@@unique([projectId, email])` means an
`UNSUBSCRIBED` tombstone is never resurrected by someone re-joining a project,
the XOR tenant fields come from the project, and the audit actor is the admin
who configured the newsletter rather than the joining member.

Known limit, unchanged: membership begins at accept, not at invite
(`getProjectMembers` filters `acceptedAt: { not: null }`), so an
invited-but-unaccepted person still does not appear. That matches what the
disable/re-enable workaround did.

Tests: wiring tests over all four returning branches of
`acceptProjectInvitation`, helper tests for the enabled / disabled /
no-settings / blank-address cases, auth-wrapper tests including the
enrolment-throws path, and a real-DB suite asserting the subscriber row
actually lands with the right tenant fields in personal and organization
context. That real-DB suite is wired into `db-integration.yml` behind a
zero-skip guard — listed suites self-skip on the unit-tests placeholder
`DATABASE_URL`, so without the listing it would never have executed anywhere.
