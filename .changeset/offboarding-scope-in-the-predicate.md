---
"fabric-app": patch
---

Scope offboarding revocation through the relation instead of a snapshot of ids, and stop understating what it revoked

Follow-ups to the member-offboarding fix, from a Copilot review of that PR. Two
were wording; the third turned out to be a real window.

**The scope is now part of each predicate.** `revokeOrganizationMemberAccess`
collected the organization's project and workspace ids with two `findMany`
calls and fed them to `in` filters. An id list is a point-in-time read, so a
project or workspace joining the organization between the read and the delete
would keep the departing member's grants through an offboarding that reported
success. Each statement now scopes itself — `project: { organizationId }`,
`workspace: { organizationId }` — which removes both reads and leaves no window
to miss. The review raised this as a doc-comment inaccuracy (the header claimed
"never a read-then-write" while doing exactly that); the accurate wording would
have been the smaller fix.

**The refusal message no longer understates the scope.** A removal refused
because access could not be revoked said "Could not revoke the member's project
access", while the revocation also covers workspace memberships and the
active-organization pointer on the member's sessions. It now says "access to
this organization". Operator-facing strings are the expensive place to be
approximately right, and under-stating is the worse direction.

**The leave-path body read is defensive again.** `const { organizationId } =
ctx.body as {...}` throws on an undefined body, and a throw inside a global
after-hook turns a departure that already committed into a 500 — the one
outcome that path exists to avoid. It now reads through an optional, matching
the other body reads in the file.

Tests: the query suite drops its id-list cases for a case asserting no read is
issued at all, plus a per-statement check that the scope names this
organization — a relation filter with the wrong key would have satisfied the
old shape check while scoping nothing. Two negative controls: dropping the
scope, and reintroducing the id-list snapshot; each fails exactly the cases
that name it.
