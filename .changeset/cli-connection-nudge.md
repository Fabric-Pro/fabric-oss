---
"fabric-app": patch
---

Prompt a project team to connect a coding CLI, with a readiness checklist row and a dialog that issues a scoped key and a ready-to-paste config.

Fizzy #2457.

A project can carry enough context to be genuinely useful inside a coding tool
while nobody on the team has ever pointed one at it, and until now the product
never said so. This adds two surfaces that do, both behind the org-scopable
`CLI_CONNECTION_NUDGE` rollout gate (default off):

- a dismissible prompt on the project page, shown only once the project has
  cleared a context threshold, and only to someone who can actually issue a key;
- an "API Key for CLI" row in the readiness checklist, which is where the option
  survives a permanent dismissal.

Both read one fact: does this organization have a coding CLI reaching Fabric's
MCP right now. That fact is not inferred from the key tables — scopes are
enforced per tool call, usage counters are stamped before the membership check,
and a personal key's organization is only defaulted — so the MCP runtime writes
it for itself instead. Three new tables: one reach record per credential
(`organization_cli_reach`, no foreign key on the credential id because it is
polymorphic across the two key tables), one never-invalidated per-organization
first-reach row so the adoption funnel survives a rotation, and one per-person
dismissal. Connected means at least one record still names a credential that is
active, unexpired, and owned by a current member — no time decay, but a
revocation flips it.

The issuing dialog mints a read-only key (`mcp:read`, never the write-capable
default) with a 90-day expiry and renders a copyable client configuration plus a
project-named starter instruction. It is mounted outside anything its own
success invalidates, because issuing a key refetches readiness and it holds the
only plaintext copy of a secret the server stores as a hash.

Migration is additive: three CREATE TABLE, one CREATE TYPE, five indexes, four
foreign keys. No DROP, no RENAME, no backfill. It must land before the code —
the readiness evidence query reads the reach records unconditionally.
