import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			// Exclude the manual test files that use tsx directly
			"test-rag.ts",
			"lib/chunking/tokenizer.test.ts",
			"lib/chunking/semantic.test.ts",
		],
		// downscale-image tests resize 6MB images via sharp (~2.5s each on a
		// warm CPU). Default 5s is tight; 15s gives headroom without letting
		// a truly hung test block CI for long.
		testTimeout: 15000,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["lib/**/*.ts"],
			exclude: ["**/__tests__/**", "**/*.test.ts"],
		},
	},
});
