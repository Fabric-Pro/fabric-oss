import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		testTimeout: 10000,
		pool: "forks",
		// Vitest 4 removed `poolOptions`; `forks.singleFork: true` → `maxWorkers: 1`
		// on the forks pool (isolate stays at its default true).
		maxWorkers: 1,
	},
});
