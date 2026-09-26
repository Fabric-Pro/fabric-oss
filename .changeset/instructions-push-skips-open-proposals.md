---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

`fabric instructions push` no longer sends a change again when one of your open proposals already carries it, listing each file it leaves out with that proposal's version and pull request, and a new `--include-proposed` flag sends them anyway.

The skip takes effect once the Fabric server supports the open-proposals lookup (`GET /api/v1/projects/:projectId/instructions/proposals/open`); until then `push` warns that it could not check and sends every change as before. A change counts as already proposed only when the same path with the same content (or the same deletion) is in one of your own proposals that is stated against the published version, whose checks are running or passed, and whose pull request, on a repository-sourced project, is queued, opening or open. `--publish` follows the same rule, so a change waiting for review is not published around that review. A push whose every change is already proposed sends nothing and exits 0; the same case under `--publish` exits 7. `--dry-run` and `--format json` report what was left out. The SDK adds `instructions.getOpenProposals`.
