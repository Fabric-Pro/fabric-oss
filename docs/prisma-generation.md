# Prisma client and Zod generation

Generate the database client and schemas with the repository's pinned tools and patches.

- **Audience**: engineers changing the Prisma schema, generators or database builds
- **Owner**: Engineering team

## Generate from the repository root

```bash
pnpm --filter @repo/database generate
```

The package command runs
[`generate-client.mts`](../packages/database/scripts/generate-client.mts). It
rebuilds `packages/database/prisma/generated`, generates the Prisma client and
Zod schemas, fixes Zod imports, then compiles the generated client to JavaScript
and declaration files. It removes the generated client's redundant TypeScript
source after compilation. `prisma/zod` remains tracked TypeScript source.

Each stage must succeed before the next starts. Prisma and its child generators
receive a 6144 MiB Node heap ceiling through `NODE_OPTIONS`; the TypeScript
compilation receives the same ceiling explicitly. The ceiling limits heap use
and does not reserve that memory. Generation writes build artifacts and does not
apply database migrations.

## Dependency patches

[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) and the lockfile bind these
patches to their installed dependency versions:

| Dependency | Patch behavior |
|---|---|
| `prisma@6.19.3` | Advances an array index through the input-type graph queue in both bundled client generators, preserving traversal order without repeatedly shifting the queue. |
| `prisma-zod-generator@1.31.2` | Reuses `options.dmmf` supplied by Prisma and retains `getDMMF` as a fallback when it is absent. |

Install dependencies with pnpm so the patches apply. Direct generation with an
unpatched dependency does not exercise the repository's generation contract.

## Verify a generator dependency change

Run the installed-dependency regression tests from the repository root:

```bash
pnpm --filter @repo/database exec node --test scripts/__tests__/prisma-generation-queue.test.mjs scripts/__tests__/prisma-zod-dmmf.test.mjs
```

The Prisma tests exercise both bundled graph walkers with cycles, field
references, model-source metadata and cache reuse. They reject queue shifts. The
Zod tests check supplied-DMMF reuse and the fallback. These tests resolve the
installed packages from `packages/database`; moving them to a package without
those dependencies changes what they can load.

After changing a generator version or patch, review the patch against the new
installed source, run these tests and the full generation command, then run the
affected consumers' typechecks. A passing patch test alone does not establish
that the complete schema generates or that downstream packages compile.
