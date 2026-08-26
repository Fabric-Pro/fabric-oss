import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,
		setupFiles: ["tests/setup.ts"],
		include: [
			"tests/**/*.test.ts",
			"tests/**/*.test.tsx",
			"__tests__/**/*.test.ts",
		],
		clearMocks: true,
		restoreMocks: true,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
		},
	},
});
