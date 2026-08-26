/**
 * Roadmap Unique Sequential Ticket IDs — E2E (spec 2026-05-21, Group 6)
 *
 * Verifies the end-to-end UX for the per-project sequential identifier
 * allocator and the legacy-prefix search compatibility shim:
 *
 *   • AC4 — Newly created tickets render a plain decimal identifier on the
 *           roadmap card (no `F-`, `B-`, or `US-` prefix).
 *   • AC5 — Successive identifiers are strictly sequential within a project
 *           (N, N+1, N+2, …) — no gaps, no duplicates.
 *   • AC8 — Typing a legacy-format query (`F-<n>`, `B-<n>`) into the roadmap
 *           filter still resolves to a current-format `<n>` row (and the raw
 *           `<n>` query resolves the same row). This is the
 *           `normalizeStoryIdentifierQuery` round-trip from Group 3.
 *
 * Prerequisites
 * -------------
 * - Aspire + web running on :3001 (LOCAL_SETUP.md §1.4) and seeded DB
 *   (§1.6) so the canonical `auth.setup.ts` storage state authenticates.
 * - TEST_PERSONAL_PROJECT_ID env var → a project the seeded user owns that
 *   has an AI provider configured (the CreateStoryDialog gates on
 *   `aiConfig.resolution.getStatus`). The project must have at least one
 *   default `ProjectStoryStatus` (the seed flow guarantees this).
 *
 * Without TEST_PERSONAL_PROJECT_ID the suite self-skips — matches the
 * pattern in `roadmap-ticket-interaction.spec.ts` and
 * `pm-import-filtering.spec.ts`.
 *
 * The spec creates new rows on every run; it does NOT clean them up
 * (parallels existing roadmap E2Es). Run against a disposable / dev project.
 *
 * Run:
 *   TEST_PERSONAL_PROJECT_ID=<id> pnpm --filter web e2e tests/stories/unique-sequential-ticket-ids.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_DATA = {
	projectId: process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
} as const;

function skipIfNoData(projectId: string): void {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to a project's Roadmap tab and wait for cards to render. */
async function gotoRoadmap(page: Page, projectId: string): Promise<void> {
	await page.goto(`/app/projects/${projectId}`);
	await page.getByRole("tab", { name: /Roadmap/i }).click();
	await page.waitForLoadState("networkidle");
}

/**
 * Read all identifiers currently visible on the roadmap. The identifier
 * lives in a `font-mono tabular-nums` span next to the title — see
 * StoryCard.tsx line ~726. Returns a sorted-asc array of numeric values for
 * plain-decimal identifiers (legacy `F-001`/`B-011` values are filtered out
 * since they are not part of the current allocator's range).
 */
async function readVisibleNumericIdentifiers(page: Page): Promise<number[]> {
	// The identifier span has these exact class fragments (StoryCard.tsx
	// line 726). Using a class-attribute substring keeps the locator stable
	// across Tailwind reorderings while still scoping tightly enough that we
	// don't catch unrelated `font-mono` elements elsewhere on the page.
	const idSpans = page.locator(
		"span.font-mono.tabular-nums.text-muted-foreground\\/50",
	);
	const count = await idSpans.count();
	const numbers: number[] = [];
	for (let i = 0; i < count; i++) {
		const text = (await idSpans.nth(i).innerText()).trim();
		if (/^\d+$/.test(text)) {
			numbers.push(Number.parseInt(text, 10));
		}
	}
	return numbers.sort((a, b) => a - b);
}

/**
 * Create a feature via the roadmap "Add" button → CreateStoryDialog.
 * The dialog is description-only; title is generated server-side from the
 * description. The AI classifier decides FEATURE vs BUG — the descriptions
 * passed in below are written to bias toward FEATURE.
 */
async function createWorkItem(page: Page, description: string): Promise<void> {
	await page.getByRole("button", { name: /^Add$/ }).click();

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("heading", { name: /Create work item/i }),
	).toBeVisible();

	await dialog
		.getByPlaceholder(/Describe what's needed or what's broken/i)
		.fill(description);

	// Submit. The dialog closes itself on success (see StoriesRoadmap.tsx
	// mutation onSuccess), then a `toast.success("titleGenerated")` flashes.
	await dialog.getByRole("button", { name: /^Create$/i }).click();

	// Allow the optimistic insert + server round-trip to settle on the page.
	// The dialog closes synchronously on success; the card may take an extra
	// network tick to appear in the roadmap list.
	await expect(dialog).not.toBeVisible({ timeout: 30_000 });
	await page.waitForLoadState("networkidle");
}

/** Fill the roadmap search input. The input has aria-label set by
 *  RoadmapFilterToolbar.tsx line 701. */
async function setRoadmapFilter(page: Page, query: string): Promise<void> {
	const input = page.getByRole("textbox", { name: /Search roadmap items/i });
	await input.fill(query);
	// The filter debounces on input; allow the debounce + re-render to settle.
	await page.waitForTimeout(500);
}

/** Locate a roadmap card by its (numeric) identifier text. */
function cardByIdentifier(page: Page, identifier: string) {
	return page
		.locator("span.font-mono.tabular-nums.text-muted-foreground\\/50")
		.filter({ hasText: new RegExp(`^${identifier}$`) });
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

test.describe("Roadmap unique sequential ticket IDs (spec 2026-05-21)", () => {
	test.beforeEach(() => {
		skipIfNoData(TEST_DATA.projectId);
	});

	test("AC4 + AC5 + AC8: plain-decimal, sequential, legacy-prefix searchable", async ({
		page,
	}) => {
		await gotoRoadmap(page, TEST_DATA.projectId);

		// --- Baseline -----------------------------------------------------
		// Capture the current max numeric identifier on the roadmap so we
		// can predict the next two assignments. We don't assume an empty
		// project — `allocateNextStoryNumber` is the single source of
		// truth, so two new rows are guaranteed to be (max+1) and (max+2)
		// regardless of any pre-existing rows.
		const baseline = await readVisibleNumericIdentifiers(page);
		const baselineMax =
			baseline.length > 0 ? baseline[baseline.length - 1] : 0;
		const expectedFirst = baselineMax + 1;
		const expectedSecond = baselineMax + 2;

		// --- AC4: first feature renders a plain decimal identifier -------
		// Description is intentionally feature-shaped ("Add …") so the AI
		// classifier routes it to FEATURE rather than BUG.
		await createWorkItem(
			page,
			`Add a project audit-log export button for spec 2026-05-21 run ${Date.now()}`,
		);

		const firstCard = cardByIdentifier(page, String(expectedFirst));
		await expect(firstCard).toBeVisible({ timeout: 15_000 });
		const firstIdentifierText = (await firstCard.innerText()).trim();
		expect(firstIdentifierText).toMatch(/^\d+$/);
		expect(firstIdentifierText).not.toMatch(/^[FBU]-/i);
		expect(firstIdentifierText).not.toMatch(/^TASK-/i);

		// --- AC5: second feature is exactly previous + 1 -----------------
		await createWorkItem(
			page,
			`Add weekly delivery summary email for spec 2026-05-21 run ${Date.now()}`,
		);

		const secondCard = cardByIdentifier(page, String(expectedSecond));
		await expect(secondCard).toBeVisible({ timeout: 15_000 });
		const secondIdentifierText = (await secondCard.innerText()).trim();
		expect(secondIdentifierText).toMatch(/^\d+$/);
		expect(Number.parseInt(secondIdentifierText, 10)).toBe(
			Number.parseInt(firstIdentifierText, 10) + 1,
		);

		// --- AC8: legacy-prefix search still resolves --------------------
		// Type `F-<n>` and expect the first feature row to remain visible.
		// `normalizeStoryIdentifierQuery` strips the `F-` so the haystack
		// match falls through to the plain numeric identifier.
		await setRoadmapFilter(page, `F-${expectedFirst}`);
		await expect(
			cardByIdentifier(page, String(expectedFirst)),
		).toBeVisible();

		// And the raw number resolves the same row (control case).
		await setRoadmapFilter(page, String(expectedFirst));
		await expect(
			cardByIdentifier(page, String(expectedFirst)),
		).toBeVisible();

		// Clear the filter so the bug-conversion step starts fresh.
		await setRoadmapFilter(page, "");
	});

	test("AC8 (bug variant): `B-<n>` resolves a BUG row after kind conversion", async ({
		page,
	}) => {
		await gotoRoadmap(page, TEST_DATA.projectId);

		// Create one work item, then convert it to a BUG via the kebab
		// "Change to bug" action. This avoids depending on the AI
		// classifier picking BUG (which is non-deterministic in E2E) — the
		// convert-kind path preserves the identifier (see spec AC3) so we
		// still get to test legacy `B-<n>` search against a bug-kinded row
		// with a plain numeric identifier.
		//
		// Fizzy #2048 made a conversion also REDRAFT the work item's body
		// through the new type's template. This path is still AI-free and
		// still fast, and deliberately so: the conversion procedure returns
		// as soon as the kind flip lands, and the redraft runs afterwards in
		// a Temporal workflow the front end merely polls. Nothing asserted
		// below waits on that redraft — the identifier, which is what this
		// test is about, is not something the redraft touches. Do not add a
		// wait for the "Rewriting" chip here; that would put a model call on
		// this test's critical path.
		const baseline = await readVisibleNumericIdentifiers(page);
		const baselineMax =
			baseline.length > 0 ? baseline[baseline.length - 1] : 0;
		const expected = baselineMax + 1;

		await createWorkItem(
			page,
			`Investigate a checkout-flow defect for spec 2026-05-21 run ${Date.now()}`,
		);

		const card = cardByIdentifier(page, String(expected));
		await expect(card).toBeVisible({ timeout: 15_000 });

		// Walk from the identifier span up to the card root so we can find
		// the kebab — same shape as roadmap-ticket-interaction.spec.ts R3.
		const cardRoot = card.locator(
			"xpath=ancestor::*[descendant::button[contains(@aria-label, 'Open details for')]][1]",
		);
		// Hover to reveal the icon-only kebab (opacity-0 → opacity-100).
		await cardRoot.hover();
		const moreBtn = cardRoot
			.getByRole("button")
			.filter({ hasNotText: /Open details for|Select/ })
			.last();
		await moreBtn.click();
		await expect(page.getByRole("menu")).toBeVisible();

		// "Change to bug" lives on the kebab dropdown. If this run already
		// created a BUG via the AI classifier (unlikely with the
		// feature-shaped description above, but possible), the label flips
		// to "Change to feature" — guard so the test stays robust.
		const changeToBug = page.getByRole("menuitem", {
			name: /Change to bug/i,
		});
		if (
			await changeToBug.isVisible({ timeout: 1_000 }).catch(() => false)
		) {
			await changeToBug.click();
			// ConvertKindConfirmDialog renders an AlertDialog (role="alertdialog").
			const confirmDialog = page.getByRole("alertdialog");
			await expect(confirmDialog).toBeVisible();
			await confirmDialog
				.getByRole("button", { name: /^Change to bug$/i })
				.click();
			await expect(confirmDialog).not.toBeVisible({ timeout: 10_000 });
		} else {
			// Already a bug (AI classifier routed it). Close the dropdown
			// and proceed straight to the filter check.
			await page.keyboard.press("Escape");
		}

		// AC8 round-trip: `B-<n>` resolves the row.
		await setRoadmapFilter(page, `B-${expected}`);
		await expect(cardByIdentifier(page, String(expected))).toBeVisible();

		// Raw number also resolves (control).
		await setRoadmapFilter(page, String(expected));
		await expect(cardByIdentifier(page, String(expected))).toBeVisible();

		// Clear filter for cleanliness.
		await setRoadmapFilter(page, "");
	});
});
