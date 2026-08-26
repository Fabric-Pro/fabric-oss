import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["unified-server.ts"],
	format: ["esm"],
	target: "node20",
	outDir: "dist",
	// Bundle workspace packages to avoid symlink issues in Docker
	noExternal: [/^@repo\//],
	// Keep these packages external - resolved from node_modules at runtime
	external: [
		// Database packages - agents should be stateless and database-agnostic
		"@repo/database",
		// AI package has database imports for dynamic model selection
		"@repo/ai",
		// Observability package imports OpenTelemetry which has CJS/ESM interop issues
		"@repo/observability",
		// Database packages that use dynamic require() - must be external
		"pg",
		"@prisma/adapter-pg",
		"@prisma/client",
		// OpenTelemetry uses Node.js core modules (async_hooks) - must be external
		/^@opentelemetry\//,
		// prom-client uses dynamic require of Node.js core modules - must be external
		"prom-client",
		// CopilotKit has optional peer deps (langchain) with subpaths esbuild can't resolve
		/^@copilotkit\//,
		// @langchain/community is an optional peer dep of CopilotKit - not installed
		/^@langchain\/community/,
		// undici uses CJS require("assert") which breaks in ESM bundles
		"undici",
	],
	clean: true,
	sourcemap: true,
});
