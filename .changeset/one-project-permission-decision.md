---
"fabric-app": patch
---

Extract the project-permission decision so a handler can make it, and record why the last twelve procedures are a product call

`requireProjectPermission` answers "may this caller do X on this project" as middleware, which fits when the project id is in the input. Twelve weave procedures identify their work by a plan id, so the project is only known after the plan is loaded and no middleware can see it. The decision is now a function the middleware calls, so a handler can call the same one rather than a second copy that drifts.

They do not call it yet, and the measurement says why: no project role grants agent create, update or delete. The project ladder tops out at execute, because agent management is an organization-level concern. Applying those permissions as declared would refuse every project-scoped guest, since an active project-member row is authoritative and no such row can grant what they ask for. The question is therefore what a guest may do with a weave plan on a project they were invited to — a product decision, which is what the pending list exists to hold.
