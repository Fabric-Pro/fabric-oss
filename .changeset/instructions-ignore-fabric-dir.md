---
"fabric-app": patch
---

Coding-instruction uploads and repository syncs never publish the `.fabric/` directory, so a repository that commits the CLI's `.fabric/instructions.lock` still publishes a bundle that `fabric instructions sync` accepts.

Fizzy #2704. The CLI reserves `.fabric` and refuses any published bundle that names a path under it, but the server's always-ignore list did not exclude the directory, so committing the lock file made every later sync of that project refuse the whole bundle. In-app edits and agent proposals now apply the same always-excluded paths even when an older version's frozen settings cannot be read.
