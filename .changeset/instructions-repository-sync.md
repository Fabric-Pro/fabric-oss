---
"fabric-app": patch
---

A project's coding instructions can now be synced from a branch and folder of a repository connected to the project: Sync from repository checks that the branch exists, reads the files, runs the same secret scan an upload gets and publishes them as a new version, and Sync now reads the branch again and publishes only when something changed.

While a repository is the source, the files are edited there: editing in Fabric and pushing from the CLI stay off, a rejected sync points at the files to fix in the repository, History lists every sync run, and the Settings dialog can switch the project back to uploads at any time, including after the repository is disconnected. Repositories laid out with top-level `Rules/`, `Skills/`, `Agents/`, `Knowledge/`, `Lessons/`, `UserPreferences/`, `Mcp/` and `Env/` folders are classified by those folders, and `.guild/` is always left out.
