import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["unified-server.ts"],
	format: ["esm"],
	target: "node20",
	outDir: "dist",
	// Bundle workspace packages to avoid symlink issues in Docker and CI validation
	noExternal: [
		// Workspace packages - must be bundled for Docker and CI validation
		/^@repo\//,
	],
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
		// MCP SDK has subpath imports that esbuild can't resolve
		/^@modelcontextprotocol\//,
		// CopilotKit has optional peer deps (langchain) with subpaths esbuild can't resolve
		/^@copilotkit\//,
		// @langchain/community is an optional peer dep of CopilotKit - not installed
		/^@langchain\/community/,
		// undici uses CJS require("assert") which breaks in ESM bundles
		"undici",
		// nunjucks (transitively via @repo/utils → template-renderer) is CJS with
		// dynamic require() of Node builtins (events) which esbuild cannot statically
		// resolve when bundled into ESM — must be loaded from node_modules
		"nunjucks",
		// stripe (transitively via @repo/ai → @repo/payments) ships CJS with dynamic
		// require() chains (qs → side-channel → object-inspect → require("util")) that
		// crash when esbuild emits __commonJS shims into ESM. Load from node_modules.
		"stripe",
	],
	// Clean output directory before build
	clean: true,
	// Generate sourcemaps for debugging
	sourcemap: true,
});
