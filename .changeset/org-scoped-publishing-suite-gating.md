---
"fabric-app": patch
---

Publishing Suite can now be enabled for named organizations rather than for a whole deployment.

Adds a per-organization level to the feature-flag resolver (org override >
global override > env var > registry default) and moves every server-side
Publishing Suite gate onto it: the 20 gated API procedures, both deep-link
page guards, and the daily suggestion sweep.

The sweep is the reason this matters. It previously paged every ACTIVE project
on the instance, so enabling the feature in production would have created
suggestion cycles — and spent model credits — for every tenant, including ones
that had never asked for it. It now resolves the enabled organizations once per
run and returns before touching the project table when none is enabled.

The gate holds at dispatch time too, not only at selection. The daily sweep and
the actual per-project dispatch are two separate steps, and an organization can
be disabled — or a project transferred to a different organization — in the
gap between them. The dispatcher re-resolves PUBLISHING_SUITE for the project's
current organization immediately before any cycle is created or workflow
started: the same uncached global reader the sweep itself uses, plus a direct
single-row read of that organization's own override row (not the sweep's
organization-list scan, and not the 10-second-TTL cache the request-serving
read path uses), so that gap can never turn into a spend the org-level switch
was supposed to prevent.

The per-organization switch works in both directions, which is the point of
storing a value rather than a membership row: an organization with an explicit
disabled override is excluded even while the flag is enabled globally, so the
one path that spends money honours the same kill switch every other surface
already did. Per ADR-018 ("An organization is the only tenant context"), the
sweep also excludes every project with no organization outright, written as an
explicit `not: null` rather than left to `NOT IN`'s three-valued NULL
handling — SQL's `NOT IN` neither matches nor excludes a NULL column value, so
a bare exclusion list would only happen to drop personal projects when the
disabled-organization list was non-empty, and would silently sweep them on the
common "nothing disabled" tick otherwise.

Personal projects have no organization to resolve a flag against, so — per the
same ADR-018 alignment — they are refused outright rather than falling through
to the global/env/default chain. Publishing Suite is an organization feature;
a personal project was never a context it could enable itself in.

Nothing is user-visible yet: the client tab ceiling is still the build-time
NEXT_PUBLIC flag, which slice 3 replaces.

Storage is a new additive table rather than a re-key of the existing global
override table, whose read path runs inside the authenticated layout. It is
RLS-exempt by design — an instance-admin control table read by the platform
resolver outside any tenant context.
