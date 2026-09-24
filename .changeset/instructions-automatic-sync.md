---
"fabric-app": patch
"@fabricorg/cli": minor
---

Coding instructions synced from a repository now stay current on their own: Fabric picks up a pushed change right after each push to GitHub, and otherwise normally 15 to 20 minutes after a push (longer while the poll works through a backlog or a sync is backing off after failures), publishes a new version only when the files changed, and pauses with a message in the tab if the branch is deleted or the member it publishes as can no longer publish.

Automatic runs publish as the member who last configured the sync, and a toggle in the tab's Settings turns them off. History and the status line show whether a run came from Sync now, the schedule or a push, and a failed fetch says it will be retried. On the command line, `fabric instructions sync` no longer overwrites a local edit to a synced file: it keeps the edit, lists it (in one stderr line when run from a session hook), and `fabric instructions sync --repair` restores the published version. A `fabric.environment.json` at the root of an instruction set is now classified as a settings file.
