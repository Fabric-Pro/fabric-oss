---
"fabric-app": patch
---

Add project-level prompt defaults: a project can override the organization's choice for its own actions.

Fizzy #2068 reviewer follow-up: the tier order inside an organization becomes personal → project → organization → system. A project-scoped default is an organization binding narrowed to one project — set and cleared by the same organization admins, surfaced as its own "Project" tier in the catalog, badges and stage panel, and validated so a project cannot be paired with another organization's id.

The binding unique key widens to include the project column (migration splits the change into drop, widen, index, and a NOT VALID→VALIDATE foreign-key pair so existing rows never block validation). Clearing keeps the soft-clear semantics at every tier, including the new one.
