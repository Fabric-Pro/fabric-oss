import { defineConfig } from "vitest/config";

// Cold-cache vitest first run can spend 10s+ on TS transform of these tests
// (swagger-parser pulls in a large dependency graph), so the default 5s
// timeout flakes in CI. Subsequent runs complete in milliseconds.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		testTimeout: 15000,
	},
});
