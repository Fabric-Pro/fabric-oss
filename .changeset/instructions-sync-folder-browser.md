---
"fabric-app": patch
---

Coding Instructions repository sync now lets you pick the instructions folder from the branch's file tree instead of typing it.

Fizzy #2725. `projects.instructions.repositorySync.listTree` lists one branch through the integration's own credential, gated like `configure` (INSTRUCTION_CREATE, hosting organization resolved server-side) and, since it discloses the repository's structure, only for members who can see the project and refusing the integration on `configure`'s terms and codes; GitLab answers `supported: false` and the dialog keeps the typed folder. Only paths `configure` would accept as a folder are returned. The configure dialog shows the branch as a single-choice tree of folders, with files shown for orientation only.
