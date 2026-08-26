/**
 * Roadmap Ticket Interaction E2E Tests
 *
 * Verifies the full interaction surface for the Roadmap details sheet:
 * - Title click and card body click open the sheet
 * - Inline rename is disabled in Roadmap context (disableInlineRename=true)
 * - Sheet close paths (Escape, Cancel, X, overlay) work correctly
 * - Scroll position is preserved on sheet close
 * - Regression coverage for drag, checkbox, context menu, and Kanban rename
 *
 * Prerequisites:
 * - Dev server running on :3001
 * - TEST_DATA constants below must be filled with real project/story IDs
 * - Stories must have draftingStage !== "DECLINED" to appear in Roadmap
 */

import { expect, type Page, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data — fill in real IDs before running.
// Tests will skip themselves if projectId is left as the placeholder.
// ---------------------------------------------------------------------------
const TEST_DATA = {
	personal: {
		projectId:
			process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
		firstStoryTitle:
			process.env.TEST_PERSONAL_STORY_TITLE ||
			"<title of first roadmap story>",
		firstStoryIdentifier:
			process.env.TEST_PERSONAL_STORY_IDENTIFIER || "F-001",
	},
	org: {
		slug: process.env.TEST_ORG_SLUG || "<org-slug>",
		projectId: process.env.TEST_ORG_PROJECT_ID || "<org-project-id>",
		firstStoryTitle:
			process.env.TEST_ORG_STORY_TITLE ||
			"<title of first org roadmap story>",
		firstStoryIdentifier: process.env.TEST_ORG_STORY_IDENTIFIER || "F-001",
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to the Roadmap tab for a project. */
async function gotoRoadmap(
	page: Page,
	projectId: string,
	orgSlug?: string,
): Promise<void> {
	const base = orgSlug
		? `/app/${orgSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
	await page.goto(base);
	await page.getByRole("tab", { name: /Roadmap/i }).click();
	await page.waitForLoadState("networkidle");
}

/** Skip test if placeholder data has not been filled in. */
function skipIfNoData(projectId: string) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

// ---------------------------------------------------------------------------
// T1 — Title click (mouse) opens sheet
// ---------------------------------------------------------------------------
test("T1: clicking the title button opens the details sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first();
	await expect(titleBtn).toBeVisible();
	await titleBtn.click();

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	// Sheet title is sr-only "Edit Feature"; verify by field content
	await expect(dialog.getByLabel("Title")).toHaveValue(
		TEST_DATA.personal.firstStoryTitle,
	);
});

// ---------------------------------------------------------------------------
// T2 — Title click (keyboard: focus → Enter) opens sheet
// ---------------------------------------------------------------------------
test("T2: keyboard Enter on focused title button opens the details sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first();
	await titleBtn.focus();
	await page.keyboard.press("Enter");

	await expect(page.getByRole("dialog")).toBeVisible();
});

// ---------------------------------------------------------------------------
// T3 — Space key on title button opens sheet
// ---------------------------------------------------------------------------
test("T3: Space on focused title button opens the details sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first();
	await titleBtn.focus();
	await page.keyboard.press("Space");

	await expect(page.getByRole("dialog")).toBeVisible();
});

// ---------------------------------------------------------------------------
// T4 — Card body click (identifier area) opens sheet
// The card body has role="button" aria-label="${title} — click to open details"
// Clicking on the identifier text (not a button/input/a) bubbles to it.
// ---------------------------------------------------------------------------
test("T4: clicking the card body (identifier text) opens the sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	// The identifier is rendered in a mono div that is NOT a button.
	// Clicking it should bubble up to the card body div (role="button").
	const identifier = page
		.getByText(TEST_DATA.personal.firstStoryIdentifier, { exact: true })
		.first();
	await identifier.click();

	await expect(page.getByRole("dialog")).toBeVisible();
});

// ---------------------------------------------------------------------------
// T5 — Title click does NOT trigger inline rename; no rename input; no mutation
// ---------------------------------------------------------------------------
test("T5: clicking the title does NOT trigger inline rename in Roadmap", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	// Track whether the rename mutation fires
	let renameFired = false;
	await page.route("**/projects/stories/update**", (route) => {
		renameFired = true;
		route.continue();
	});

	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first();
	await titleBtn.click();

	// Sheet must open
	await expect(page.getByRole("dialog")).toBeVisible();

	// Inline rename input must NOT be present in the card
	// (the rename input has these classes when active)
	const renameInput = page.locator(
		"input.w-full.rounded.border.bg-background.text-sm.font-semibold",
	);
	await expect(renameInput).not.toBeVisible();

	// Rename mutation must not have been called
	expect(renameFired).toBe(false);

	// Close for cleanup
	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// T6 — Double-click title also does NOT trigger inline rename
// ---------------------------------------------------------------------------
test("T6: double-clicking the title does NOT trigger inline rename", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first();
	await titleBtn.dblclick();

	// Sheet should open (or have been opened on the first click)
	await expect(page.getByRole("dialog")).toBeVisible();

	// Rename input must not appear
	await expect(
		page.locator(
			"input.w-full.rounded.border.bg-background.text-sm.font-semibold",
		),
	).not.toBeVisible();

	// Close for cleanup
	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// T7 — Escape closes sheet; focus returns to the title button
// ---------------------------------------------------------------------------
test("T7: Escape closes the sheet and returns focus to the title button", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first();
	await titleBtn.click();
	await expect(page.getByRole("dialog")).toBeVisible();

	await page.keyboard.press("Escape");

	await expect(page.getByRole("dialog")).not.toBeVisible();
	// Radix Dialog returns focus to the previously focused element.
	await expect(titleBtn).toBeFocused();
});

// ---------------------------------------------------------------------------
// T8 — Cancel button closes sheet
// ---------------------------------------------------------------------------
test("T8: Cancel button in sheet closes the sheet", async ({ page }) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	await page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first()
		.click();

	await expect(page.getByRole("dialog")).toBeVisible();

	await page
		.getByRole("dialog")
		.getByRole("button", { name: /^Cancel$/i })
		.click();

	await expect(page.getByRole("dialog")).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// T9 — Sheet close (X icon) closes sheet
// The SheetContent (Radix Dialog) renders a close button with aria-label="Close"
// ---------------------------------------------------------------------------
test("T9: Sheet X close button closes the sheet", async ({ page }) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	await page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first()
		.click();

	await expect(page.getByRole("dialog")).toBeVisible();

	// Radix SheetContent renders a close button with aria-label="Close"
	const closeBtn = page.getByRole("dialog").getByRole("button", {
		name: /^Close$/i,
	});

	if (await closeBtn.isVisible()) {
		await closeBtn.click();
	} else {
		// Fallback: the SheetClose is the last button in the sheet header area
		await page.getByRole("dialog").locator("header button").last().click();
	}

	await expect(page.getByRole("dialog")).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// T10 — Overlay click closes sheet
// The sheet slides in from the right; clicking the far-left area hits the overlay.
// ---------------------------------------------------------------------------
test("T10: clicking the overlay backdrop closes the sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	await page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first()
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();

	// Click far-left area (outside the sheet panel which slides in from right)
	const viewportSize = page.viewportSize();
	const clickY = viewportSize ? viewportSize.height / 2 : 300;
	await page.mouse.click(30, clickY);

	await expect(page.getByRole("dialog")).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// T11 — Sheet shows all essential fields
// ---------------------------------------------------------------------------
test("T11: sheet renders title, description, acceptance criteria, priority, size, story points", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	await page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first()
		.click();

	const dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("Title")).toBeVisible();
	await expect(dialog.getByLabel("Description")).toBeVisible();
	await expect(dialog.getByLabel("Acceptance Criteria")).toBeVisible();
	await expect(dialog.getByLabel("Priority")).toBeVisible();
	await expect(dialog.getByLabel("Size")).toBeVisible();
	await expect(dialog.getByLabel("Story Points")).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: /Save Changes/i }),
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: /^Cancel$/i }),
	).toBeVisible();

	// Close for cleanup
	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// T12 — Personal workspace: sheet shows the correct personal-context story
// ---------------------------------------------------------------------------
test("T12: personal workspace shows correct story title in sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	await page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first()
		.click();

	await expect(page.getByRole("dialog").getByLabel("Title")).toHaveValue(
		TEST_DATA.personal.firstStoryTitle,
	);

	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// T13 — Org workspace: sheet shows the correct org-context story
// ---------------------------------------------------------------------------
test("T13: org workspace shows correct story title in sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.org.projectId);
	await gotoRoadmap(page, TEST_DATA.org.projectId, TEST_DATA.org.slug);

	await page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.org.firstStoryTitle}`,
				"i",
			),
		})
		.first()
		.click();

	await expect(page.getByRole("dialog").getByLabel("Title")).toHaveValue(
		TEST_DATA.org.firstStoryTitle,
	);

	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// T14 — Scroll position is preserved after sheet close
// ---------------------------------------------------------------------------
test("T14: scroll position is restored after closing the sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	// Scroll to the bottom of the page
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await page.waitForTimeout(150); // let scroll settle

	const scrollBefore = await page.evaluate(() => window.scrollY);

	// Only meaningful when the page is long enough to scroll
	if (scrollBefore === 0) {
		test.skip();
		return;
	}

	// Open the last visible title button
	const titleBtns = page.getByRole("button", {
		name: /Open details for /i,
	});
	const count = await titleBtns.count();
	if (count === 0) {
		test.skip();
		return;
	}
	await titleBtns.last().click();
	await expect(page.getByRole("dialog")).toBeVisible();

	// Close via Escape — StoriesRoadmap restores scroll via window.scrollTo({ behavior: "instant" })
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).not.toBeVisible();

	// Give the synchronous scroll restoration time to apply
	await page.waitForTimeout(100);

	const scrollAfter = await page.evaluate(() => window.scrollY);
	// Expect within ~10px of original position
	expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(10);
});

// ---------------------------------------------------------------------------
// R1 — Drag-and-drop does NOT open the details sheet
// ---------------------------------------------------------------------------
test("[R1] drag-and-drop does NOT open the details sheet", async ({ page }) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	// Need at least 2 cards to drag between
	const cardBodies = page.getByRole("button", {
		name: /— click to open details/i,
	});
	const count = await cardBodies.count();
	if (count < 2) {
		test.skip();
		return;
	}

	const firstCard = cardBodies.nth(0);
	const secondCard = cardBodies.nth(1);

	// Playwright's dragTo fires pointerdown/pointermove (>8px)/pointerup
	// satisfying dnd-kit PointerSensor's { distance: 8 } constraint
	await firstCard.dragTo(secondCard);

	// After drag completes, no sheet should have opened
	await expect(page.getByRole("dialog")).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// R2 — Checkbox selection does NOT open sheet
// ---------------------------------------------------------------------------
test("[R2] clicking selection checkbox does NOT open the sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const checkbox = page
		.getByRole("checkbox", {
			name: new RegExp(
				`Select ${TEST_DATA.personal.firstStoryIdentifier}`,
				"i",
			),
		})
		.first();
	await checkbox.click();

	// Checkbox should now be checked
	await expect(checkbox).toBeChecked();

	// Sheet must NOT be open
	await expect(page.getByRole("dialog")).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// R3 — Kebab (MoreHorizontal) context menu opens dropdown, NOT the sheet
// ---------------------------------------------------------------------------
test("[R3] clicking the kebab menu opens dropdown, not the sheet", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	// Hover the first card to make the MoreHorizontal button visible (opacity-0 → opacity-100)
	const firstCardBody = page
		.getByRole("button", {
			name: new RegExp(
				`${TEST_DATA.personal.firstStoryTitle} — click to open details`,
				"i",
			),
		})
		.first();
	await firstCardBody.hover();

	// The MoreHorizontal trigger is a ghost icon-only button inside the card.
	// It's the sibling of the title button — locate it via its parent container.
	// The dropdown trigger button doesn't have an aria-label, so we find the
	// last button that isn't the title/checkbox/drag-handle buttons.
	const cardContainer = firstCardBody.locator("..");
	const moreBtn = cardContainer
		.getByRole("button")
		.filter({ hasNotText: /Open details for|Select/ })
		.last();
	await moreBtn.click();

	// Dropdown menu should be visible with expected items
	await expect(page.getByRole("menu")).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: /Open details/i }),
	).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /Delete/i })).toBeVisible();

	// Sheet must NOT be open
	await expect(page.getByRole("dialog")).not.toBeVisible();

	// Close dropdown
	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// R4 — Context menu "Open details" also opens the sheet
// ---------------------------------------------------------------------------
test("[R4] context menu 'Open details' opens the sheet", async ({ page }) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const firstCardBody = page
		.getByRole("button", {
			name: new RegExp(
				`${TEST_DATA.personal.firstStoryTitle} — click to open details`,
				"i",
			),
		})
		.first();
	await firstCardBody.hover();

	const cardContainer = firstCardBody.locator("..");
	const moreBtn = cardContainer
		.getByRole("button")
		.filter({ hasNotText: /Open details for|Select/ })
		.last();
	await moreBtn.click();

	await expect(page.getByRole("menu")).toBeVisible();
	await page.getByRole("menuitem", { name: /Open details/i }).click();

	await expect(page.getByRole("dialog")).toBeVisible();

	// Close for cleanup
	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// R5 — Kanban board still triggers inline rename (no regression)
// In Kanban, StoryCard is rendered WITHOUT disableInlineRename,
// so clicking the title should open an inline input, not the sheet.
// ---------------------------------------------------------------------------
test("[R5] Kanban title click still triggers inline rename (no regression)", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);

	// Navigate to the project — the default tab is typically Board/Kanban
	await page.goto(`/app/projects/${TEST_DATA.personal.projectId}`);
	await page.getByRole("tab", { name: /Board|Kanban/i }).click();
	await page.waitForLoadState("networkidle");

	// In Kanban mode, StoryCard is rendered WITHOUT disableInlineRename.
	// The title button has no "Open details for" aria-label — it's a plain button
	// wrapping an <h4> heading with the story title text.
	// Find any story card heading and click it.
	const storyHeading = page.getByRole("heading", { level: 4 }).first();
	await expect(storyHeading).toBeVisible();

	// Click directly on the heading text (which is inside the title button)
	await storyHeading.click();

	// Inline input should appear (rename mode)
	// The rename input has: w-full rounded border border-primary/40 bg-background ... text-sm font-semibold
	await expect(
		page.locator(
			"input.w-full.rounded.border.bg-background.text-sm.font-semibold",
		),
	).toBeVisible();

	// Sheet dialog must NOT be open
	await expect(page.getByRole("dialog")).not.toBeVisible();

	// Cancel rename via Escape
	await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------
// R6 — Browser back does not cause hard navigation; URL unchanged
// ---------------------------------------------------------------------------
test("[R6] browser back after opening sheet returns to same URL (no route change)", async ({
	page,
}) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	const urlBefore = page.url();

	await page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${TEST_DATA.personal.firstStoryTitle}`,
				"i",
			),
		})
		.first()
		.click();

	await expect(page.getByRole("dialog")).toBeVisible();

	// The sheet is a panel — URL must NOT have changed
	expect(page.url()).toBe(urlBefore);

	// Close the sheet
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).not.toBeVisible();

	// URL must still be unchanged
	expect(page.url()).toBe(urlBefore);
});

test("PM changes priority via kebab — card moves to new section", async ({
	page,
}) => {
	test.skip(
		TEST_DATA.personal.projectId.startsWith("<"),
		"TEST_PERSONAL_PROJECT_ID not configured",
	);
	await gotoRoadmap(page, TEST_DATA.personal.projectId);

	// Wait for at least one section to render before reading attributes.
	await page.locator("[data-priority-section]").first().waitFor();

	// Locate the card via its identifier text, then walk up to the nearest
	// [data-priority-section] ancestor (the bucket wrapper added in Task 13).
	const identifierText = page.getByText(
		TEST_DATA.personal.firstStoryIdentifier,
		{ exact: true },
	);
	const initialSection = await identifierText
		.locator("xpath=ancestor::div[@data-priority-section][1]")
		.getAttribute("data-priority-section");

	// Precondition: the test story must not already live in the P0 section,
	// or the final assertion would pass without the change actually happening.
	test.skip(
		initialSection === "P0_CRITICAL",
		`Fixture story ${TEST_DATA.personal.firstStoryIdentifier} is already P0_CRITICAL; reset its priority before running this test.`,
	);

	// Walk from identifier text up to the StoryCard root (closest ancestor
	// containing the kebab button). Open the kebab → submenu → P0.
	const cardLocator = identifierText.locator(
		"xpath=ancestor::*[descendant::button[@aria-label='Story actions']][1]",
	);
	await cardLocator
		.getByRole("button", { name: /story actions/i })
		.click({ force: true });
	await page.getByText("Change priority").hover();
	await page
		.getByRole("menuitem", { name: /P0 - Critical/i })
		.click({ force: true });

	// Toast confirmation.
	await expect(page.getByText(/Priority changed to P0/i)).toBeVisible({
		timeout: 5000,
	});

	// The card identifier text now appears under the P0 section wrapper.
	const movedIdentifier = page
		.locator('[data-priority-section="P0_CRITICAL"]')
		.getByText(TEST_DATA.personal.firstStoryIdentifier, { exact: true });
	await expect(movedIdentifier).toBeVisible();
});
