# Changelog

Index of changelogs across the Fabric monorepo.

- **Audience**: All developers and downstream consumers
- **Owner**: Engineering team

---

Changelogs are managed by [changesets](https://github.com/changesets/changesets) and live alongside each package they describe.

## Application

- **Deployable application:** [`packages/fabric-app/CHANGELOG.md`](packages/fabric-app/CHANGELOG.md) — source of truth for "what is in production." Tagged as `v<version>`; pushing the tag fires the production deployment pipeline.

## Published npm packages

- [`@fabricorg/mcp-server`](packages/mcp-server/CHANGELOG.md)
- [`@fabricorg/sdk`](packages/sdk/CHANGELOG.md)
- [`@fabricorg/cli`](packages/cli/CHANGELOG.md)
- [`@fabricorg/integrations-github`](packages/integrations-github/CHANGELOG.md)
- [`@fabricorg/integrations-gmail`](packages/integrations-gmail/CHANGELOG.md)
- [`@fabricorg/integrations-linear`](packages/integrations-linear/CHANGELOG.md)
- [`@fabricorg/integrations-notion`](packages/integrations-notion/CHANGELOG.md)
- [`@fabricorg/integrations-runtime`](packages/integrations-runtime/CHANGELOG.md)

(Per-package changelogs are created on first release. Links resolve to "not found" until then.)

## How releases work

See [`docs/deployment.md` § Release Strategy](docs/deployment.md#release-strategy) for the end-to-end flow:

1. Each PR includes a `.changeset/*.md` file describing the change (run `pnpm changeset` to create one interactively).
2. On merge to `master`, the [changesets bot](https://github.com/changesets/action) opens (or updates) a "Version Packages" PR that collates every unreleased changeset into version bumps + CHANGELOG updates.
3. Merging the "Version Packages" PR bumps versions, writes per-package `CHANGELOG.md` updates, and (for `fabric-app`) auto-pushes a `v<version>` git tag that fires the prod deploy.

For tooling-only / docs-only PRs, apply the `skip-changeset` label to bypass the CI check.

## Versioning

The Fabric application and each published npm package adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
