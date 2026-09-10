# fabric-app

Meta-package that tracks the deployable Fabric application version. Not published to npm.

- **Audience**: Engineering team
- **Owner**: Engineering team

---

## Why this package exists

The Fabric application is a deployable composed of multiple services (Next.js web app, Temporal worker, LangGraph agents, MCP wrapper, etc.). None of those individually represents "the app's version" — but the deploy pipeline needs a single, monotonically-increasing version to tag releases (`v0.5.1`, `v0.5.2`, ...).

This package provides that version. It carries no code: only a `package.json` with the current app version. Changesets uses it to:

1. Track unreleased changes via `.changeset/*.md` files committed with PRs.
2. Bump this package's version on the "Version Packages" PR.
3. Generate `CHANGELOG.md` entries here.
4. Trigger the post-publish auto-tag step in `.github/workflows/release.yml` that pushes a `v<version>` git tag, which in turn fires `deploy-azure-container-apps.yml` for the prod release.

Because the package is `"private": true`, `.changeset/config.json` opts it into versioning explicitly (`"privatePackages": { "version": true, "tag": false }`). Changesets CLI v3 skips private packages by default, which would leave every Version PR without a `fabric-app` bump — and so without a deploy tag — while CI stayed green. `tag: false` keeps changesets from creating `fabric-app@<version>` tags of its own; the `v<version>` deploy tag comes from `release.yml`.

## How to add a changelog entry

From the repo root, with your PR branch checked out:

```bash
pnpm changeset
```

The interactive prompt lets you select `fabric-app` (or an affected published
package), choose a semver bump level, and write a short description. Commit the
generated `.changeset/<random-name>.md` file with your PR.

Do not declare internal `@repo/*` workspace packages. Changesets cascades their
version changes through workspace dependents, creating a noisy release PR
without affecting deployment. Production-shipping changes normally declare:

```markdown
---
"fabric-app": patch
---

Describe the user-visible result in one complete sentence.
```

Add a public `@fabricorg/*` package only when that package itself is being
released. Use `minor` or `major` when the compatibility impact requires it.

The first body paragraph becomes public CHANGELOG text. Keep it specific and
free of ticket numbers, private context, internal hostnames, and real customer
identifiers. Put any safe engineering rationale after a blank line.

## Prove the release decision

Before the first push and after every later revision, run:

```bash
pnpm exec changeset status --since=origin/master --output=/tmp/changeset-status.json
jq '.releases | length' /tmp/changeset-status.json
```

An exit code of zero is insufficient: Changesets also exits zero when the JSON
contains `"releases": []`. An impacting PR must have at least one release.

Docs-only, CI-only, Markdown-only, and pure changeset edits are normally
non-impacting. Do not create meaningless release notes for them; apply the
`skip-changeset` label and state the no-impact reason in the PR. A different
change may skip only when it genuinely has no deployable or user-visible
effect. Omitting both a changeset and the label is never an explicit decision.

See `docs/deployment.md` § Release Strategy for the full release flow.
