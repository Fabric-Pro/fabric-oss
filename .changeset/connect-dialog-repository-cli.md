---
"fabric-app": patch
---

The Coding Instructions tab's "Connect your agent" dialog now offers the CLI setup for repository-sourced projects too: clone the repository, sign in, and run `fabric instructions init` in the checkout to install the session-start hook that reports newer published instructions.

Fizzy #2721. `fabric instructions init` already worked inside a checkout of a repository-sourced project (Fizzy #2708): it installs the session-start hook and copies nothing, since the developer's own `git pull` keeps the checkout current. The "Connect your agent" dialog still hid the whole CLI route for such a project, a gate written back when the CLI refused it outright.

`ConnectCliDialog` takes a `localSetup: LocalSetupRoute | null` prop in place of the old `localSyncAvailable` boolean: `{ kind: "upload" }` for a project whose instructions Fabric authors (unchanged behavior, including the `--apply` checkbox), `{ kind: "repository", cloneUrl, directory, ref, rootPath }` for a repository-sourced project with a configured sync, and `null` when neither is resolvable yet. The repository variant prints `git clone`, `cd`, install, sign-in and `fabric instructions init` — never `--apply`, since automatic updates are not available for repository checkouts yet. `localSetupRouteFor`, `cloneDirectoryName` and `quoteShellArgIfNeeded` in `apps/web/modules/saas/projects/lib/instructions-repository-sync.ts` compute the route and its commands so the Coding Instructions tab's published view and empty state agree.

The `repositorySync.get` procedure now forwards the sync's `repositoryUrl` (the canonical, credential-free clone URL `parseRepoUrl` already guarantees) so the dialog has something to clone.
