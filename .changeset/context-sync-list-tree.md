---
"fabric-app": patch
---

The Living Memory repository-sync dialog can now list a repository's folders and files for GitHub and Azure DevOps repositories.

Fizzy #2674, backend half. `projects.contexts.repositorySync.listTree` reads one branch through the integration's own credential, gated like `configure` (CONTEXT_CREATE, hosting organization resolved server-side). A provider failure is an error with `configure`'s codes, never an empty listing; GitLab answers `supported: false` so the dialog keeps typed paths. At most 20,000 entries are returned, flagged `truncated` past that, with `.fabric/` and coding-instructions files left out.
