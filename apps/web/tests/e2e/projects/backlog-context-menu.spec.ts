/**
 * E2E: Backlog right-click "Open in new tab" feature.
 *
 * Spec: `specs/2026-05-25-backlog-context-menu-open-in-new-tab/spec.md` §9.3.
 *
 * Covers the spec's six end-to-end cases (FR-1/2/3/4/5/6/9/10/15):
 *
 *   1. Right-click row → menu → "Open in new tab" → new tab with the
 *      correct deep-link URL. Originating tab's URL is unchanged.
 *   2. Middle-click row → new tab with the same URL.
 *   3. Shift+F10 on a focused row → menu opens → Enter → new tab opens.
 *   4. Escape with the menu open → menu closes → no new tab opens.
 *   5. Right-click on a non-row area (e.g., the roadmap heading) does
 *      NOT surface the custom menu.
 *   6. Right-click on the row body does NOT initiate a drag (regression
 *      catcher for FR-15 — `useSortable` listeners must stay scoped to
 *      the grip-handle button).
 *
 * Setup: reuses the existing `auth.setup.ts` storageState and the
 * env-var-driven fixture pattern from `roadmap-filters-phase2.spec.ts`
 * — the test skips when the fixture env vars are not set, so CI does
 * not fail on machines without a seeded project. Manual operators set
 * `TEST_BACKLOG_CONTEXT_MENU_PROJECT_ID` (and optionally
 * `TEST_BACKLOG_CONTEXT_MENU_PROJECT_SLUG`) plus
 * `TEST_BACKLOG_CONTEXT_MENU_STORY_TITLE` to run locally.
 *
 * Multi-tab note: spec §9.3 explicitly accepts a `test.skip()` if the
 * Playwright runner's CI multi-tab capabilities are unavailable. We
 * surface a per-test skip with a comment pointing back to the spec in
 * that branch.
 */

import { expect, type Page, test } from "@playwright/test";

const TEST_DATA = {
	projectId:
		process.env.TEST_BACKLOG_CONTEXT_MENU_PROJECT_ID ??
		"<backlog-context-menu-project-id>",
	orgSlug: process.env.TEST_BACKLOG_CONTEXT_MENU_PROJECT_SLUG ?? "",
	storyTitle:
		process.env.TEST_BACKLOG_CONTEXT_MENU_STORY_TITLE ??
		"<backlog-context-menu-story-title>",
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
		? `/app/${orgSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
}

async function openRoadmapTab(page: Page): Promise<void> {
	const roadmapTab = page.getByRole("button", { name: "Roadmap" });
	await roadmapTab.waitFor({ state: "visible", timeout: 15_000 });
	await roadmapTab.click();
}

function expectedStoryUrlPrefix(projectId: string, orgSlug: string): string {
	return orgSlug
		? `/app/${orgSlug}/projects/${projectId}/stories/`
		: `/app/projects/${projectId}/stories/`;
}

/** Locate the first `StoryCard` row whose title matches the seeded fixture. */
async function getSeededRow(page: Page): Promise<{
	row: ReturnType<Page["locator"]>;
	dragHandle: ReturnType<Page["locator"]>;
}> {
	await openRoadmapTab(page);
	const title = page.getByTestId("story-card-title").filter({
		hasText: TEST_DATA.storyTitle,
	});
	await title.first().waitFor({ state: "visible", timeout: 15_000 });
	const row = title.first().locator('xpath=ancestor::div[@role="button"][1]');
	const dragHandle = row.getByTestId("story-card-drag-handle");
	return { row, dragHandle };
}

test.describe("Backlog right-click 'Open in new tab' — spec 2026-05-25", () => {
	test.beforeEach(() => {
		skipIfAnyPlaceholder(TEST_DATA.projectId, TEST_DATA.storyTitle);
	});

	test("right-click → menu → 'Open in new tab' opens a new tab with the deep-link URL", async ({
		context,
		page,
	}) => {
		const url = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(url);

		const { row } = await getSeededRow(page);
		await row.click({ button: "right" });

		const item = page.getByRole("menuitem", { name: "Open in new tab" });
		await item.waitFor({ state: "visible", timeout: 5_000 });

		const [newTab] = await Promise.all([
			context.waitForEvent("page"),
			item.click(),
		]);
		await newTab.waitForLoadState("domcontentloaded");

		expect(newTab.url()).toContain(
			expectedStoryUrlPrefix(TEST_DATA.projectId, TEST_DATA.orgSlug),
		);

		// Originating tab is unchanged (still on the backlog).
		expect(page.url()).toContain(url);
		await newTab.close();
	});

	test("middle-click row → new tab with the same URL (FR-9)", async ({
		context,
		page,
	}) => {
		const url = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(url);

		const { row } = await getSeededRow(page);
		// Playwright supports `button: "middle"` for click().
		const [newTab] = await Promise.all([
			context.waitForEvent("page"),
			row.click({ button: "middle" }),
		]);
		await newTab.waitForLoadState("domcontentloaded");

		expect(newTab.url()).toContain(
			expectedStoryUrlPrefix(TEST_DATA.projectId, TEST_DATA.orgSlug),
		);
		await newTab.close();
	});

	test("Shift+F10 on focused row opens the menu; Enter on the focused item opens a new tab (FR-10)", async ({
		context,
		page,
	}) => {
		const url = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(url);

		const { row } = await getSeededRow(page);
		await row.focus();
		await page.keyboard.press("Shift+F10");

		const item = page.getByRole("menuitem", { name: "Open in new tab" });
		await item.waitFor({ state: "visible", timeout: 5_000 });

		const [newTab] = await Promise.all([
			context.waitForEvent("page"),
			page.keyboard.press("Enter"),
		]);
		await newTab.waitForLoadState("domcontentloaded");
		expect(newTab.url()).toContain(
			expectedStoryUrlPrefix(TEST_DATA.projectId, TEST_DATA.orgSlug),
		);
		await newTab.close();
	});

	test("Escape with the menu open dismisses it; no new tab opens (FR-5)", async ({
		page,
	}) => {
		const url = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(url);

		const { row } = await getSeededRow(page);
		await row.click({ button: "right" });

		const item = page.getByRole("menuitem", { name: "Open in new tab" });
		await item.waitFor({ state: "visible", timeout: 5_000 });

		const pageCountBefore = page.context().pages().length;
		await page.keyboard.press("Escape");
		await expect(item).toBeHidden({ timeout: 2_000 });
		expect(page.context().pages().length).toBe(pageCountBefore);
	});

	test("right-click on a non-row area does NOT surface the custom menu (FR-6 scope)", async ({
		page,
	}) => {
		const url = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(url);
		await openRoadmapTab(page);

		// Wait for at least one card to be on screen before targeting the
		// page heading.
		await page
			.getByTestId("story-card-title")
			.first()
			.waitFor({ state: "visible", timeout: 15_000 });

		// Right-click the page-level heading (a non-row area). The custom
		// menu item must not appear.
		const heading = page.getByRole("heading").first();
		await heading.click({ button: "right" });

		const item = page.getByRole("menuitem", { name: "Open in new tab" });
		await expect(item).toBeHidden({ timeout: 1_500 });
	});

	test("right-click on the row body does NOT initiate a drag (FR-15 regression catcher)", async ({
		page,
	}) => {
		const url = roadmapUrl(TEST_DATA.projectId, TEST_DATA.orgSlug);
		await page.goto(url);

		const { row } = await getSeededRow(page);
		const rowBefore = await row.boundingBox();

		await row.click({ button: "right" });

		// Menu opens → no drag has started. Asserting on `data-dragging` /
		// dnd-kit placeholder is fragile across versions; the strongest
		// regression catch is "the row remains in place after a right-click".
		await page
			.getByRole("menuitem", { name: "Open in new tab" })
			.waitFor({ state: "visible", timeout: 5_000 });

		await page.keyboard.press("Escape");
		const rowAfter = await row.boundingBox();
		expect(rowAfter?.y).toBe(rowBefore?.y);
		expect(rowAfter?.x).toBe(rowBefore?.x);
	});
});
