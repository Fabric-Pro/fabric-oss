/**
 * E2E: Roadmap filters audit.
 *
 * Three scenarios verifying the audit fixes ship correctly end-to-end:
 *   1. Sync-bucket switching: synced count + unsynced count == unfiltered total.
 *   2. Sync-date × unsynced no longer empties: applying a sync-date range
 *      with sync=Unsynced returns unsynced rows (range is ignored per Fix 2).
 *   3. URL round-trip: applied filters survive a reload.
 *
 * Setup: like roadmap-filters-phase2.spec.ts, this test is skipped unless
 * a fixture project is configured via env vars. CI runs against placeholders
 * by default and so skips; the test is fully runnable manually once a
 * fixture project with both synced and unsynced stories is prepared.
 *
 * Env vars (all required; missing values cause the suite to skip):
 *   TEST_ROADMAP_AUDIT_PROJECT_ID    - project id with at least one synced and
 *                                       one unsynced story
 *   TEST_ROADMAP_AUDIT_PROJECT_SLUG  - optional org slug (omit for personal)
 *
 * Manual fixture runbook:
 *   - Create a project. Add at least 2 features.
 *   - Link one of them to a PM tool item (Jira / GitLab / Azure DevOps) so it
 *     gets an externalId and lastSyncedAt populated.
 *   - Leave the other unlinked.
 *
 * Run: pnpm --filter web e2e tests/e2e/projects/roadmap-filters-audit.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

const TEST_DATA = {
	projectId:
		process.env.TEST_ROADMAP_AUDIT_PROJECT_ID ??
		"<roadmap-audit-project-id>",
	orgSlug: process.env.TEST_ROADMAP_AUDIT_PROJECT_SLUG ?? "",
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

async function readCountText(page: Page): Promise<string> {
	const locator = page.getByTestId("roadmap-filter-count");
	await locator.waitFor({ state: "visible", timeout: 15_000 });
	return (await locator.innerText()).trim();
}

/** Parse "N of M shown" or "M work items"/"1 work item" into the filtered count. */
function parseFilteredCount(text: string): number {
	const match = text.match(/^(\d+)\s+of\s+\d+\s+shown$/i);
	if (match) {
		return Number(match[1]);
	}
	const total = text.match(/^(\d+)\s+work items?$/i);
	if (total) {
		return Number(total[1]);
	}
	throw new Error(`Unparseable count text: "${text}"`);
}

/** Parse "N of M shown" or "M work items"/"1 work item" into the total count. */
function parseTotalCount(text: string): number {
	const match = text.match(/^\d+\s+of\s+(\d+)\s+shown$/i);
	if (match) {
		return Number(match[1]);
	}
	const total = text.match(/^(\d+)\s+work items?$/i);
	if (total) {
		return Number(total[1]);
	}
	throw new Error(`Unparseable count text: "${text}"`);
}

test.describe("Roadmap filters — audit", () => {
	test.beforeEach(() => {
		skipIfAnyPlaceholder(TEST_DATA.projectId);
	});

	test("sync bucket switching: synced + unsynced == unfiltered total", async ({
		page,
	}) => {
		await page.goto(roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug));
		await page
			.getByRole("button", { name: "Sort options" })
			.waitFor({ state: "visible", timeout: 15_000 });

		const totalText = await readCountText(page);
		const total = parseTotalCount(totalText);

		// Sync is a multiselect dropdown under the inline "More filters"
		// disclosure (collapsed by default) — open it, open the Sync dropdown,
		// pick Synced, then close the popover.
		await page.getByRole("button", { name: /more filters/i }).click();
		await page.getByRole("button", { name: "Sync filter" }).click();
		await page.getByRole("option", { name: /^synced$/i }).click();
		await page.keyboard.press("Escape");

		const syncedText = await readCountText(page);
		const syncedCount = parseFilteredCount(syncedText);

		// Switch to Unsynced: reopen the dropdown, deselect Synced, select Unsynced.
		await page.getByRole("button", { name: "Sync filter" }).click();
		await page.getByRole("option", { name: /^synced$/i }).click();
		await page.getByRole("option", { name: /^unsynced$/i }).click();
		await page.keyboard.press("Escape");

		const unsyncedText = await readCountText(page);
		const unsyncedCount = parseFilteredCount(unsyncedText);

		expect(syncedCount + unsyncedCount).toBe(total);
	});

	test("sync-date range × Unsynced does not silently empty (Fix 2)", async ({
		page,
	}) => {
		await page.goto(roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug));
		await page
			.getByRole("button", { name: "Sort options" })
			.waitFor({ state: "visible", timeout: 15_000 });

		// Sync lives under the inline "More filters" disclosure — open it, then
		// pick Unsynced from the Sync dropdown and close the popover.
		await page.getByRole("button", { name: /more filters/i }).click();
		await page.getByRole("button", { name: "Sync filter" }).click();
		await page.getByRole("option", { name: /^unsynced$/i }).click();
		await page.keyboard.press("Escape");

		const beforeRangeText = await readCountText(page);
		const beforeRange = parseFilteredCount(beforeRangeText);

		// Fixture sanity check: if the project has zero unsynced stories,
		// asserting `afterRange === beforeRange === 0` would pass vacuously
		// without exercising Fix 2. Fail loudly instead so the runner knows
		// to fix the fixture rather than ship a false-green test.
		expect(
			beforeRange,
			"fixture project must have at least one unsynced story",
		).toBeGreaterThan(0);

		// The advanced filter panel doesn't have stable testids for the
		// syncedFrom/syncedTo inputs yet, so inject the sync-date range via
		// URL. nuqs' parseAsString accepts the value as-is; the filter then
		// applies it through parseFromDate.
		const currentUrl = page.url();
		const urlWithRange = currentUrl.includes("?")
			? `${currentUrl}&syncedFrom=2026-05-18`
			: `${currentUrl}?syncedFrom=2026-05-18`;
		await page.goto(urlWithRange);
		await page
			.getByTestId("roadmap-filter-count")
			.waitFor({ state: "visible", timeout: 15_000 });

		// Sanity: confirm the URL injection survived navigation. If nuqs
		// silently rejected the param, the rest of this test would be a
		// tautology (afterRange === beforeRange because the range never
		// applied).
		expect(page.url()).toContain("syncedFrom=2026-05-18");

		const afterRangeText = await readCountText(page);
		const afterRange = parseFilteredCount(afterRangeText);

		// Fix 2: with sync=Unsynced, the range is ignored — count should
		// be unchanged (NOT zero, which would be the pre-Fix 2 behavior).
		expect(afterRange).toBe(beforeRange);
	});

	test("URL round-trip preserves applied filters", async ({ page }) => {
		await page.goto(roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug));
		await page
			.getByRole("button", { name: "Sort options" })
			.waitFor({ state: "visible", timeout: 15_000 });

		// Apply sync=Synced via URL for deterministic state.
		const baseUrl = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(`${baseUrl}?sync=synced`);
		await page
			.getByTestId("roadmap-filter-count")
			.waitFor({ state: "visible", timeout: 15_000 });

		const before = parseFilteredCount(await readCountText(page));
		const urlBefore = page.url();

		await page.reload();
		await page
			.getByTestId("roadmap-filter-count")
			.waitFor({ state: "visible", timeout: 15_000 });

		const after = parseFilteredCount(await readCountText(page));

		expect(after).toBe(before);
		expect(page.url()).toBe(urlBefore);
	});
});
