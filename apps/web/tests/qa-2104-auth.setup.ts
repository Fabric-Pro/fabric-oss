import * as path from "node:path";
import { expect, test as setup } from "@playwright/test";

/**
 * Auth for the #2104 QA run.
 *
 * Mirrors tests/auth.setup.ts but writes a separate state file so it cannot
 * clobber the existing localhost auth state. Credentials come from the
 * environment — nothing is hardcoded and nothing is echoed.
 */
const authFile = path.join(__dirname, ".auth/qa-2104.json");

setup("authenticate against the QA target", async ({ page }) => {
	const email = process.env.E2E_USER_EMAIL;
	const password = process.env.E2E_USER_PASSWORD;

	if (!email || !password) {
		throw new Error(
			"Set E2E_USER_EMAIL and E2E_USER_PASSWORD to run the #2104 QA suite.",
		);
	}

	await page.goto("/auth/login");
	await page.fill('input[name="email"]', email);
	await page.fill('input[name="password"]', password);
	await page.click('button[type="submit"]');

	await page.waitForURL("**/app**", { timeout: 30_000 });
	await expect(page).not.toHaveURL(/\/auth\//);

	await page.context().storageState({ path: authFile });
});
