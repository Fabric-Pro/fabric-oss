import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/telemetry.ts"],
	format: ["esm"],
	target: "node20",
	outDir: "dist",
	// Bundle workspace packages to avoid symlink issues in Docker
	noExternal: [/^@repo\//],
	// Keep these packages external - resolved from node_modules at runtime
	external: [
		"@repo/database",
		"@repo/ai",
		"pg",
		"@prisma/adapter-pg",
		"@prisma/client",
		/^@opentelemetry\//,
		"prom-client",
		// CopilotKit has optional peer deps (langchain) with subpaths esbuild can't resolve
		/^@copilotkit\//,
		// @langchain/community is an optional peer dep of CopilotKit - not installed
		/^@langchain\/community/,
		// undici uses CJS require("assert") which breaks in ESM bundles
		"undici",
		// nunjucks is CJS with dynamic require() of Node builtins (events) which esbuild
		// cannot statically resolve when bundled into ESM — must be loaded from node_modules
		"nunjucks",
		// stripe (pulled in transitively via @repo/ai → @repo/payments) ships CJS with
		// dynamic require() chains (qs → side-channel → object-inspect → require("util"))
		// that crash when esbuild emits __commonJS shims into ESM. Load from node_modules.
		"stripe",
	],
	// Node ESM bundles have no `require()`, so any inlined CommonJS dependency that
	// calls require() at runtime — yaml (via @repo/utils) does `require("process")`
	// in its composer — crashes at load with `Dynamic require of "..." is not
	// supported`. The externals above were added one at a time as each such
	// dependency surfaced; this banner gives the bundle a real `require` so the
	// whole class is covered. Same fix as weave-planners. The load-time smoke test
	// in src/dist-smoke.test.ts guards this.
	banner: {
		js: "import { createRequire as __fabricCreateRequire } from 'module'; const require = __fabricCreateRequire(import.meta.url);",
	},
	clean: true,
	sourcemap: true,
});
