/**
 * F-1166 PM Sync — Conflict-Path E2E
 *
 * Scenario (updated for the unified ConflictResolveDialog, Chunk B):
 *   1. Story already has lastPmSyncStatus = "CONFLICT" (representing the
 *      out-of-band PM edit detected by the previous sync attempt).
 *   2. The conflict badge renders on the StoryCard.
 *   3. Click the badge → the unified ConflictResolveDialog opens. The badge
 *      opens the dialog with NO pre-fetched preview, so the dialog fetches its
 *      own single-item preview via `checkPmSyncConflicts`, then renders the
 *      diff with the FABRIC and PM TOOL editorial-label columns.
 *   4. Click "Use Fabric" → `resolveConflict` fires with
 *      { resolution: "LOCAL", itemType: "story", itemId } and NO
 *      organizationId / overrideDescription. "Use Fabric" replaces the old
 *      "Push anyway" semantic of the retired PmSyncDiffModal.
 *   5. Simulate resolution: state flips to SUCCESS; reload list shows badge
 *      cleared.
 *
 * What changed vs the old spec: the push-time conflict surface is now the
 * unified `ConflictResolveDialog` (Use Fabric / Use PM / AI merge / Cancel,
 * 3-column-capable diff). The retired `PmSyncDiffModal` had "Push anyway /
 * Skip" and called `retryPmSync` with `pushAnyway: true`; the unified dialog
 * calls `resolveConflict` instead. The AI-merge happy path lives in
 * `conflict-ai-merge.spec.ts` (Task 9.2).
 *
 * Run with:
 *   pnpm --filter web e2e tests/pm-sync/conflict-path.spec.ts
 */
import { expect, type Route, test } from "@playwright/test";
import {
	gotoRoadmap,
	installCapabilitiesAndStatuses,
	installStoriesListMock,
	orpcJsonResponse,
	SYNCED_STORY,
	type SyncedStoryFixture,
	skipIfNoData,
	TEST_DATA,
	unwrapOrpcInput,
} from "./_helpers";

test.describe("F-1166 PM sync — conflict path", () => {
	test.beforeEach(() => {
		skipIfNoData(TEST_DATA.projectId, test);
	});

	test("conflict badge → unified resolve dialog → Use Fabric clears the badge", async ({
		page,
	}) => {
		const state: { story: SyncedStoryFixture } = {
			story: { ...SYNCED_STORY, lastPmSyncStatus: "CONFLICT" },
		};

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);

		// Review Center badge count, served off the same live fixture: 1
		// actionable conflict while the story is CONFLICT, 0 after resolve.
		// Field names mirror getReviewCenterCount's output (total +
		// conflictsCount / failuresCount / pullDriftCount).
		await page.route(
			"**/api/rpc/projects/reviewCenter/count**",
			async (route: Route) => {
				const conflicts =
					state.story.lastPmSyncStatus === "CONFLICT" ? 1 : 0;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({
						total: conflicts,
						conflictsCount: conflicts,
						failuresCount: 0,
						pullDriftCount: 0,
					}),
				});
			},
		);

		// The badge opens the dialog with no pre-fetched preview, so the dialog
		// fetches its own single-item preview via checkPmSyncConflicts. Return a
		// conflicting PM side so the FABRIC / PM TOOL columns both render.
		await page.route(
			"**/api/rpc/projects/stories/checkPmSyncConflicts**",
			async (route: Route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({
						results: [
							{
								id: state.story.id,
								itemType: "story",
								hasConflict: true,
								pmCurrent: {
									title: "PM-side edited title",
									description: "PM-side edited description.",
									lastChangedBy: "Jamie Rivera",
									lastChangedAt: "2026-05-20T10:30:00Z",
								},
								pmUrl: state.story.externalUrl,
								pmTool: "azure-devops",
							},
						],
					}),
				});
			},
		);

		// resolveConflict: assert LOCAL ("Use Fabric") and flip state to SUCCESS.
		let resolveFired = 0;
		let resolveInput: {
			resolution?: string;
			itemType?: string;
			itemId?: string;
			organizationId?: unknown;
			overrideDescription?: unknown;
		} = {};
		await page.route(
			"**/api/rpc/projects/stories/resolveConflict**",
			async (route: Route) => {
				resolveFired += 1;
				try {
					resolveInput = unwrapOrpcInput<typeof resolveInput>(
						route.request().postDataJSON() as unknown,
					);
				} catch {
					// Tolerate non-JSON bodies; primary assertion is the counter.
				}
				state.story.lastPmSyncStatus = "PENDING";
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ cleared: true }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// 1) Conflict badge visible; Review Center badge counts the conflict.
		const conflictBadge = page
			.getByRole("button", { name: /^PM sync conflict/i })
			.first();
		await expect(conflictBadge).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByRole("button", {
				name: /Review Center: 1 item to review/i,
			}),
		).toBeVisible({ timeout: 10_000 });

		// 2) Click → unified resolve dialog opens with the 3-column-capable diff.
		await conflictBadge.click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();

		// Wait for the fetched preview to render before asserting on the columns
		// (the action buttons are disabled while previewLoading).
		await expect(
			dialog.getByText("PM TOOL", { exact: true }).first(),
		).toBeVisible({
			timeout: 10_000,
		});
		await expect(dialog).toContainText(/changed in both Fabric/i);
		await expect(dialog).toContainText(/by Jamie Rivera/i);
		await expect(
			dialog.getByText("FABRIC", { exact: true }).first(),
		).toBeVisible();
		await expect(dialog).toContainText(/PM-side edited title/);

		// Unified actions present.
		await expect(
			dialog.getByRole("button", { name: "Use Fabric" }),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "Use PM" }),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: /AI merge/i }),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "Cancel" }),
		).toBeVisible();

		// 3) Use Fabric (replaces the old "Push anyway").
		await dialog.getByRole("button", { name: "Use Fabric" }).click();

		await expect.poll(() => resolveFired).toBeGreaterThan(0);
		expect(resolveInput.resolution).toBe("LOCAL");
		expect(resolveInput.itemType).toBe("story");
		expect(resolveInput.itemId).toBe(state.story.id);
		// resolveConflict resolves the tenant scope server-side and does not
		// carry an overrideDescription for a plain "Use Fabric".
		expect(resolveInput).not.toHaveProperty("organizationId");
		expect(resolveInput).not.toHaveProperty("overrideDescription");

		// 3b) The badge must clear IN-SESSION, without a reload.
		// Wait for the dialog to close FIRST: while a modal dialog is open,
		// Radix aria-hides the app shell, so role-based locators match
		// nothing and a premature not-visible assertion passes vacuously
		// (with or without the resolve-success invalidation).
		await expect(dialog).not.toBeVisible({ timeout: 10_000 });
		// resolveConflict's mock flipped the fixture to PENDING; the
		// resolve-success invalidation refetches stories.list and the conflict
		// pill unmounts. Nothing else can refetch inside this window (60s
		// staleTime; the 3s PENDING poll can't start from a CONFLICT-only
		// cache), so this assertion fails if the invalidation regresses.
		await expect(
			page.getByRole("button", { name: /^PM sync conflict/i }),
		).not.toBeVisible({ timeout: 10_000 });

		// 3c) The Review Center count refetches in-session too: 1 → 0, and a
		// zero-count inbox renders nothing.
		await expect(
			page.getByRole("button", { name: /Review Center:/i }),
		).not.toBeVisible({ timeout: 10_000 });

		// 4) Simulate the activity resolving — flip to SUCCESS, reload.
		state.story.lastPmSyncStatus = "SUCCESS";
		await page.reload();

		await expect(
			page.getByRole("button", { name: /^PM sync conflict/i }),
		).not.toBeVisible();
		// Sanity: the card still shows its PM-link relationship (the
		// auto-sync cloud control renders only for linked stories).
		await expect(
			page.getByRole("button", { name: /Auto-sync/i }).first(),
		).toBeVisible();
	});
});
