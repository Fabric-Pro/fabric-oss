---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

Suggesting a change to coding instructions on a repository-backed project now opens a pull request in the connected repository.

Instruction upload retention now also prunes READY and FAILED uploads whose rejection is unset; before, a null rejection left those uploads out of retention, so they were never pruned.
