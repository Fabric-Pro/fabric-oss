/**
 * Contextual Action Tooltips -- E2E Coverage
 *
 * Exercises the top-10 anchor actions from
 * `docs/specs/2026-04-20-contextual-action-tooltips/spec.md` §11.1 plus the
 * delay and a11y checks from §10.3 / §10.4. The spec calls for twelve
 * concrete cases (see `tasks.md` Task 4.2); each `test()` below maps one row
 * to one case.
 *
 * Prerequisites:
 * - Dev server running on :3001 (Playwright config handles this).
 * - Auth state produced by `auth.setup.ts` (storageState).
 * - TEST_DATA below must reference a project whose pipeline tab has:
 *     a) at least one PRD/selected docs so the primary action row renders,
 *     b) a generated Features document already pushed to the Roadmap (so
 *        `Already Pushed` and the `Start Fresh` amber banner are visible).
 *   Tests that rely on that state self-skip if the placeholder is unchanged.
 * - The destructive `<DestructiveTooltip>` primitive renders its content with
 *   `data-slot="destructive-tooltip-content"`. Tests locate
 *   tooltips by accessible role first and fall back to that slot attribute.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data -- fill in real IDs via env before running.
// Tests self-skip if the placeholder values are left in place.
// ---------------------------------------------------------------------------
const TEST_DATA = {
	personal: {
		projectId:
			process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
		documentId:
			process.env.TEST_PERSONAL_DOCUMENT_ID || "<personal-document-id>",
	},
};

// Delay the global TooltipProvider uses per spec §6.1 (AC-10).
const TOOLTIP_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipIfNoData(value: string): void {
	if (value.startsWith("<")) {
		test.skip();
	}
}

async function gotoProjectTab(
	page: Page,
	projectId: string,
	tabName: RegExp,
	orgSlug?: string,
): Promise<void> {
	const base = orgSlug
		? `/app/${orgSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
	await page.goto(base);
	await page.waitForLoadState("networkidle");

	// TODO: the project tab navigation uses plain <button> elements. Text
	// tabs (Pipeline, Documents, etc.) match by accessible name; icon-only
	// tabs (Settings) expose their label only through a hover tooltip and
	// need a different hook. If the text match misses, fall back to the
	// hover-tooltip label.
	const byText = page.getByRole("button", { name: tabName });
	if (
		await byText
			.first()
			.isVisible()
			.catch(() => false)
	) {
		await byText.first().click();
	} else {
		// For icon-only tabs, target the button whose sibling tooltip matches.
		const fallback = page
			.locator("button", { has: page.locator("svg") })
			.filter({ hasText: tabName });
		await fallback.first().click();
	}
	await page.waitForLoadState("networkidle");
}

/**
 * Hover a trigger, wait past the configured delay, and return the tooltip
 * content locator. Prefers accessible roles; falls back to the destructive
 * slot attribute when a destructive tooltip renders `role="alert"` (keyboard
 * focus path) and no `role="tooltip"` is exposed.
 */
async function hoverAndGetTooltip(
	page: Page,
	trigger: Locator,
): Promise<Locator> {
	await trigger.hover();
	// Slightly above the 500ms default so we're firmly past the open delay.
	await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);
	const byRole = page.getByRole("tooltip");
	if (await byRole.count()) {
		return byRole.first();
	}
	return page.locator("[data-slot='destructive-tooltip-content']").first();
}

/**
 * Locate the destructive tooltip content by the spec-defined slot attribute.
 * This is the only reliable way to reach the destructive content regardless
 * of whether the open was keyboard-initiated (role="alert") or pointer
 * (role="tooltip").
 */
function destructiveContent(page: Page): Locator {
	return page.locator("[data-slot='destructive-tooltip-content']");
}

// ---------------------------------------------------------------------------
// 1-2, 11-12: Feature Pipeline -- Start Fresh (destructive, top-10 #1)
// ---------------------------------------------------------------------------

test.describe("Feature pipeline -- Start Fresh", () => {
	test.beforeEach(async ({ page }) => {
		skipIfNoData(TEST_DATA.personal.projectId);
		await gotoProjectTab(page, TEST_DATA.personal.projectId, /Pipeline/i);
	});

	test("hover shows destructive tooltip with red accent and Warning copy", async ({
		page,
	}) => {
		const startFresh = page.getByRole("button", {
			name: /start fresh/i,
		});
		await expect(startFresh).toBeVisible();

		await startFresh.hover();
		await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);

		const content = destructiveContent(page).first();
		await expect(content).toBeVisible();
		await expect(content).toContainText(/Warning:/);
		// AlertTriangleIcon carries aria-hidden per the primitive spec.
		await expect(content.locator("svg[aria-hidden='true']")).toBeVisible();
		// Background is the destructive token, not the default foreground pill.
		await expect(content.locator(".bg-destructive").first()).toBeVisible();
	});

	test("keyboard focus exposes role='alert' in the DOM", async ({ page }) => {
		const startFresh = page.getByRole("button", {
			name: /start fresh/i,
		});
		await expect(startFresh).toBeVisible();

		await startFresh.focus();
		await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);

		// role='alert' is on an inner <div> inside the destructive content per
		// the primitive's implementation.
		await expect(page.getByRole("alert").first()).toBeVisible();
		await expect(page.getByRole("alert").first()).toContainText(/Warning:/);
	});

	test("axe snapshot on pipeline page after focusing Start Fresh has no new violations", async () => {
		test.fixme(
			true,
			"Requires @axe-core/playwright which is not yet installed. Install with `pnpm --filter web add -D @axe-core/playwright`, then replace this fixme with an AxeBuilder({ page }).analyze() call and assert result.violations is empty.",
		);
		// Intended implementation once the dependency lands:
		//
		// import AxeBuilder from "@axe-core/playwright";
		// const startFresh = page.getByRole("button", { name: /start fresh/i });
		// await startFresh.focus();
		// await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);
		// const results = await new AxeBuilder({ page })
		//     .include("main")
		//     .analyze();
		// expect(results.violations).toEqual([]);
	});

	test("keyboard-only: tab to Start Fresh opens role='alert'; blur closes it", async ({
		page,
	}) => {
		const startFresh = page.getByRole("button", {
			name: /start fresh/i,
		});
		await expect(startFresh).toBeVisible();

		await startFresh.focus();
		await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);
		await expect(page.getByRole("alert").first()).toBeVisible();

		// Move focus elsewhere -- the tooltip must close.
		await page.keyboard.press("Tab");
		await expect(destructiveContent(page)).toHaveCount(0, {
			timeout: 2000,
		});
	});
});

// ---------------------------------------------------------------------------
// 3-4: Pipeline informational / disabled (top-10 #2, #3)
// ---------------------------------------------------------------------------

test.describe("Feature pipeline -- Push to Roadmap / Already Pushed", () => {
	test.beforeEach(async ({ page }) => {
		skipIfNoData(TEST_DATA.personal.projectId);
		await gotoProjectTab(page, TEST_DATA.personal.projectId, /Pipeline/i);
	});

	test("Push to Roadmap hover renders informational tooltip (no AlertTriangleIcon)", async ({
		page,
	}) => {
		const pushBtn = page.getByRole("button", {
			name: /^push to roadmap$/i,
		});
		// TODO: selector may need tightening on first run -- the pipeline
		// page can render a primary row button and a confirm-dialog button
		// with the same label. First matching visible row is expected.
		if (
			!(await pushBtn
				.first()
				.isVisible()
				.catch(() => false))
		) {
			test.skip(
				true,
				"Push to Roadmap not visible in current seed state",
			);
		}

		const tooltip = await hoverAndGetTooltip(page, pushBtn.first());
		await expect(tooltip).toBeVisible();
		// Informational: no warning icon, no "Warning:" prefix.
		await expect(tooltip).not.toContainText(/Warning:/);
		await expect(destructiveContent(page)).toHaveCount(0);
	});

	test("Already Pushed disabled hover copy includes re-enable condition", async ({
		page,
	}) => {
		const alreadyPushed = page.getByRole("button", {
			name: /already pushed/i,
		});
		if (
			!(await alreadyPushed
				.first()
				.isVisible()
				.catch(() => false))
		) {
			test.skip(
				true,
				"Already Pushed requires a project whose Features document has already been pushed to the Roadmap. Seed a project that satisfies that state and rerun.",
			);
		}

		const tooltip = await hoverAndGetTooltip(page, alreadyPushed.first());
		await expect(tooltip).toBeVisible();
		// AC-7: copy names the current state and what re-enables the action.
		await expect(tooltip).toContainText(/already pushed/i);
		await expect(tooltip).toContainText(
			/regenerate|unlink|new revision|clear/i,
		);
	});
});

// ---------------------------------------------------------------------------
// 5: Document editor -- Approve / Reject (top-10 #4, #5)
// ---------------------------------------------------------------------------

test.describe("Document editor -- Approve / Reject", () => {
	test("Approve and Reject render informational tooltips (no AlertTriangleIcon)", async ({
		page,
	}) => {
		skipIfNoData(TEST_DATA.personal.projectId);
		skipIfNoData(TEST_DATA.personal.documentId);

		await page.goto(
			`/app/projects/${TEST_DATA.personal.projectId}/documents/${TEST_DATA.personal.documentId}`,
		);
		await page.waitForLoadState("networkidle");

		// The DiffReviewBar only mounts when there are pending AI changes.
		// Skip rather than drive AI mid-test -- that's covered by
		// confirm-changes-autodismiss.spec.ts.
		const approveBtn = page.getByRole("button", {
			name: /^accept$|^approve$/i,
		});
		const rejectBtn = page.getByRole("button", {
			name: /^reject$/i,
		});
		const haveDiffBar =
			(await approveBtn
				.first()
				.isVisible()
				.catch(() => false)) &&
			(await rejectBtn
				.first()
				.isVisible()
				.catch(() => false));
		if (!haveDiffBar) {
			test.skip(
				true,
				"DiffReviewBar only appears with pending AI changes. Seed a document with a pending AI change or provide a helper to generate one, then rerun.",
			);
		}

		const approveTooltip = await hoverAndGetTooltip(
			page,
			approveBtn.first(),
		);
		await expect(approveTooltip).toBeVisible();
		await expect(approveTooltip).not.toContainText(/Warning:/);
		await expect(destructiveContent(page)).toHaveCount(0);

		// Move off, then hover reject.
		await page.mouse.move(0, 0);
		const rejectTooltip = await hoverAndGetTooltip(page, rejectBtn.first());
		await expect(rejectTooltip).toBeVisible();
		await expect(rejectTooltip).not.toContainText(/Warning:/);
		await expect(destructiveContent(page)).toHaveCount(0);
	});
});

// ---------------------------------------------------------------------------
// 6: Prompts -- Update Binding / Bind as Default (top-10 #6, #7)
// ---------------------------------------------------------------------------

test.describe("Prompts -- Update Binding / Bind as Default", () => {
	// TODO: Prompts selector mounts inline next to specific document-type
	// controls in the pipeline and agent pages. Reaching it reliably requires
	// a seeded project with at least one bound and one unbound prompt. Add a
	// seed helper or page-object, then replace this placeholder with hover
	// assertions against /update binding/i and /bind as default/i, expecting
	// informational tooltips (no "Warning:" prefix, no destructive slot).
	test.fixme(
		"Update Binding and Bind as Default render informational tooltips",
		async () => {
			// Intentionally empty -- see TODO above.
		},
	);
});

// ---------------------------------------------------------------------------
// 7-9: Project settings destructive actions (top-10 #8, #9, #10)
// ---------------------------------------------------------------------------

test.describe("Project settings -- destructive actions", () => {
	test.beforeEach(async ({ page }) => {
		skipIfNoData(TEST_DATA.personal.projectId);
		await gotoProjectTab(page, TEST_DATA.personal.projectId, /Settings/i);
	});

	test("Delete project shows destructive tooltip", async ({ page }) => {
		const deleteBtn = page.getByRole("button", {
			name: /delete project/i,
		});
		if (
			!(await deleteBtn
				.first()
				.isVisible()
				.catch(() => false))
		) {
			test.skip(
				true,
				"Delete project lives in the danger zone of project settings. Seed a project where the current user is the owner and the settings tab renders the danger zone, then rerun.",
			);
		}

		await deleteBtn.first().hover();
		await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);
		const tooltip = destructiveContent(page).first();
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText(/Warning:/);
		await expect(tooltip).toContainText(/cannot be undone/i);
	});

	test("Archive project shows destructive tooltip with 'hidden from active lists' copy", async ({
		page,
	}) => {
		const archiveBtn = page.getByRole("button", {
			name: /archive project/i,
		});
		if (
			!(await archiveBtn
				.first()
				.isVisible()
				.catch(() => false))
		) {
			test.skip(
				true,
				"Archive project is owner-only. Seed a project where the current user is owner and archive is offered in settings, then rerun.",
			);
		}

		await archiveBtn.first().hover();
		await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);
		const tooltip = destructiveContent(page).first();
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText(/Warning:/);
		// Softer destructive copy per spec §7.2.
		await expect(tooltip).toContainText(/hidden from active lists/i);
	});

	test("Disconnect integration shows destructive tooltip with 'active syncs will stop' copy", async ({
		page,
	}) => {
		const disconnectBtn = page.getByRole("button", {
			name: /^disconnect$/i,
		});
		if (
			!(await disconnectBtn
				.first()
				.isVisible()
				.catch(() => false))
		) {
			test.skip(
				true,
				"Disconnect integration requires a connected integration on the project (repository, PM tool, Notion, etc.). Seed one, then rerun.",
			);
		}

		await disconnectBtn.first().hover();
		await page.waitForTimeout(TOOLTIP_DELAY_MS + 150);
		const tooltip = destructiveContent(page).first();
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText(/Warning:/);
		await expect(tooltip).toContainText(/active syncs will stop/i);
	});
});

// ---------------------------------------------------------------------------
// 10: 500ms delay on a representative informational control
// ---------------------------------------------------------------------------

test.describe("Tooltip delay", () => {
	test("informational tooltip does not appear before 500ms", async ({
		page,
	}) => {
		skipIfNoData(TEST_DATA.personal.projectId);
		await gotoProjectTab(page, TEST_DATA.personal.projectId, /Pipeline/i);

		// Prefer a control that is reliably present on the pipeline view --
		// the primary Generate/Regenerate button is the closest thing to a
		// "representative informational control".
		const trigger = page
			.getByRole("button", { name: /^(re)?generate/i })
			.first();
		if (!(await trigger.isVisible().catch(() => false))) {
			test.skip(
				true,
				"Pipeline page does not currently render a (Re)generate button. Verify seed data or swap to another representative informational control.",
			);
		}

		await trigger.hover();
		// Before the 500ms delay, no tooltip should be open.
		await page.waitForTimeout(TOOLTIP_DELAY_MS - 100);
		await expect(page.getByRole("tooltip")).toHaveCount(0);

		// After crossing the threshold, the tooltip should open.
		await page.waitForTimeout(250);
		await expect(page.getByRole("tooltip").first()).toBeVisible();
	});
});
