import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Stub out CSS files that are imported from inlined node_modules (e.g.
 * katex.min.css pulled in by streamdown's math-rendering path).  Vitest's
 * jsdom environment has no CSS parser, so these imports fail with
 * "Unknown file extension .css".  Returning an empty ES module is enough
 * to let the component render — the visual styles are irrelevant in tests.
 *
 * NOTE: not annotated with `Plugin` from "vite" because `vite` is not a
 * direct dependency of apps/web (it comes in transitively via vitest), and
 * the production `next build` runs `tsc --noEmit` over EVERY .ts in the
 * package — including this config — which would fail with
 * "Cannot find module 'vite'". The structural shape is enough for vitest;
 * Vite's plugin runner duck-types this object.
 */
function cssStubPlugin() {
	return {
		name: "vitest-css-stub",
		enforce: "pre" as const,
		resolveId(id: string) {
			// Only stub CSS side-effect imports from node_modules
			// (e.g., streamdown -> katex/dist/katex.min.css). App-local CSS
			// imports should remain real so component tests can assert on them.
			if (id.endsWith(".css") && id.includes("node_modules")) {
				return `\0vitest-css-stub:${id}`;
			}
			return null;
		},
		load(id: string) {
			if (id.startsWith("\0vitest-css-stub:")) {
				return "export default {};";
			}
			return null;
		},
	};
}

export default defineConfig({
	plugins: [cssStubPlugin(), react()],
	test: {
		environment: "jsdom",
		setupFiles: ["./vitest.setup.ts"],
		globals: true,
		testTimeout: 10000,
		server: {
			deps: {
				// streamdown imports katex/dist/katex.min.css as a side-effect;
				// inlining both lets the cssStubPlugin intercept the CSS import
				// before Node's ESM loader sees the unknown .css extension.
				inline: ["katex", "streamdown"],
			},
		},
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"tests/**", // Playwright E2E tests
		],
		// Force-exit hack — see vitest.global-teardown.ts. Insurance for
		// transitively-loaded modules that hold open handles past tests.
		globalSetup: ["./vitest.global-teardown.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules/",
				"tests/", // E2E tests
				"**/*.config.*",
				"**/*.setup.*",
				".next/",
				"coverage/",
			],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 80,
				statements: 80,
			},
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./"),
			"@shared": path.resolve(__dirname, "./modules/shared"),
			"@saas": path.resolve(__dirname, "./modules/saas"),
			"@marketing": path.resolve(__dirname, "./modules/marketing"),
			"@ui": path.resolve(__dirname, "./modules/ui"),
			"@i18n": path.resolve(__dirname, "./modules/i18n"),
			"@analytics": path.resolve(__dirname, "./modules/analytics"),
		},
	},
});
