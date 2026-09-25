---
"fabric-app": patch
---

Atlas can analyse large repositories without blocking the shared background worker: import resolution now looks candidates up in a prebuilt file-path index instead of scanning every file for each one.

Resolving a bare or aliased import (`react`, `@repo/database`) compared each of its dozens of candidate paths against every file key, and external packages match nothing, so every such import scanned the whole repository. On a large monorepo that was tens of minutes of synchronous work on the worker's single event loop, which starved its database connection handshakes and Temporal heartbeats and failed unrelated workflows, including project instruction repository syncs. Resolution keeps the scan's first-match result (the first file, in order, that equals the candidate or ends with `/candidate`) for candidates of up to 32 path segments; deeper candidates match only an exact path, which keeps the index linear in file count. Candidate ordering, including dropping an alias root, is unchanged.
