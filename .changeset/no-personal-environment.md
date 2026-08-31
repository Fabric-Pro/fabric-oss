---
"fabric-app": patch
---

Never seed a personal tenant, and give every existing account an organization

The rule this settles on: a user is never in a personal environment — they are in an organization, or in the quasi-organization made for them.

One path still created personal rows. A signup whose organization creation failed seeded the MCP defaults personally rather than not at all, reasoning that neither tenant seeded was worse. Under the rule that is the wrong way round: a user with personal rows and no organization is the personal environment, whatever it is called. It is removed, and the failure heals itself — the same helper runs on every session create, so the next sign-in makes the organization and seeds it.

Signup and sign-in together cover everyone who comes back, and nobody who does not. `scripts/backfill-user-organizations.ts` closes the population instead of the path: read-only by default, `--apply` to run, using the same helper so a backfilled organization is indistinguishable from one made at signup. Run it before the drop — a user who gains an organization first loses their rows and keeps a workspace; a user dropped first has nowhere to be until they sign in.
