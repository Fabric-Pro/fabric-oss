import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		testTimeout: 10000,
		pool: "forks",
		// Mirrors packages/sdk: Vitest 4 removed `poolOptions`, and
		// `forks.singleFork: true` is now `maxWorkers: 1` on the forks pool.
		// These tests write into real temp directories, so one worker also
		// keeps the filesystem assertions independent of scheduling.
		maxWorkers: 1,
	},
});
