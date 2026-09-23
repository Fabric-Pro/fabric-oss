---
"fabric-app": patch
---

Coding Instructions now refuses a single-file add or edit whose name is already a folder in the published version, or that sits under a name stored as a file, instead of publishing a version the CLI sync cannot install.

Fizzy #2644. The derived-snapshot transaction in `packages/database` compared only exact (case- and normalisation-folded) names against the base, so `docs` next to `docs/a.md` published and `fabric instructions sync` stopped part-way. The derive transaction now tracks directory prefixes the way the folder-upload guard does, keeps inherited rows exempt from colliding with each other, and answers `path_tree_collision` with the same wording the upload path uses.
