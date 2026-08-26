/**
 * F-1166 PM Sync — Failure-Path E2E
 *
 * Scenario:
 *   1. Synced story currently has lastPmSyncStatus = FAILED with a captured
 *      error message (representing the prior failed push to a fake/500ing
 *      PM endpoint).
 *   2. The PmSyncFailureBadge renders on the StoryCard.
 *   3. The badge persists across page reload — `lastPmSyncStatus` is
 *      persisted server-side per spec §4.1, so the badge is not transient.
 *   4. Click the badge → PmSyncFailureSidePanel opens with the truncated
 *      error and a Retry button.
 *   5. Click Retry → retryPmSync fires; we simulate the restored endpoint
 *      by flipping state to SUCCESS, reload, and verify the badge is gone.
 *
 * Run with:
 *   pnpm --filter web e2e tests/pm-sync/failure-path.spec.ts
 */
import { type Route, expect, test } from "@playwright/test";
import {
	SYNCED_STORY,
	TEST_DATA,
	gotoRoadmap,
	installCapabilitiesAndStatuses,
	installStoriesListMock,
	orpcJsonResponse,
	skipIfNoData,
} from "./_helpers";

const FAILURE_ERROR_MESSAGE =
	"PM adapter returned 500 — Internal Server Error from FabricOnE2E.";

test.describe("F-1166 PM sync — failure path", () => {
	test.beforeEach(() => {
		skipIfNoData(TEST_DATA.projectId, test);
	});

	test("failure badge appears, persists across reload, Retry clears it", async ({
		page,
	}) => {
		const state = {
			story: {
				...SYNCED_STORY,
				lastPmSyncStatus: "FAILED" as const,
				lastPmSyncError: FAILURE_ERROR_MESSAGE,
				lastPmSyncAttemptAt: new Date(
					"2026-04-30T12:00:00Z",
				).toISOString(),
			},
		};

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);

		let retryFired = 0;
		await page.route(
			"**/api/rpc/projects/stories/retryPmSync**",
			async (route: Route) => {
				retryFired += 1;
				// The "PM endpoint" has been restored — flip to PENDING then
				// SUCCESS via the next list refetch.
				state.story.lastPmSyncStatus = "SUCCESS";
				state.story.lastPmSyncError = null;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ success: true }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// 1) Failure badge visible.
		const failureBadge = page
			.getByRole("button", { name: /PM sync failed/i })
			.first();
		await expect(failureBadge).toBeVisible({ timeout: 10_000 });

		// 2) Persists across reload (lastPmSyncStatus is server-side).
		await page.reload();
		await expect(
			page.getByRole("button", { name: /PM sync failed/i }).first(),
		).toBeVisible({ timeout: 10_000 });

		// 3) Click → side panel opens with truncated error and Retry button.
		await page
			.getByRole("button", { name: /PM sync failed/i })
			.first()
			.click();

		const panel = page.getByRole("dialog");
		await expect(panel).toBeVisible();
		await expect(panel).toContainText(/Sync failed/i);
		await expect(panel).toContainText(/PM adapter returned 500/);

		// 4) Retry.
		await panel.getByRole("button", { name: /Retry sync/i }).click();
		expect(retryFired).toBeGreaterThan(0);

		// 5) Simulate restored endpoint resolving the activity. Reload the
		//    page and assert the badge is gone.
		await page.reload();
		await expect(
			page.getByRole("button", { name: /PM sync failed/i }),
		).not.toBeVisible();
	});
});
