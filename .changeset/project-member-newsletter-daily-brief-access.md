---
"fabric-app": patch
---

Fix Newsletter and Daily Brief returning "Project not found" for project members who are not the project's owner

Twenty procedures across `modules/newsletter` and `modules/daily-brief` re-derived
the project after `requireProjectPermission` had already authorized the caller,
using `{ id, organizationId: null, userId: context.user.id }`. In personal
context that clause means OWNER, so an accepted `ProjectMember` — an external
guest, most visibly — passed the middleware and was then rejected by the handler
with `NOT_FOUND`. Organization-owned projects were unaffected, which is why this
survived: the personal path simply disagreed with the org path.

The read failing was worse than the write failing. Every field in the settings
panel reads `settingsQuery.data?.settings` behind a `??` default, so a failed
load rendered a complete, confident-looking form — newsletter off, no
subscribers, weekly at 09:00 — which is indistinguishable from a project that
has not configured one. Nothing surfaced until a save returned "Project not
found" for a project open on screen.

Both modules now follow the pattern already used by
`projects/procedures/publishing-suite/get-settings.ts`: the middleware
authorizes, the handler loads the project by id alone and takes the tenant from
the loaded row, and `input.organizationId` is a guard (`BAD_REQUEST` on a
positively-wrong non-null value; null and omitted always pass, because a guest
on a personal-context page legitimately sends null for an org-owned project).

Deliberately NOT `getProjectAccessById` / `buildProjectAccessWhere`: those
require `userId` OR a `ProjectMember` row and so have no org-role path, and
would have 404'd an org-role caller who holds the permission without a member
row. Fixing one hole by opening another.

Scope and verification:

- 19 entries removed from `input-org-unverified-baseline.json` (344 → 325).
  The handlers no longer resolve the organization from caller input at all.
- New `project-scoped-lookup-ownership-ratchet.test.ts` blocks the shape
  repo-wide. Its detector reads the balanced argument of each
  `db.project.find*(...)` rather than scanning the whole file, because two
  unrelated files legitimately load a project AND a per-user row.
- `effective-project-permissions.test.ts` gained the deny paths — outsider,
  never-accepted membership, expired guest. They were untested, which mattered
  because removing the handler's redundant check leaves that resolver as the
  only barrier. Negative-controlled: breaking `acceptedAt` reddens exactly the
  matching test.
- `require-project-permission.test.ts` gained the case the whole fix rests on:
  a PERSONAL project reached by an accepted non-owner member is granted (and
  seeds a null-org access grant), while a caller with no membership is denied.
  Every member case in that file was previously an org-owned project and the
  only personal case was the owner — the same blind spot that let the handlers
  assume personal means owner. Negative-controlled by making path C ignore
  personal projects, which reddens that one test and nothing else.
- Behavioural anchor in `personal-project-member-access.test.ts` uses a fake
  project table that answers the query it is given; re-adding the owner clause
  turns it and the ratchet red, which is how it was verified.
- The settings panel now renders an error state with a retry instead of
  defaults when the read fails.
- `@repo/api` 5418 passed, knip clean, type-check clean.

Note for the product owner, unchanged by this fix and worth a decision:
`PROJECT_SETTINGS_READ` belongs to the VIEWER role, so a Viewer can read the
newsletter subscriber list. That was already true in organization projects; this
change makes personal projects behave the same rather than introducing it. If
Viewers should not see subscriber email addresses, that is a separate change to
the permission on `subscribers.list` and `sends.memberList`.
