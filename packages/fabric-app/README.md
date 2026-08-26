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

## How to add a changelog entry

From the repo root, with your PR branch checked out:

```bash
pnpm changeset
```

The interactive prompt will let you select `fabric-app` (or any other affected package), choose a semver bump level, and write a short description. Commit the generated `.changeset/<random-name>.md` file with your PR.

For tooling-only / docs-only PRs, label the PR with `skip-changeset` to bypass the CI check.

See `docs/deployment.md` § Release Strategy for the full release flow.
