import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Model selection tests do vi.resetModules() + dynamic import on every test.
		// The first import in a cold CI runner can exceed the default 5 s threshold.
		testTimeout: 15000,
	},
});
