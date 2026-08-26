import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	target: "node20",
	outDir: "dist",
	// Bundle workspace packages to avoid symlink issues in Docker
	noExternal: [/^@repo\//],
	// Keep these packages external - resolved from node_modules at runtime
	external: [
		"@repo/database",
		"@repo/ai",
		"@repo/observability",
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
	clean: true,
	sourcemap: true,
});
