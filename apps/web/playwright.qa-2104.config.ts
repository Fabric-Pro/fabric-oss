import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * QA config for #2104, pointed at a deployed environment.
 *
 * Separate from playwright.config.ts because that one hardcodes
 * baseURL=localhost:3001 and starts a local web server. This one targets a
 * running deployment (the PR's Vercel preview) and starts nothing.
 *
 * Run:
 *   QA_BASE_URL=https://<preview-host> \
 *   E2E_USER_EMAIL=you@techfabric.com E2E_USER_PASSWORD=... \
 *   QA_PROJECT_ID=cmnixc8pd000004jpy6yt4wdk \
 *   npx playwright test --config=playwright.qa-2104.config.ts
 *
 * Credentials are read from the environment and typed by Playwright; they are
 * never written to disk by this config, and the auth state it produces lands in
 * tests/.auth/qa-2104.json (gitignored alongside the existing .auth state).
 */
const baseURL = process.env.QA_BASE_URL ?? "http://localhost:3001";

export default defineConfig({
	testDir: "./tests",
	testMatch: /qa-2104-.*\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	// The run is the artifact: keep the trace and video regardless of outcome,
	// so a failure is diagnosable without a re-run against live data.
	reporter: [
		["list"],
		["html", { outputFolder: "qa-2104-report", open: "never" }],
	],
	use: {
		baseURL,
		trace: "on",
		video: "on",
		screenshot: "only-on-failure",
		viewport: { width: 1440, height: 900 },
	},
	projects: [
		{
			name: "qa-setup",
			testMatch: /qa-2104-auth\.setup\.ts/,
		},
		{
			name: "qa",
			testMatch: /qa-2104-personal-insights-cache\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				storageState: path.join(__dirname, "tests/.auth/qa-2104.json"),
			},
			dependencies: ["qa-setup"],
		},
	],
});
