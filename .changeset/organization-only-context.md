---
"fabric-app": patch
---

Context is organization-only

Requiring an organization is now the default rather than an option. Every account has one (FR1a), so nothing strands: a user with organizations lands in theirs, and the creation page catches the case where the last one was just deleted.

The switcher's personal-account block is gone with it. That block held the only affordance in the product that set the active organization to null — the way back into a context nothing else supports any more — and a test now guards its absence rather than its behaviour.

The audit-log catalog gains the entry for refused organization access. The action was added to the closed taxonomy when the membership check landed, and the catalog that describes each action in words had no sentence for it, so the interface would have shown a generic fallback for the one row that exists to be read.

Not included, deliberately: a project-only guest is still presented a personal workspace inside the host organization. Changing that alters both the switcher's label and the base path every nav link is built from, and it cannot be verified without a real guest session. It is the remaining piece of this requirement.
