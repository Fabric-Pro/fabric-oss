---
"fabric-app": patch
---

Refresh four pinned GitHub Actions and raise the postcss and uuid floors, collapsing four postcss copies onto one

Four action pins move to their current releases, each SHA verified against the tag it claims:
`actions/checkout` v7.0.0 → v7.0.1 (35 sites), `actions/attest-build-provenance` v4.1.1 → v4.2.2 (3),
`actions/download-artifact` v7.0.0 → v8.0.1 (2) and `dorny/paths-filter` v4.0.2 → v4.0.3 (5).

`download-artifact` v8 is a major: it moves to ESM, stops unzipping responses whose Content-Type is not a
zip archive, and now fails rather than warns on a download digest mismatch. Both call sites pass only
`name`/`pattern`/`path`/`merge-multiple`, all still accepted, and both consume artifacts written by
`upload-artifact`, so the decompression path is unchanged; the digest default is a hardening.

On the npm side the effective floors live in the root `pnpm.overrides` table, not in the workspace
manifests. An override keyed `postcss@^8.0.0` rewrites every declared range, so `apps/web` recorded an
effective specifier of `^8.5.12` whatever its own manifest said — meaning a manifest-only bump there
resolves to nothing. Raising the override to `^8.5.26` is what actually moves the tree, and it collapses
postcss 8.5.21 / 8.5.23 / 8.5.25 / 8.5.26 onto a single 8.5.26, retiring the 8.5.21 copies that sat below
the 8.5.23 floor of GHSA-fxqj-rqcc-2cmp. `uuid` has no override on the 14.x line, so its move to ^14.0.2
is a plain manifest change across the eleven packages that declare it.

The regeneration also absorbs pre-existing lockfile drift: a stale importer for `apps/autofabric`, a
directory never tracked in git, and with it the last references to next 15.5.21, the nine @next/swc-*
15.5.21 binaries and lucide-react 0.511.0. That drift is not caused by these bumps — `pnpm install
--lockfile-only` against unmodified master produces 194 of those deletions on its own.

Deliberately excluded: `changesets/action` v1 → v2.1.1. v2 renames every input the release workflow passes
(`version`, `publish`, `commit`, `title`, `createGithubReleases`) and stops honouring `GITHUB_TOKEN` from
the environment in favour of an explicit `github-token` input. That is an input migration on the release
path rather than a pin bump, and it belongs in its own change.
