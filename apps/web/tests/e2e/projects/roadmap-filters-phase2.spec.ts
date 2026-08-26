/**
 * E2E: Roadmap filters (Phase 2) — happy path.
 *
 * Spec: roadmap filters Phase 2 plan, Task 12.
 *
 * Flow:
 *   1. Open the roadmap page for a pre-seeded project (4 stories: 3 with
 *      descriptions, 1 without; staggered updatedAt values).
 *   2. Sort by "Last updated" (desc), assert the visible card title order.
 *   3. Toggle the "Missing description" advanced filter, assert only the
 *      single story without a description remains visible.
 *   4. Reload the page; assert the URL persists both filters and the visible
 *      titles still match the filtered set.
 *   5. Remove the missing-description chip, assert all 4 titles are back.
 *   6. Assert the sort is still applied (URL retains sortBy=updated) — sort is
 *      independent of the missing-description filter.
 *
 * Setup: reuses the existing `auth.setup.ts` storageState (same project
 * config as `contexts-download.spec.ts` and `ai-generated-title.spec.ts`).
 * The project has no programmatic seed helper for E2E — we follow the
 * established pattern of taking concrete IDs from env vars and skipping
 * when they are not set. CI runs against placeholders by default and so
 * skips; the test is fully runnable manually once a fixture project is
 * prepared (manual runbook below).
 *
 * Env vars consumed (all required; missing values cause the suite to skip):
 *   TEST_ROADMAP_PHASE2_PROJECT_ID          - project id with the seeded stories
 *   TEST_ROADMAP_PHASE2_PROJECT_SLUG        - optional org slug; if set, the
 *                                              test navigates the org route
 *                                              `/app/{slug}/projects/{id}/roadmap`
 *   TEST_ROADMAP_PHASE2_TITLE_NEWEST        - title of the most-recently-updated
 *                                              story (WITH description)
 *   TEST_ROADMAP_PHASE2_TITLE_SECOND        - second-newest title (WITH desc)
 *   TEST_ROADMAP_PHASE2_TITLE_THIRD         - third-newest title (WITH desc)
 *   TEST_ROADMAP_PHASE2_TITLE_NO_DESC       - oldest title (WITHOUT desc) —
 *                                              this is the one that survives
 *                                              the `missingDesc` filter
 *
 * Manual fixture runbook:
 *   - Create a project (personal or org). Add four features.
 *   - Three should have a non-empty description; one should have an empty
 *     description. Touch each in sequence so `updatedAt` is staggered;
 *     remember the order so the env vars can be set newest-first.
 *
 * Run:
 *   pnpm --filter web e2e tests/e2e/projects/roadmap-filters-phase2.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

const TEST_DATA = {
	projectId:
		process.env.TEST_ROADMAP_PHASE2_PROJECT_ID ??
		"<roadmap-phase2-project-id>",
	orgSlug: process.env.TEST_ROADMAP_PHASE2_PROJECT_SLUG ?? "",
	titles: {
		newest:
			process.env.TEST_ROADMAP_PHASE2_TITLE_NEWEST ??
			"<roadmap-phase2-title-newest>",
		second:
			process.env.TEST_ROADMAP_PHASE2_TITLE_SECOND ??
			"<roadmap-phase2-title-second>",
		third:
			process.env.TEST_ROADMAP_PHASE2_TITLE_THIRD ??
			"<roadmap-phase2-title-third>",
		noDesc:
			process.env.TEST_ROADMAP_PHASE2_TITLE_NO_DESC ??
			"<roadmap-phase2-title-no-desc>",
	},
} as const;

function isPlaceholder(value: string): boolean {
	return value.startsWith("<") && value.endsWith(">");
}

function skipIfAnyPlaceholder(...values: string[]): void {
	for (const v of values) {
		if (isPlaceholder(v)) {
			test.skip();
			return;
		}
	}
}

function roadmapUrl(projectId: string, orgSlug: string): string {
	return orgSlug
		? `/app/${orgSlug}/projects/${projectId}/roadmap`
		: `/app/projects/${projectId}/roadmap`;
}

/** Capture the visible story-card titles in DOM order. */
async function readVisibleTitles(page: Page): Promise<string[]> {
	const locator = page.getByTestId("story-card-title");
	// Wait for at least one card before reading.
	await locator.first().waitFor({ state: "visible", timeout: 15_000 });
	return (await locator.allInnerTexts()).map((t) => t.trim());
}

test.describe("Roadmap filters (Phase 2) — happy path", () => {
	test.beforeEach(() => {
		skipIfAnyPlaceholder(
			TEST_DATA.projectId,
			TEST_DATA.titles.newest,
			TEST_DATA.titles.second,
			TEST_DATA.titles.third,
			TEST_DATA.titles.noDesc,
		);
	});

	test("sort by last-updated + missing-description filter persists across reload", async ({
		page,
	}) => {
		const url = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(url);

		// Toolbar must be present before we touch anything.
		await page
			.getByRole("button", { name: "Sort options" })
			.waitFor({ state: "visible", timeout: 15_000 });

		// ─── Step 3-4: sort by Last updated (desc) ─────────────────────────
		await page.getByRole("button", { name: "Sort options" }).click();
		await page.getByRole("button", { name: "Last updated" }).click();

		// Wait for the URL to reflect the sort selection (nuqs is `history:
		// "replace"` so navigation is in-place).
		await expect
			.poll(() => page.url(), { timeout: 5_000 })
			.toContain("sortBy=updated");

		const sortedTitles = await readVisibleTitles(page);
		const expectedOrder = [
			TEST_DATA.titles.newest,
			TEST_DATA.titles.second,
			TEST_DATA.titles.third,
			TEST_DATA.titles.noDesc,
		];
		// The roadmap may include other UI elements that don't carry the
		// testid (we only stamped it on the title <span>), so we filter the
		// captured list down to the seeded titles before asserting order.
		const seededInOrder = sortedTitles.filter((t) =>
			expectedOrder.includes(t),
		);
		expect(seededInOrder).toEqual(expectedOrder);

		// ─── Step 5-6: toggle "Missing description" ────────────────────────
		// "Missing description" is a secondary filter under the inline
		// "More filters" disclosure (collapsed by default) — open it first.
		await page.getByRole("button", { name: /more filters/i }).click();
		await page.getByLabel("Missing description").check();

		await expect
			.poll(() => page.url(), { timeout: 5_000 })
			.toContain("missingDesc=true");

		const filteredTitles = await readVisibleTitles(page);
		const filteredSeeded = filteredTitles.filter((t) =>
			expectedOrder.includes(t),
		);
		expect(filteredSeeded).toEqual([TEST_DATA.titles.noDesc]);

		// ─── Step 7: reload — URL state persists ───────────────────────────
		await page.reload();
		await page
			.getByRole("button", { name: "Sort options" })
			.waitFor({ state: "visible", timeout: 15_000 });

		const reloadedUrl = page.url();
		expect(reloadedUrl).toContain("sortBy=updated");
		expect(reloadedUrl).toContain("missingDesc=true");

		const reloadedTitles = await readVisibleTitles(page);
		const reloadedSeeded = reloadedTitles.filter((t) =>
			expectedOrder.includes(t),
		);
		expect(reloadedSeeded).toEqual([TEST_DATA.titles.noDesc]);

		// ─── Step 8: remove the missing-description chip ───────────────────
		await page
			.getByRole("button", { name: "Remove missing-description filter" })
			.click();

		// All 4 seeded titles return.
		await expect
			.poll(
				async () => {
					const titles = await readVisibleTitles(page);
					return titles.filter((t) => expectedOrder.includes(t))
						.length;
				},
				{ timeout: 5_000 },
			)
			.toBe(expectedOrder.length);

		const restoredTitles = await readVisibleTitles(page);
		const restoredSeeded = restoredTitles.filter((t) =>
			expectedOrder.includes(t),
		);
		expect(new Set(restoredSeeded)).toEqual(new Set(expectedOrder));

		// ─── Step 9: sort survives filter removal (still reflected in URL) ──
		// Sort "off" is reached by cycling a field (no separate reset chip);
		// removing a filter must not clear the active sort.
		expect(page.url()).toContain("sortBy=updated");
	});
});
