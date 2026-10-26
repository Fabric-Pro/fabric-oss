# Prisma client and Zod generation

Generate the database client and schemas with the repository's pinned tools and dependency patch.

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

## CLI configuration and module format

Prisma ORM 7.10.1 reads [`prisma.config.ts`](../packages/database/prisma.config.ts)
from `packages/database`, including when `--schema=./prisma/schema.prisma` is
passed. Database commands require `DIRECT_URL`; the config rejects a missing
value instead of using the application's pooled `DATABASE_URL`. Generation can
run without either URL because it does not connect. Environment loading belongs
to the existing dotenv-wrapped scripts, not the Prisma config.

The `prisma-client` generator explicitly emits CommonJS-compatible source with
`moduleFormat = "cjs"`. The generation pipeline compiles it with
`module = "CommonJS"` so Node require, tsx, Next.js and worker consumers can
load the resulting JavaScript. The runtime uses the PostgreSQL driver adapter
and a WASM query compiler; it does not ship a native query-engine binary.

Prisma 7 migration commands do not generate the client automatically; run the
package generation command after changing the schema. `pnpm migrate` chains
these steps.

## Dependency patch

[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) and the lockfile bind
the patch to its installed dependency version:

| Dependency | Patch behavior |
|---|---|
| `prisma@7.10.1` | Advances an array index through the input-type graph queue in both bundled client generators, preserving traversal order without repeatedly shifting the queue. |

`prisma-zod-generator@3.3.1` includes supplied-DMMF reuse and its fallback
upstream, so it needs no repository patch. Its JSON configuration retains the
custom, single-file pure-model output. The post-generation repair preserves
scalar decimal validation and the existing JSON-string defaults for omitted
empty JSON fields; the dependency upgrade does not change those API results.

Install dependencies with pnpm so the patch applies. Direct generation with an
unpatched dependency does not exercise the repository's generation contract.

## Verify a generator dependency change

Run the installed-dependency regression tests from the repository root:

```bash
pnpm --filter @repo/database exec node --test scripts/__tests__/prisma-generation-queue.test.mjs scripts/__tests__/prisma-zod-dmmf.test.mjs scripts/__tests__/prisma-config.test.mjs
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
