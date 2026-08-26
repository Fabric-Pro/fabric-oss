/**
 * COVERAGE BOUNDARY (do not over-read these specs):
 *  - Covered here: no-loop + sign-out for org & project, and the LoginForm guard entry.
 *  - DEFERRED — needs a CI OAuth mock-provider fixture, not yet present:
 *      "degraded provider" — mock GitHub/passkey returning Account A after sign-out
 *      and assert the user lands back on the explicit mismatch screen. The *outcome*
 *      (mismatch screen + actionable hint) is unit-covered in the modal tests; only
 *      the OAuth round-trip is deferred. Add here once the fixture lands.
 *  - OUT OF SCOPE (unchanged code path, no behavior change to guard):
 *      "2FA continuation" — twoFactorRedirect threading lives in untouched code
 *      (LoginForm.tsx:159-169 and ProjectInvitationModal NeedsLoginForm ~868-878).
 */
import { expect, test } from "@playwright/test";
import { readSwitchSeedFromEnv } from "./helpers/invitation-switch";

const seed = readSwitchSeedFromEnv();

test.describe("Invite account switch — no redirect loop", () => {
	test.skip(
		!seed,
		"Set E2E_SWITCH_* env vars (storageState as Account A + invites for B) to enable",
	);

	if (seed) {
		test.use({ storageState: seed.storageState });
	}

	test("org invite: switch signs out A and reaches a sign-in form for B (no loop)", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await page.goto(`/organization-invitation/${seed.orgInvitationId}`);

		// Mismatch screen is shown (signed in as A, invite for B).
		await expect(page.getByText(/wrong account/i)).toBeVisible();

		await page
			.getByRole("button", { name: /sign in with a different account/i })
			.click();

		// After sign-out we land on the login form (no session) — not a bounce
		// back to /organization-invitation.
		await page.waitForURL(/\/auth\/login/, { timeout: 15_000 });
		await expect(page).toHaveURL(/invitationId=/);
		await expect(page).not.toHaveURL(/\/organization-invitation\//);
	});

	test("project invite: switch signs out A and reloads the invite page for B (no loop)", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await page.goto(`/project-invitation/${seed.projectInvitationId}`);

		await expect(page.getByText(/wrong account/i)).toBeVisible();

		await page.getByRole("button", { name: seed.invitedEmail }).click();

		// Reloads the project-invitation page; now logged out it shows the
		// embedded sign-in form (needs_login/needs_signup), not a loop.
		await page.waitForURL(
			new RegExp(`/project-invitation/${seed.projectInvitationId}`),
			{ timeout: 15_000 },
		);
		await expect(page.getByRole("heading", { level: 1 })).not.toContainText(
			/wrong account/i,
		);
		// Positive proof we're logged out as B: the invite form for B's email
		// is shown (needs_login prefills it; needs_signup renders it read-only).
		// Playwright 1.56 has no getByDisplayValue (Testing Library API); read
		// the live input value via toHaveValue so RHF-bound (property, not
		// attribute) and controlled inputs both match. Auto-waits over reload.
		await expect(page.locator('input[type="email"]')).toHaveValue(
			seed.invitedEmail,
		);
	});

	test("LoginForm guard: opening the invite while signed in as A shows the switch panel, not a bounce", async ({
		page,
	}) => {
		if (!seed) {
			return;
		}
		await page.goto(
			`/auth/login?invitationId=${seed.orgInvitationId}&email=${encodeURIComponent(seed.invitedEmail)}`,
		);

		// The guard renders an explicit "Different account" panel instead of
		// redirecting to /organization-invitation.
		await expect(page.getByText(/different account/i)).toBeVisible();
		await expect(
			page.getByRole("button", { name: /switch account/i }),
		).toBeVisible();
		await expect(page).not.toHaveURL(/\/organization-invitation\//);
	});
});
