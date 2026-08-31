---
"fabric-app": patch
---

Every account now gets an organization

Nothing created one at signup, so a fresh account had none and landed in a personal workspace. Removing that workspace is only possible once this is true, which makes it the first piece of the elimination rather than a convenience.

The organization is named `[Name]'s workspace`, the convention settled for every signup path including the marketing site, which had proposed a second name for itself.

Provisioning is idempotent and runs at both signup and sign-in, which is what makes it correct for invited users. Invitation reconciliation is gated on a verified email, so an email+password signup has no membership yet when the create hook ends — creating an organization there would hand an invited person a second, empty one. Asking "do they belong anywhere yet" at each point, rather than "were they just created", avoids that.

The same property makes it the backfill: an account predating this gets an organization on its next sign-in, so existing users need no separate migration.

Managed-default MCP configs now follow the tenant the user actually has. They were seeded into personal context unconditionally, which after this change would create exactly the rows the elimination has to delete later. The personal seed survives only for the case where no organization could be made, since a signup ending with neither tenant seeded would be the worse regression.

A failure never fails a signup or a sign-in — the user lands where they would have landed before, and the next session tries again.
