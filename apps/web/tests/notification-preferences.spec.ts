/**
 * Notification Center Preferences — E2E coverage.
 *
 * Exercises the settings UI end-to-end against the real app + oRPC API + DB:
 *   - AC-2: the preferences page renders a toggle for each notification category.
 *   - AC-7: when the user has no PM-tool integration, the Sync/Integrations
 *     toggle is greyed/disabled.
 *   - AC-3: toggling a category persists across a full page reload (real
 *     getPreferences/updatePreferences roundtrip, account-global row).
 *
 * Uses the repo's single `storageState` cookie (auth.setup.ts → E2E_USER_EMAIL /
 * E2E_USER_PASSWORD). The seeded e2e user has no projects/integrations, so AC-7's
 * greyed state is deterministic.
 *
 * Run: `pnpm --filter web e2e tests/notification-preferences.spec.ts`
 */

import { expect, test } from "@playwright/test";

const CATEGORY_LABELS = [
	"Mentions",
	"Replies",
	"Assignments",
	"Status changes",
	"Sync & integrations",
	"AI & agents",
];

test.describe("Notification Center preferences", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/app/settings/notifications");
		// The toggle list renders once getPreferences resolves.
		await expect(page.getByRole("switch").first()).toBeVisible({
			timeout: 30000,
		});
	});

	test("renders a toggle for each notification category (AC-2)", async ({
		page,
	}) => {
		await expect(page.getByRole("switch")).toHaveCount(6);
		for (const label of CATEGORY_LABELS) {
			await expect(page.getByText(label, { exact: true })).toBeVisible();
		}
	});

	test("greys out the sync toggle when no integration is configured (AC-7)", async ({
		page,
	}) => {
		// aria-label for the disabled sync switch is "Sync & integrations — <tooltip>".
		const sync = page.getByRole("switch", { name: /Sync & integrations/i });
		await expect(sync).toBeDisabled();
	});

	test("persists a category toggle across reload (AC-3)", async ({
		page,
	}) => {
		const mentions = () =>
			page.getByRole("switch", { name: "Mentions", exact: true });

		// oRPC calls all POST to /api/rpc; wait for the updatePreferences ack so
		// the reload deterministically reads the persisted value (no race).
		const rpcPost = () =>
			page.waitForResponse(
				(r) =>
					r.url().includes("/api/rpc") &&
					r.request().method() === "POST",
			);

		// Default opt-out model → starts enabled.
		await expect(mentions()).toHaveAttribute("aria-checked", "true");

		// Disable it; confirm the optimistic flip + the server ack.
		const [disableResp] = await Promise.all([
			rpcPost(),
			mentions().click(),
		]);
		expect(disableResp.ok()).toBeTruthy();
		await expect(mentions()).toHaveAttribute("aria-checked", "false");

		// Full reload re-reads from the DB via getPreferences.
		await page.reload();
		await expect(mentions()).toBeVisible({ timeout: 30000 });
		await expect(mentions()).toHaveAttribute("aria-checked", "false");

		// Restore so the seeded user is left in the default state.
		const [restoreResp] = await Promise.all([
			rpcPost(),
			mentions().click(),
		]);
		expect(restoreResp.ok()).toBeTruthy();
		await expect(mentions()).toHaveAttribute("aria-checked", "true");
	});
});
