import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/harness/**/*.test.ts"],
		testTimeout: 20000,
		hookTimeout: 20000,
	},
});
