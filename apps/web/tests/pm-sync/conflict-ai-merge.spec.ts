/**
 * F-1166 PM Sync — Unified resolve dialog + AI-merge happy path E2E (Task 9.2).
 *
 * Exercises the unified `ConflictResolveDialog` (Chunk B) end-to-end from the
 * StoryCard CONFLICT badge:
 *
 *   1. CONFLICT badge → unified resolve dialog opens. The badge supplies NO
 *      pre-fetched preview, so the dialog fetches its own single-item preview
 *      via `checkPmSyncConflicts`; the diff renders with the FABRIC / PM TOOL
 *      columns and the "Last changed by …" subtitle.
 *   2. Click "AI merge" → `proposeAiMerge` fires (MOCKED — never hits a real
 *      provider) → the editable middle column ("AI-REFINED") is populated with
 *      the fixed merged title + description.
 *   3. Edit the merged text → click "Accept merge" → `resolveConflict` fires
 *      with { resolution: "LOCAL", overrideTitle, overrideDescription }.
 *
 * Plus brief coverage of:
 *   - "Use PM"     → resolveConflict { resolution: "REMOTE" }, no override.
 *   - "Use Fabric" → resolveConflict { resolution: "LOCAL" }, no override.
 *   - Title-only conflict (identical descriptions) → "AI merge" still enabled.
 *   - No-op conflict (both fields identical) → "AI merge" disabled.
 *
 * AI determinism: `proposeAiMerge` is intercepted via `page.route` and returns
 * a fixed `{ mergedTitle, mergedDescription }`. No AI provider is contacted; no
 * shared/staging state is mutated.
 *
 * Scope note — Epic/Feature vs Story: this spec drives the STORY surface
 * (StoryCard). The unified dialog's `itemType` plumbing for epic/feature/bug is
 * proven by the component test
 * (`ConflictResolveDialog.test.tsx` — itemType="feature") and the backend
 * propose-ai-merge / resolve-conflict unit tests. The E2E harness here only
 * seeds a single mocked story row; the Review Center / Epic / Feature conflict
 * surfaces have no easy fixture path in this harness, so they are intentionally
 * NOT driven here. Gap noted per Task 9.2.
 *
 * Run with:
 *   pnpm --filter web e2e tests/pm-sync/conflict-ai-merge.spec.ts
 */
import { expect, type Page, type Route, test } from "@playwright/test";
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

const MOCKED_MERGE =
	"Merged description reconciling the Fabric and PM-tool versions.";
const MOCKED_TITLE = "Merged title reconciling both sides";

const PM_DESCRIPTION = "PM-side edited description with extra remote detail.";
const PM_TITLE = "PM-side edited title";

type ResolveCall = {
	resolution?: string;
	itemType?: string;
	itemId?: string;
	organizationId?: unknown;
	overrideTitle?: unknown;
	overrideDescription?: unknown;
};

/**
 * Install the single-item conflict preview the dialog fetches on open. When
 * `pmDescription` matches the Fabric description, the dialog treats it as a
 * title-only conflict and disables AI merge.
 */
async function installConflictPreview(
	page: Page,
	storyId: string,
	opts: { pmTitle: string; pmDescription: string },
): Promise<void> {
	await page.route(
		"**/api/rpc/projects/stories/checkPmSyncConflicts**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					results: [
						{
							id: storyId,
							itemType: "story",
							hasConflict: true,
							pmCurrent: {
								title: opts.pmTitle,
								description: opts.pmDescription,
								lastChangedBy: "Jamie Rivera",
								lastChangedAt: "2026-05-20T10:30:00Z",
							},
							pmUrl: SYNCED_STORY.externalUrl,
							pmTool: "azure-devops",
						},
					],
				}),
			});
		},
	);
}

/** Intercept the AI merge so it returns a fixed payload (no real provider). */
async function installAiMergeMock(
	page: Page,
	counter: { calls: number },
): Promise<void> {
	await page.route(
		"**/api/rpc/projects/stories/proposeAiMerge**",
		async (route: Route) => {
			counter.calls += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					mergedTitle: MOCKED_TITLE,
					mergedDescription: MOCKED_MERGE,
					truncated: false,
				}),
			});
		},
	);
}

/** Intercept resolveConflict, recording each unwrapped input. */
async function installResolveConflictMock(
	page: Page,
	calls: ResolveCall[],
): Promise<void> {
	await page.route(
		"**/api/rpc/projects/stories/resolveConflict**",
		async (route: Route) => {
			try {
				calls.push(
					unwrapOrpcInput<ResolveCall>(
						route.request().postDataJSON() as unknown,
					),
				);
			} catch {
				calls.push({});
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({ cleared: true }),
			});
		},
	);
}

async function openConflictDialog(page: Page) {
	await gotoRoadmap(page, TEST_DATA.projectId);
	const badge = page
		.getByRole("button", { name: /PM sync conflict/i })
		.first();
	await expect(badge).toBeVisible({ timeout: 10_000 });
	await badge.click();

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	// Wait for the fetched preview to render — action buttons are disabled
	// while the preview is loading.
	await expect(
		dialog.getByText("PM TOOL", { exact: true }).first(),
	).toBeVisible({
		timeout: 10_000,
	});
	return dialog;
}

test.describe("F-1166 PM sync — unified resolve dialog + AI merge", () => {
	test.beforeEach(() => {
		skipIfNoData(TEST_DATA.projectId, test);
	});

	test("AI merge populates the editable middle column → Accept resolves with overrideTitle + overrideDescription", async ({
		page,
	}) => {
		const state: { story: SyncedStoryFixture } = {
			story: { ...SYNCED_STORY, lastPmSyncStatus: "CONFLICT" },
		};
		const aiMerge = { calls: 0 };
		const resolveCalls: ResolveCall[] = [];

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);
		await installConflictPreview(page, state.story.id, {
			pmTitle: PM_TITLE,
			pmDescription: PM_DESCRIPTION,
		});
		await installAiMergeMock(page, aiMerge);
		await installResolveConflictMock(page, resolveCalls);

		const dialog = await openConflictDialog(page);

		// Author/changed-date subtitle present.
		await expect(dialog).toContainText(/Last changed by Jamie Rivera/i);

		// Click AI merge → proposeAiMerge fires (mocked).
		await dialog.getByRole("button", { name: /AI merge/i }).click();
		await expect.poll(() => aiMerge.calls).toBeGreaterThan(0);

		// Editable middle column populated with the mocked merge.
		const mergeTextarea = dialog.getByRole("textbox", {
			name: /AI-refined merged description/i,
		});
		await expect(mergeTextarea).toBeVisible();
		await expect(mergeTextarea).toHaveValue(MOCKED_MERGE);

		// Edit the merged text, then Accept.
		await mergeTextarea.fill("User-edited merged text");
		await dialog.getByRole("button", { name: /Accept merge/i }).click();

		await expect.poll(() => resolveCalls.length).toBeGreaterThan(0);
		const call = resolveCalls[0];
		expect(call.resolution).toBe("LOCAL");
		expect(call.itemType).toBe("story");
		expect(call.itemId).toBe(state.story.id);
		expect(call.overrideTitle).toBe(MOCKED_TITLE);
		expect(call.overrideDescription).toBe("User-edited merged text");
	});

	test("Use PM resolves with REMOTE and no overrideDescription", async ({
		page,
	}) => {
		const state: { story: SyncedStoryFixture } = {
			story: { ...SYNCED_STORY, lastPmSyncStatus: "CONFLICT" },
		};
		const resolveCalls: ResolveCall[] = [];

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);
		await installConflictPreview(page, state.story.id, {
			pmTitle: PM_TITLE,
			pmDescription: PM_DESCRIPTION,
		});
		await installResolveConflictMock(page, resolveCalls);

		const dialog = await openConflictDialog(page);
		await dialog.getByRole("button", { name: "Use PM" }).click();

		await expect.poll(() => resolveCalls.length).toBeGreaterThan(0);
		const call = resolveCalls[0];
		expect(call.resolution).toBe("REMOTE");
		expect(call.itemType).toBe("story");
		expect(call).not.toHaveProperty("overrideDescription");
		expect(call).not.toHaveProperty("organizationId");
	});

	test("Use Fabric resolves with LOCAL and no overrideDescription", async ({
		page,
	}) => {
		const state: { story: SyncedStoryFixture } = {
			story: { ...SYNCED_STORY, lastPmSyncStatus: "CONFLICT" },
		};
		const resolveCalls: ResolveCall[] = [];

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);
		await installConflictPreview(page, state.story.id, {
			pmTitle: PM_TITLE,
			pmDescription: PM_DESCRIPTION,
		});
		await installResolveConflictMock(page, resolveCalls);

		const dialog = await openConflictDialog(page);
		await dialog.getByRole("button", { name: "Use Fabric" }).click();

		await expect.poll(() => resolveCalls.length).toBeGreaterThan(0);
		const call = resolveCalls[0];
		expect(call.resolution).toBe("LOCAL");
		expect(call.itemType).toBe("story");
		expect(call).not.toHaveProperty("overrideDescription");
	});

	test("title-only conflict (identical descriptions) still allows AI merge", async ({
		page,
	}) => {
		// Fabric and PM descriptions match; only the titles differ. The merge
		// now reconciles the title too, so AI merge stays enabled.
		const sharedDescription = SYNCED_STORY.description ?? "";
		const state = {
			story: {
				...SYNCED_STORY,
				description: sharedDescription,
				lastPmSyncStatus: "CONFLICT" as const,
			},
		};

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);
		await installConflictPreview(page, state.story.id, {
			pmTitle: PM_TITLE,
			pmDescription: sharedDescription,
		});

		const dialog = await openConflictDialog(page);

		// AI merge is enabled — a title-only divergence is still mergeable.
		await expect(
			dialog.getByRole("button", { name: /AI merge/i }),
		).toBeEnabled();
	});

	test("no-op conflict (both title and description identical) disables AI merge", async ({
		page,
	}) => {
		// Fabric and PM match on BOTH fields — nothing to reconcile.
		const sharedTitle = SYNCED_STORY.title;
		const sharedDescription = SYNCED_STORY.description ?? "";
		const state = {
			story: {
				...SYNCED_STORY,
				description: sharedDescription,
				lastPmSyncStatus: "CONFLICT" as const,
			},
		};

		await installCapabilitiesAndStatuses(page);
		await installStoriesListMock(page, state);
		await installConflictPreview(page, state.story.id, {
			pmTitle: sharedTitle,
			pmDescription: sharedDescription,
		});

		const dialog = await openConflictDialog(page);

		// AI merge is disabled — nothing to merge when both sides are equal.
		await expect(
			dialog.getByRole("button", { name: /AI merge/i }),
		).toBeDisabled();
		await expect(
			dialog.getByRole("button", { name: "Use Fabric" }),
		).toBeEnabled();
		await expect(
			dialog.getByRole("button", { name: "Use PM" }),
		).toBeEnabled();
	});
});
