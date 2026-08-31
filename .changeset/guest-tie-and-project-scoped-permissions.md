---
"fabric-app": patch
---

Restore project-scoped guests' access to weave, and use the object-level permission check where the procedure is project-scoped

Requiring organization MEMBERSHIP for a caller-supplied organization refused every project-scoped guest, because a guest holds no membership row by definition — that is what makes them a guest. Their own dashboard's calls were refused while the same call succeeded with the organization simply omitted. `hasOrganizationTie` accepts an accepted, unexpired project membership as the real relationship it is; a caller with neither tie is still refused, so naming a tenant you have no relationship with gets nowhere.

Seven weave procedures carry a `projectId` and now use `requireProjectPermission`, which resolves the project's own organization and treats an active project-member row as authoritative — so it answers the question these procedures actually ask, and answers it for guests. Twelve carry only a `planId`; no middleware can see their project, so they return to the reviewed-pending list with the exit written down: resolve the plan's project in the handler, then check the permission against it.

The `requireOrganization` option added alongside is kept and tested but no longer applied. It refuses when nothing resolves, which closes a real bypass, but on these procedures it also refuses a legitimate caller whose session carries no active organization — and sessions only gain one on an explicit switch.
