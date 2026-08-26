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
	],
	// Node ESM bundles can't `require()` — some transitive CJS deps call require()
	// at runtime (e.g. whatwg-url, pulled via node-fetch → openai → @langchain/core,
	// does `require("punycode")`). Without this shim the container crash-loops on boot
	// with `Dynamic require of "punycode" is not supported`. Same fix used in
	// packages/cli and packages/mcp-server tsup configs.
	banner: {
		js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
	},
	clean: true,
	sourcemap: true,
});
