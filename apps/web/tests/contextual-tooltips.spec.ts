/**
 * Contextual Action Tooltips -- E2E Coverage
 *
 * Exercises the top-10 anchor actions from
 * `docs/specs/2026-04-20-contextual-action-tooltips/spec.md` §11.1. The
 * Pipeline-tab cases (Start Fresh, Push to Roadmap / Already Pushed) and the
 * delay check that hovered a Pipeline control went with the tab when it was
 * retired; each remaining `test()` maps one row to one case.
 *
 * Prerequisites:
 * - Dev server running on :3001 (Playwright config handles this).
 * - Auth state produced by `auth.setup.ts` (storageState).
 * - TEST_DATA below must reference a real project and document. Tests that
 *   rely on that state self-skip if the placeholder is unchanged.
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
	// tabs (Documents, Roadmap, etc.) match by accessible name; icon-only
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
	// controls in the document and agent pages. Reaching it reliably requires
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
