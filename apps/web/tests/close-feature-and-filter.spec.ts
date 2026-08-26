/**
 * Hide Features & Filter — E2E
 *
 * Full lifecycle scenario for spec docs/specs/2026-04-22-close-features-and-filter
 * §10.2:
 *   1. Navigate to Roadmap for a project that has at least one DRAFT feature.
 *   2. Open the first feature's kebab → "Hide feature".
 *   3. Assert success toast "Feature hidden" appears and the card is hidden in the
 *      default (hidden-hidden) view.
 *   4. Toggle "Show hidden work items" on → card is visible again with "Hidden" chip.
 *   5. Open the kebab → "Unhide feature".
 *   6. Assert "Feature unhidden" toast; the "Hidden" chip is gone; card remains
 *      visible regardless of toggle state.
 *   7. Toggle the switch off → the (now-active) card is still visible.
 *
 * Prerequisites:
 *   - Dev server running on :3001
 *   - TEST_PERSONAL_PROJECT_ID / TEST_PERSONAL_STORY_TITLE env vars point at a
 *     project that has at least one feature currently in DRAFT (so the kebab
 *     exposes "Hide feature" on the first run).
 *   - The story must leave the Roadmap in the same DRAFT state between runs; the
 *     spec unhides it explicitly at the end to DRAFT, matching the MVP unhide
 *     target.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data — follows the same pattern as roadmap-ticket-interaction.spec.ts
// ---------------------------------------------------------------------------
const TEST_DATA = {
	personal: {
		projectId:
			process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
		firstStoryTitle:
			process.env.TEST_PERSONAL_STORY_TITLE ||
			"<title of first roadmap story>",
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function skipIfNoData(projectId: string) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

/**
 * Locate a StoryCard's body by title. The card body is rendered with
 * role="button" and aria-label "<title> — click to open details".
 */
function cardByTitle(page: Page, title: string): Locator {
	return page
		.getByRole("button", {
			name: new RegExp(
				`${escapeRegex(title)} — click to open details`,
				"i",
			),
		})
		.first();
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Open the kebab (MoreHorizontal) dropdown on a given card. The kebab is the
 * icon-only dropdown trigger inside the card body; we locate it the same way
 * as roadmap-ticket-interaction.spec.ts R3.
 */
async function openCardKebab(page: Page, card: Locator): Promise<void> {
	await card.hover();
	const cardContainer = card.locator("..");
	const moreBtn = cardContainer
		.getByRole("button")
		.filter({ hasNotText: /Open details for|Select/ })
		.last();
	await moreBtn.click();
	await expect(page.getByRole("menu")).toBeVisible();
}

/** Toggle the "Show / Hide hidden work items" filter button to the desired state. */
async function setShowClosed(page: Page, value: boolean): Promise<void> {
	const toggle = page.getByRole("button", {
		name: /(Show|Hide).*work items/i,
	});
	await expect(toggle).toBeVisible();
	const current = (await toggle.getAttribute("aria-pressed")) === "true";
	if (current !== value) {
		await toggle.click();
	}
	await expect(toggle).toHaveAttribute(
		"aria-pressed",
		value ? "true" : "false",
	);
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

test("hide → toggle-show → unhide → toggle-off lifecycle", async ({ page }) => {
	skipIfNoData(TEST_DATA.personal.projectId);
	const { projectId, firstStoryTitle } = TEST_DATA.personal;

	await gotoRoadmap(page, projectId);

	// Default state: filter button unpressed, card visible
	const toggle = page.getByRole("button", {
		name: /Show hidden work items/i,
	});
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");

	const card = cardByTitle(page, firstStoryTitle);
	await expect(card).toBeVisible();

	// ----- 1. Hide the feature via the kebab -----
	await openCardKebab(page, card);
	await page.getByRole("menuitem", { name: /^Hide feature$/i }).click();

	// Success toast
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: /Feature hidden/i })
			.first(),
	).toBeVisible();

	// Card hidden in default (hidden-filtered) view
	await expect(cardByTitle(page, firstStoryTitle)).toHaveCount(0);

	// ----- 2. Toggle "Show hidden features" ON → card reappears with chip -----
	await setShowClosed(page, true);

	const reappeared = cardByTitle(page, firstStoryTitle);
	await expect(reappeared).toBeVisible();

	// The Hidden chip is rendered inside the card container via DRAFTING_STAGE_META.
	// Scope to the card's container so we don't catch a "Hidden" label elsewhere.
	const cardContainer = reappeared.locator("..");
	await expect(cardContainer.getByText(/^Hidden$/i).first()).toBeVisible();

	// ----- 3. Unhide via the kebab -----
	await openCardKebab(page, reappeared);
	await page.getByRole("menuitem", { name: /^Unhide feature$/i }).click();

	await expect(
		page
			.getByRole("status")
			.filter({ hasText: /Feature unhidden/i })
			.first(),
	).toBeVisible();

	// Card remains visible; Hidden chip must be gone
	const activeCard = cardByTitle(page, firstStoryTitle);
	await expect(activeCard).toBeVisible();
	await expect(activeCard.locator("..").getByText(/^Hidden$/i)).toHaveCount(
		0,
	);

	// ----- 4. Toggle OFF → card is still visible (it is no longer hidden) -----
	await setShowClosed(page, false);
	await expect(cardByTitle(page, firstStoryTitle)).toBeVisible();
});
