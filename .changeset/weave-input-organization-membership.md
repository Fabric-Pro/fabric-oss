---
"fabric-app": patch
---

Weave procedures now verify membership before honouring an organization named in their input

A procedure built on the plain protected builder carries no tenant context, so the permission middleware returns early on it and the `requirePermission(...)` beside it evaluates nothing. Nineteen weave procedures paired that inert check with an organization taken from caller input, and the resolver returns what the caller named without confirming they belong to it. The project gate beside it does not close the gap: it authorizes access to the project and ignores the organization argument entirely. The resolved value was then written onto rows in a tenancy class whose organization reads carry no per-user predicate, so a caller could choose the tenant their content landed in. Access to any project was enough to reach it, including one of your own with no organization involved.

Resolution and the membership check now happen together, through one helper, applying the same rule the protocol servers apply to an organization named on a request. Personal context still resolves to nothing and asks nothing, since there is no membership to confirm when no organization was named.

The repository was already tracking this class: the unverified-input-organization baseline listed all nineteen, and drops from 344 entries to 325.

The role axis is separate and is not closed by this. A new source sweep records what remains — ten accepted with reasons, twenty-nine pending review on a list that may only shrink — alongside the existing sweep for the unauthenticated half of the same problem.
