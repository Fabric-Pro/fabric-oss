import { expect, test } from "@playwright/test";
import {
	gotoInvitation,
	readNewUserSeedFromEnv,
} from "./helpers/project-invitation";

const seed = readNewUserSeedFromEnv();

test.describe("Project invitation — signup flow", () => {
	test.skip(
		!seed,
		"Set E2E_PROJECT_INVITATION_ID_NEW_USER + E2E_PROJECT_INVITATION_EMAIL_NEW_USER to enable",
	);

	test.use({ storageState: { cookies: [], origins: [] } });

	test("inline signup form mirrors the regular SignupForm affordances", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await gotoInvitation(page, seed);

		await expect(page.getByRole("heading", { level: 1 })).toContainText(
			/create your fabric account/i,
		);

		await expect(
			page.getByRole("link", { name: /Terms of Service/i }),
		).toHaveAttribute("href", "/legal/terms");
		await expect(
			page.getByRole("link", { name: /Privacy Policy/i }),
		).toHaveAttribute("href", "/legal/privacy-policy");

		await expect(
			page.getByRole("button", { name: /Google/i }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /GitHub/i }),
		).toBeVisible();

		await expect(
			page.getByRole("button", { name: /Sign in/i }),
		).toBeVisible();
	});

	test("client-side 12-character password rule blocks an 11-char submission", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await gotoInvitation(page, seed);

		await page.getByLabel(/full name/i).fill("E2E Invitee");
		await page.getByLabel(/^password$/i).fill("ShortPwd11x");
		await page.getByRole("checkbox").click();

		await expect(
			page.getByText(/password must be at least 12 characters/i),
		).toBeVisible();
	});

	test("successful signup transitions to the check-your-email verification step", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await gotoInvitation(page, seed);

		await page.getByLabel(/full name/i).fill("E2E Invitee");
		await page.getByLabel(/^password$/i).fill("ParityFlowTest1!");
		await page.getByRole("checkbox").click();

		// Local dev typically runs without a Turnstile site key. When captcha
		// is disabled, the action proceeds and the modal shows the
		// verify-first "Check your email" state — no inline sign-in step.
		await page
			.getByRole("button", { name: /create account and join/i })
			.click();

		await expect(
			page.getByRole("heading", { name: /check your email/i }),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			page.getByText(/sent a verification link to/i),
		).toBeVisible();
	});
});
