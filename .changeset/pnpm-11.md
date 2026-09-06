---
"fabric-app": patch
---

Migrate the toolchain to pnpm 11 and move pnpm settings from package.json/.npmrc into pnpm-workspace.yaml

pnpm 11 stops reading the `pnpm` key out of `package.json` and restricts `.npmrc`
to auth/registry keys, so the pin bump and the config move have to land together:
bumping the pin alone would have silently dropped all 89 advisory overrides, the
build-script allow list and every public-hoist pattern, with no warning and no
lockfile change to notice it by.

What moved, into `pnpm-workspace.yaml` (the `packages:` block is untouched):

- `package.json#pnpm.overrides` -> `overrides:`, verbatim — same 89 keys, same
  values, same order.
- `package.json#pnpm.onlyBuiltDependencies` (3) + `ignoredBuiltDependencies` (21)
  -> one `allowBuilds:` map, `true` for the former and `false` for the latter.
- `.npmrc`'s 8 `public-hoist-pattern[]` entries -> `publicHoistPattern:`, with the
  comment block explaining the Turbopack-trace workaround carried over. `.npmrc`
  held nothing else, so it is deleted.

Two pnpm 11 defaults are overridden explicitly, each with a comment at the setting:

- `minimumReleaseAge: 0` — pnpm 11 defaults to 1440 (a 24h quarantine on freshly
  published versions). This change is a config move and must not alter what
  resolves; whether to adopt a delay, and with which window and exclusions, is a
  separate policy decision on Fizzy #2419.
- `verifyDepsBeforeRun: false` — pnpm 11 defaults to `install`, which runs an
  install before `pnpm run` / `pnpm exec` whenever it judges node_modules stale.
  Shipped images run pnpm scripts as a non-root user with no build toolchain over
  a filtered install (`packages/database/Dockerfile.migrate` ends with
  `CMD ["pnpm","promote"]`), so an implicit install at container start would be an
  outage, not a convenience.

`strictDepBuilds` and `blockExoticSubdeps` (both now true) are accepted at their
new defaults: a pnpm 10 install printed no ignored-build-scripts warning, so every
dependency with build scripts is already in one of the two lists, and the lockfile
carries zero git/tarball resolutions.

Pins bumped to 11.25.0: root `packageManager`, `apps/web/Dockerfile`,
`packages/database/Dockerfile.migrate` (x2), `packages/temporal/Dockerfile` (x2),
and both `npm install -g` lines in each of the 12 `agents/langchain/*/Dockerfile`.
Three extra pins the ticket's list missed: `packages/mcp-stdio-wrapper/Dockerfile`
floats on a major (`corepack prepare pnpm@10`) in three stages, now `pnpm@11`.
Docs updated in `CLAUDE.md`, `AGENTS.md` (both the stack table and the command
reference), `README.md` and `fabric/standards/global/tech-stack.md`.

Deleting `.npmrc` also required dropping it from every `COPY` that named it. The
ticket recorded that only `apps/web/Dockerfile` copied it; in fact all 12 agent
Dockerfiles copy it twice each (builder and runtime stage) — 24 further lines that
would have failed the image build on a missing COPY source. `apps/web`'s adjacent
comment, which explained why `.npmrc` was required, now points at
`pnpm-workspace.yaml`'s `publicHoistPattern` instead.

`.github/workflows/docker-build-check.yml` gains `pnpm-workspace.yaml` in its path
filter: that gate exists because a missing entry in the build-script allow list
left Chromium undownloaded, and that list now lives in the workspace file.
`package.json` stays in the filter for the version pin and the root dependencies.

Proof, in this checkout on pnpm 11.25.0: `pnpm install --frozen-lockfile` exits 0
and leaves `pnpm-lock.yaml` byte-identical (lockfile v9.0 is retained by pnpm 11,
and the install would have failed on unreviewed build scripts had `allowBuilds`
not been read); `pnpm --filter @repo/database generate` confirms the prisma build
script still runs under `allowBuilds`; `pnpm knip` from the repo root exits 0.
(Biome lints none of the touched files — `biome.json` excludes `**/package.json`,
and the rest are Dockerfiles and Markdown.) A parity script diffed
`git show master:package.json`'s
`pnpm` block and `master:.npmrc` against the new YAML entry-by-entry — override
count/order/values, `allowBuilds` membership, and hoist-pattern order all match.

Fizzy #2420.
