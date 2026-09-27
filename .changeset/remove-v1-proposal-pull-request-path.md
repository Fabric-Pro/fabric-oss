---
"fabric-app": patch
---

Older coding-instruction suggestions that opened their own pull request no longer offer a separate "Retry opening" action; every suggestion to a repository-backed project is now handled only through its member's branch.

Such older suggestions still show their pull request, its outcome and its history as before. The per-suggestion pull-request workflow, its background sweep and its retry endpoint are removed, and the sweep now selects and acts on member branches only.
