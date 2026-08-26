import { defineConfig } from "vitest/config";

// Dedicated config for running the audit-log perf smoke against a real
// Postgres. Run with:
//   DATABASE_URL=... npx vitest run --config ./vitest.perf.config.ts \
//     __tests__/audit-log-perf-smoke.test.ts

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["__tests__/audit-log-perf-smoke.test.ts"],
		testTimeout: 180_000,
	},
});
