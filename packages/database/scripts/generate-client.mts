/**
 * Generate the Prisma client + zod schemas, then compile the generated client to
 * .js + .d.ts so consumers type-check against declarations instead of ~47MB of
 * source. See prisma/tsconfig.generated.json for the full rationale.
 *
 * Pipeline (each step must succeed; execSync throws on non-zero exit):
 *   1. clean prisma/generated  (Prisma refuses to write into a non-empty dir that
 *      no longer "looks like" a generated client — e.g. a prior run's .js/.d.ts)
 *   2. prisma generate         (emits the client + zod .ts via schema.prisma generators)
 *   3. fix-zod-imports         (existing zod post-processing)
 *   4. tsc                     (generated/**.ts -> .js + .d.ts, in place)
 *   5. strip .ts source        (keep .js runtime + .d.ts types)
 *
 * prisma/zod is intentionally left as committed .ts source: it is a single ~8k-line
 * file (negligible for type-check) and is tracked in git, not gitignored like
 * prisma/generated.
 */
import { execSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/lib/tsc.js");
const run = (cmd: string) => execSync(cmd, { stdio: "inherit" });

// 1. Start from a clean generated dir.
rmSync("prisma/generated", { recursive: true, force: true });

// 2. Generate the Prisma client (.ts) and zod schemas.
run("prisma generate --no-hints --schema=./prisma/schema.prisma");

// 3. Existing zod import fixups.
run("tsx ./scripts/fix-zod-imports.ts");

// 4. Compile the self-contained generated client to .js + .d.ts (the memory fix).
run(`node "${tsc}" -p prisma/tsconfig.generated.json`);

// 5. Drop the now-redundant .ts source; keep the compiled .js and .d.ts.
const stripTsSource = (dir: string): void => {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			stripTsSource(full);
		} else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
			rmSync(full);
		}
	}
};
stripTsSource("prisma/generated");
