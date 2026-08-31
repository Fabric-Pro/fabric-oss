---
"fabric-app": patch
---

Make the last twelve weave permission checks evaluate, and rule what a project guest may do

These identify their work by a plan or execution id, so the project is only known once the row is loaded and no middleware can see it. Each now makes the same decision the project middleware makes, from the handler, right after the project becomes known — one shared function, so the two cannot answer differently.

The ruling that goes with it: a project-scoped guest can read weave plans and start executions, and cannot approve, revise or delete one. No project role grants agent create, update or delete — the ladder tops out at execute, because agent management is an organization-level concern — so this follows the tables rather than working around them.

Cancelling an execution moves from delete to update. Stopping a run is a state change rather than a deletion, and leaving it at delete would have meant organization admin and above: the member who started a run could not have cancelled it.

Applying a template is organization-scoped instead — a template belongs to a person and an organization and names no project, so there is no object to check it against.

The sweep's pending list is empty, reached this time by the exit that fits each shape.
