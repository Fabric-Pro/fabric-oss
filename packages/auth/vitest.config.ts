import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["lib/__tests__/**/*.test.ts"],
		// Several suites drive Better Auth's real in-process request cycle
		// (`better-auth/test`): each case builds a fresh instance and runs a
		// sign-up/enrol/verify round trip, so they are CPU-bound and slow down
		// in step with whatever else shares the machine.
		testTimeout: 30000,
	},
});
