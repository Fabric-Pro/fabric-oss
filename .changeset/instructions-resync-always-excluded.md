---
"fabric-app": patch
---

A repository-backed coding-instructions sync of an unchanged commit now republishes when the published version still contains a path the server no longer publishes, such as a machine-local `CLAUDE.local.md` or a committed `.fabric/instructions.lock`, instead of keeping that version until the next commit.

Fizzy #2705. The same-commit shortcut compared only the commit and the project's own frozen rules; the built-in always-excluded list has no version, so a version published before that list grew was never re-planned.
