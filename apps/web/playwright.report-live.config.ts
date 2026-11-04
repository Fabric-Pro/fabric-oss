import { defineConfig } from "@playwright/test";

/** An opt-in live qualification against existing loopback services; never boots a server. */
export default defineConfig({
	testDir: "./tests/e2e/reports",
	testMatch: "project-knowledge-live.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir: "test-results/report-live",
	use: {
		baseURL: process.env.FABRIC_REPORT_E2E_URL ?? "http://localhost:3032",
		headless: true,
		viewport: { width: 1440, height: 1000 },
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? {
					executablePath:
						process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
				}
			: undefined,
		// Keep credentials/request payloads out of automatic trace/video artifacts.
		trace: "off",
		video: "off",
	},
});
