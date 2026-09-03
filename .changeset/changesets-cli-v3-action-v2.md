---
"fabric-app": patch
---

Migrate the release pipeline to Changesets CLI v3 and changesets/action v2.

Coordinated migration so the Dependabot changesets/action v1→v2 bump can stop
being rejected (Fizzy #2366). Bumps @changesets/cli ^2.31.0 → ^3.0.1 (root
package.json and the separate pin in changeset-check.yml), pins
changesets/action at v2.1.1, renames every action input to the v2 schema, and
passes the release App token through the github-token input instead of the
GITHUB_TOKEN env var, which v2 no longer honours. Release changes now go
through the GitHub API (v2's default), so the Version PR commit, package tags
and GitHub releases are created as the release App and signed by GitHub; the
core.hooksPath workaround only existed for the local git commit and is
removed. .changeset/config.json opts private packages into versioning
(privatePackages.version) because CLI v3 stops versioning them by default,
which would have left every Version PR without a fabric-app bump. The
CHANGESETS_OUTPUT file the action uses for publish detection is inherited by
`pnpm release` automatically; a new positive-control step fails the run if a
public package's version changed on master without its tag appearing.
