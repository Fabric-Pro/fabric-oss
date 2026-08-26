import * as path from "node:path";
import { expect, test as setup } from "@playwright/test";

const authFile = path.join(__dirname, ".auth/user.json");

setup("authenticate", async ({ page }) => {
	await page.goto("/auth/login");

	await page.fill(
		'input[name="email"]',
		process.env.E2E_USER_EMAIL ?? "e2e-user@example.com",
	);
	await page.fill(
		'input[name="password"]',
		process.env.E2E_USER_PASSWORD ?? "ChangeMeInProduction!",
	);
	await page.click('button[type="submit"]');

	// Wait for redirect to app
	await page.waitForURL("/app**", { timeout: 15000 });

	// Verify we're logged in
	await expect(page).not.toHaveURL(/\/auth\//);

	// Save auth state
	await page.context().storageState({ path: authFile });
});
