---
"fabric-app": patch
"@fabricorg/sdk": patch
---

Suggestions to coding instructions on a repository-backed project now collect on one branch and pull request per member instead of opening a pull request each.

A member's first suggestion creates their branch, `fabric/instructions/members/<name>-<id>/<n>`, and opens one pull request; each later suggestion is appended to it as one commit until that pull request merges or closes, and the next suggestion then starts a new branch. Re-sending a change that is already on the branch is reported as "Already on your branch; nothing to add" instead of opening a second pull request.

Fabric never overwrites a file that was changed on the branch outside Fabric while its pull request is open, and never deletes a branch carrying commits it did not push. Withdrawing a suggestion that is already on the branch adds a commit restoring its files, or closes the pull request when it was the branch's last change. The Coding Instructions tab shows the member's branch and pull request with Close, Retry opening, Start over and Stop tracking, and the editor opens a file's branch version when Fabric holds it.

Proposal pull-request views, including REST v1 and the SDK's `ProposalPullRequest`, gain `branch` and `append` blocks, and `GET /api/v1/projects/:projectId/instructions/proposals/open` lists a caller's pending suggestions with per-path hashes so a client can skip re-sending a change already on its way to review. Suggestions admitted before this release finish on the previous one-pull-request-per-suggestion path.
