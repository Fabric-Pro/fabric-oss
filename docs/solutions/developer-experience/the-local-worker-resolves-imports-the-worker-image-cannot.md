---
title: "The local Temporal worker resolves imports the worker image cannot"
date: 2026-10-15
category: developer-experience
module: temporal worker dependencies
problem_type: developer_experience
component: development_workflow
severity: high
applies_when:
  - "Adding an import of a package to code in packages/temporal (activities, workflows, lib)"
  - "A worker change runs locally and in tests but has not been through the worker Docker image yet"
  - "Moving code that imports a package from apps/web or another workspace package into the worker"
tags: [temporal, worker, pnpm, tsx, node-path, docker, dependencies, esm, fizzy-2946]
related_components: [temporal, docker]
audience: Engineers adding imports to the Temporal worker
owner: Fabric platform
---

# The local Temporal worker resolves imports the worker image cannot

## Context

Planning the Proposal export (Fizzy #2946), a dependency check asked whether `docx`, `mermaid` and `beautiful-mermaid`, which only `apps/web` declares, could be imported from `packages/temporal`. Locally the answer looked like yes: a static `import ... from "docx"` in a worker file ran. In the worker image it fails at start-up.

The difference is how `tsx` is launched. Locally the worker starts through pnpm (`pnpm run worker:dev`, which Aspire runs too), so `tsx` comes from pnpm's generated bin shim. That shim exports `NODE_PATH` with the workspace's hoisted store, node_modules/.pnpm/node_modules, which holds a copy of nearly every package any workspace member installs. CommonJS resolution falls back to `NODE_PATH`, and `@repo/temporal` runs as CommonJS (its `package.json` has no `"type"`), so a bare import of a package only `apps/web` declares resolves.

The image does not go through that shim. `packages/temporal/Dockerfile` installs a global `tsx@4.19.2` and starts the worker with `CMD ["tsx", "src/worker.ts"]`, with no `NODE_PATH`; it also installs only the closure of `--filter @repo/temporal...`. The same import is `MODULE_NOT_FOUND` there.

## Guidance

- **Declare every package the worker imports in `packages/temporal/package.json`**, at the version the lockfile already resolves, even when it already "works" locally. A local run and the unit tests are not evidence that the image can load it.
- **Check resolution the way the image does**: from `packages/temporal`, with plain `node` and `NODE_PATH` unset (see Examples). Through the `tsx` shim the answer is misleading.
- **An ESM-only package also needs a dynamic `import()`.** Native `import()` ignores `NODE_PATH`, so an undeclared ESM-only package fails even locally once it is loaded that way; and a package whose `exports` has only an `import` condition (beautiful-mermaid 1.1.3, for example) cannot be loaded by a static import from this CommonJS package at all. Load it inside the activity with `await import()`, never from a module that `packages/temporal/src/activities/index.ts` reaches at start-up.
- A dependency added to `packages/temporal/package.json` changes `pnpm-lock.yaml`, and the image installs with `--frozen-lockfile`, so the lockfile goes in the same change. The `docker-build-check` workflow builds the image when the worker's package manifest changes; let it run before relying on the import.

## Why This Matters

The failure appears only after deploy: the worker container exits at start-up and every queue it serves stops, while local runs, unit tests and type-check all passed. Nothing in the source shows that a working import depended on the shell's environment.

## When to Apply

- Before importing any package in `packages/temporal` that its own `package.json` does not list.
- When an activity "just works" locally with a package another workspace member owns.
- When reviewing a worker change: compare new imports against `packages/temporal/package.json`.

## Examples

Checking from the worker package (`packages/temporal`), as the image would and as the shim does:

```bash
echo 'console.log(require.resolve("docx"))' > /tmp/resolve.cjs

# As the image resolves: plain node, no NODE_PATH
NODE_PATH= node /tmp/resolve.cjs      # MODULE_NOT_FOUND

# As `pnpm run worker:dev` resolves: the tsx bin shim adds NODE_PATH
pnpm exec tsx /tmp/resolve.cjs        # .../node_modules/.pnpm/docx@9.6.1/...
```

`pnpm exec node` alone does not reproduce the local behaviour: the `NODE_PATH` comes from the `tsx` shim, not from pnpm.
