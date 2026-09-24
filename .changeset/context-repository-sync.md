---
"@fabricorg/cli": patch
"fabric-app": patch
---

A project's Living Memory can now be synced from selected folders and files of a repository connected to the project: Sync from repository picks the repository, a branch and the paths to read, checks that the branch and paths exist, and Sync now reads them again at the branch's current commit, creates, updates and removes knowledge files to match, and reports what it kept, what it skipped and why.

Files a repository sync manages are labelled in the Context tab and can only be changed in the repository: editing them in Fabric, pushing over them from the CLI or the MCP tools, and deleting them from the tab are refused with a message naming the sync, while ordinary synced files keep working as before. A folder's `.contextignore` file leaves paths out the same way the CLI's does, a file the sync cannot read protects the folder it is in instead of removing its knowledge, and disconnecting the repository integration keeps every synced file as an ordinary one. `fabric context push` recognizes files a Living Memory repository sync owns, reports them as skipped instead of failing, and never retries them with `--force`.
