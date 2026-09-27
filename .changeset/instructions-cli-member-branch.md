---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

`fabric instructions push` on a repository-backed project now reports the member's own pull request: it prints "Opened pull request <url>" for the branch's first change, "Added to your pull request <url>" for a later one, and "Already on your branch; nothing to add." when every file already matched.

It waits until the branch's pull request is open rather than stopping when the change reaches the branch, names the files when a change conflicts with an edit made on the branch outside Fabric or with a newer change, and exits 7 for those. `--format json` now includes the `branch` and `append` blocks.
