#!/usr/bin/env node
// TypeScript 7's native compiler, run as `tsgo` so every package's
// `type-check` script can use it while the repo-wide `typescript` stays on
// 5.9. TypeScript 7.0 ships no JavaScript compiler API, and Next.js, tsup,
// knip and the tests that `import ts from "typescript"` still need one.
//
// Installing 7.x under its own `tsc` bin name would take over
// node_modules/.bin/tsc, which `next build` and the editors run, so this
// package keeps it out of the root: its typescript dependency resolves from
// tooling/tsgo/node_modules, and only the `tsgo` name is linked to the root.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("typescript/package.json");
const { version } = require(manifestPath);

// Resolution falls back to the root node_modules when this package's own
// install is missing, and 5.x also ships lib/tsc.js, so without this check a
// partial install would type-check with the wrong compiler and still pass.
if (!version.startsWith("7.")) {
	process.stderr.write(
		`tsgo: expected TypeScript 7 but resolved ${version} from ${manifestPath}. Run \`pnpm install --frozen-lockfile\` and retry.\n`,
	);
	process.exit(1);
}

await import(pathToFileURL(join(dirname(manifestPath), "lib/tsc.js")).href);
