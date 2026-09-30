---
"fabric-app": patch
---

Coding instructions can now retry a version whose checks could not finish, including in repository mode, and a failed sync names the limit it hit.

The "We could not finish checking this upload" banner offered no button for a repository-backed project even though its copy told the viewer to retry. It now shows "Retry checks" (finalize on the failed version, same workflow id, no new sync or version) when the viewer can edit and the failed version matches the project's source, and its copy says the checks broke rather than blaming the files or the folder limits, that nothing was published and which version stays published. A version that no longer matches the project's source (an upload in a repository-backed project, or a synced version after sync was switched off) gets a stale-version explanation instead of a dead button, and only a viewer who cannot edit is told to ask someone else.

A LIMITS_EXCEEDED sync run used to print all three folder limits whichever one it hit. The run now stores a numbers-only `limitDetail` (kind, max, actual): file count, largest file, full total, inventory size, or download size (the git disk budget for the clone, its listing and the checkout, which a large repository can hit even for a small folder). `measure()` sizes every file before judging so the actual values are complete. No path, URL or stderr is recorded. Runs recorded before the column existed keep the old three-limit wording. CHILD_ABORTED names the staged version and says it was not a folder-limit problem.

Migration: adds nullable `limitDetail` JSONB to `project_instruction_repository_sync_run`. Workflow change is data-only (carries the detail into the existing record activity input); no activity, timer or child call added or reordered.
