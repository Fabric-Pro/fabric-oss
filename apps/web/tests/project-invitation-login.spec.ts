import { expect, test } from "@playwright/test";
import {
	gotoInvitation,
	readReturningUserSeedFromEnv,
} from "./helpers/project-invitation";

const seed = readReturningUserSeedFromEnv();

test.describe("Project invitation — login flow", () => {
	test.skip(!seed, "Set E2E_PROJECT_INVITATION_ID_RETURNING_USER to enable");

	test.use({ storageState: { cookies: [], origins: [] } });

	test("inline login form exposes mode switch, OAuth, passkey and forgot-password parity", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await gotoInvitation(page, seed);

		await expect(page.getByRole("heading", { level: 1 })).toContainText(
			/sign in to accept/i,
		);

		// Mode switch present when both magic-link + password are enabled
		await expect(
			page.getByRole("tab", { name: /password/i }),
		).toBeVisible();
		await expect(
			page.getByRole("tab", { name: /magic link/i }),
		).toBeVisible();

		// Forgot-password link
		await expect(
			page.getByRole("link", { name: /forgot password/i }),
		).toHaveAttribute("href", "/auth/forgot-password");

		// OAuth + passkey
		await expect(
			page.getByRole("button", { name: /Google/i }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /GitHub/i }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /passkey/i }),
		).toBeVisible();
	});

	test("inline-swaps from login → signup → login while the project card persists", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await gotoInvitation(page, seed);

		// Project card heading row should be present in both modes
		const projectCardName = page
			.locator("text=/role:/i")
			.first()
			.locator("..");
		await expect(projectCardName).toBeVisible();

		await page.getByRole("button", { name: /create an account/i }).click();
		await expect(
			page.getByText(/create your fabric account/i),
		).toBeVisible();

		await page.getByRole("button", { name: /sign in/i }).click();
		await expect(page.getByText(/sign in to accept/i)).toBeVisible();
	});

	test("password sign-in routes to the project page on success", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await gotoInvitation(page, seed);

		await page.getByLabel(/email/i).fill(seed.email);
		await page
			.getByLabel(/^password$/i)
			.fill(process.env.E2E_USER_PASSWORD ?? "ChangeMeInProduction!");

		await page.getByRole("button", { name: /sign in and join/i }).click();

		await page.waitForURL(/\/app\/.*\/projects\//, { timeout: 20_000 });
	});
});
