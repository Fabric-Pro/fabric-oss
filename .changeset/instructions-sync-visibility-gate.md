---
"fabric-app": patch
---

Coding Instructions repository sync and change proposals now answer "Project not found" to an organization member who cannot see the project, instead of showing or changing its sync or its proposals.

Every coding-instructions repository-sync call (the sync state, its run history, configure, sync now, switch back to upload mode, and the pull-request proposal setting) and every proposal call (list, view, approve, reject, cancel, and the pull-request status, refresh and retry) checks project visibility before permission, as Living Memory's repository sync already does. Previously an organization role alone was enough, so a member with no access to the project could read which repository, branch and folder it syncs from and the pull requests its proposals opened, and with the matching permission act on them.
