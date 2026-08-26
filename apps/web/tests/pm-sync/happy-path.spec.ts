/**
 * F-1166 PM Sync — Happy-Path E2E
 *
 * Scenario:
 *   1. Synced story renders with no PM-sync badge.
 *   2. User inline-renames the title (a manual edit via stories.update).
 *   3. update-story flips the row's lastPmSyncStatus to PENDING — the next
 *      stories.list refetch surfaces the PmSyncPendingIndicator on the card.
 *   4. The mocked sync activity completes; lastPmSyncStatus becomes SUCCESS
 *      (which renders no badge per spec §7.2). The PM "side-effect"
 *      (containerName/PM tool reflecting update) is asserted via the
 *      counter on `stories.update` having fired.
 *
 * All oRPC procedures are mocked via `page.route` to keep this fully
 * deterministic — no Aspire stack or real PM tool required. See
 * `re-sync-features.spec.ts` and `pm-import-filtering.spec.ts` for the
 * established mocking pattern.
 *
 * Run with:
 *   pnpm --filter web e2e tests/pm-sync/happy-path.spec.ts
 */
import { type Route, expect, test } from "@playwright/test";
import {
	PM_TOOL_NAME,
	SYNCED_STORY,
	TEST_DATA,
	gotoRoadmap,
	installCapabilitiesAndStatuses,
	installStoriesListMock,
	orpcJsonResponse,
	skipIfNoData,
	startInlineRename,
} from "./_helpers";

test.describe("F-1166 PM sync — happy path", () => {
	test.beforeEach(() => {
		skipIfNoData(TEST_DATA.projectId, test);
	});

	test("manual title edit on synced story shows pending → resolves clean; PM tool receives update", async ({
		page,
	}) => {
		const state = { story: { ...SYNCED_STORY, lastPmSyncStatus: null } };

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);

		let updateFired = 0;
		await page.route(
			"**/api/rpc/projects/stories/update**",
			async (route: Route) => {
				updateFired += 1;
				// Server-side effect: update procedure stamps PENDING and
				// enqueues the sync activity.
				state.story.lastPmSyncStatus = "PENDING";
				state.story.lastPmSyncAttemptAt = new Date().toISOString();
				state.story.title = "Synced feature — edited title";
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ success: true }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// 1) No PM-sync badge before the edit.
		await expect(
			page.getByRole("status", { name: /Syncing to/i }),
		).not.toBeVisible();

		// 2) Inline-rename title → mutation fires.
		await startInlineRename(page, SYNCED_STORY.title);
		const input = page
			.locator("input")
			.filter({ has: page.locator(":scope") })
			.first();
		await input.fill("Synced feature — edited title");
		await input.press("Enter");

		expect(updateFired).toBeGreaterThan(0);

		// 3) Pending indicator appears once invalidation refetches the list.
		const pending = page
			.getByRole("status")
			.filter({ hasText: new RegExp(`Syncing to ${PM_TOOL_NAME}`, "i") });
		await expect(pending.first()).toBeVisible({ timeout: 10_000 });

		// 4) Simulate the activity completing on the server: SUCCESS clears
		//    the badge (no badge for SUCCESS / null per spec §7.2).
		state.story.lastPmSyncStatus = "SUCCESS";
		// Trigger a refetch by reloading the route — equivalent to the
		// invalidation that the post-mutation onSettled fires.
		await page.reload();

		await expect(
			page.getByRole("status").filter({
				hasText: new RegExp(`Syncing to ${PM_TOOL_NAME}`, "i"),
			}),
		).not.toBeVisible();

		// 5) PM tool side-effect: the update procedure (which fans out the
		//    push to PM in fire-and-forget mode) was invoked.
		expect(updateFired).toBeGreaterThan(0);
	});
});
