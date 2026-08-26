/**
 * E2E: Unified Context Wizard — Edit-mode parity (Q15 binding)
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §13.4
 *   (fourth bullet) + §7.6 (Edit-mode parity).
 * Tasks: fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md §14.4.
 *
 * Scope:
 *   1. Open the wizard for an existing ACTIVE project via
 *      `?projectId=<ACTIVE>`.
 *   2. Confirm the same "Add Context" CTA renders (no `isEditMode` carve-out
 *      around the new section — verified statically in Group 11.3, asserted
 *      at runtime here).
 *   3. Click the CTA → open the dialog → add a URL → close.
 *   4. Navigate to the project's contexts tab → assert the new URL row is
 *      present, bound to the ACTIVE project (not a parallel DRAFT).
 *
 * Status: SKIPPED in CI. Requires a fixture ACTIVE project ID + the full
 * stack (Firecrawl key / mock + auth fixtures). Different fixture from the
 * happy-path spec — the ACTIVE project must already exist in the dev DB
 * for the wizard's edit-mode branch to resolve.
 *
 * Run criteria:
 *   (a) Stack healthy (see `happy-path.spec.ts` header).
 *   (b) `TEST_ACTIVE_PROJECT_ID` env var points at a real ACTIVE project
 *       owned by the seeded user.
 *   (c) Firecrawl key configured or mocked so the URL submit doesn't
 *       error on the pre-flight gate.
 *
 * Manual driver: covered in Group 15.10 (`spec.md` §15.10).
 */

import { expect, test } from "@playwright/test";

const ACTIVE_PROJECT_ID =
	process.env.TEST_ACTIVE_PROJECT_ID ?? "<active-project-id>";
const EDIT_URL = "https://example.com/docs/edit-mode-test";

function isPlaceholder(v: string): boolean {
	return v.startsWith("<") && v.endsWith(">");
}

test.describe("Unified Context Wizard — edit-mode parity", () => {
	test.skip(
		() => true,
		"Group 14 deferral: enable once auth fixtures + a known ACTIVE project ID (TEST_ACTIVE_PROJECT_ID) are wired.",
	);

	test("edit mode renders Add Context CTA + URL lands on ACTIVE project's contexts tab", async ({
		page,
	}) => {
		if (isPlaceholder(ACTIVE_PROJECT_ID)) {
			test.skip();
		}

		// (1) Open the wizard for an existing ACTIVE project. Per spec §7.6,
		// the wizard renders the SAME Add Context surface — `projectId` is
		// real-and-active from the start (no DRAFT creation).
		await page.goto(
			`/app/projects/new/create?projectId=${ACTIVE_PROJECT_ID}`,
		);

		// (2) The "Add Context" CTA renders unchanged. The `data-testid`
		// matches the new-project surface; if a future code change adds an
		// `isEditMode` carve-out, this assertion catches it.
		const addContextCta = page.getByTestId("add-context-cta");
		await expect(addContextCta).toBeVisible({ timeout: 10_000 });
		await expect(addContextCta).toBeEnabled();

		// (3) Open the dialog, add a URL via the Link tab.
		await addContextCta.click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		await dialog.getByRole("tab", { name: /link/i }).click();
		await dialog.getByLabel(/url/i).fill(EDIT_URL);
		await dialog.getByLabel(/url/i).blur();
		await dialog.getByRole("button", { name: /^add context$/i }).click();

		// Dialog auto-closes on success.
		await expect(dialog).toBeHidden({ timeout: 15_000 });

		// (4) Inline pending-items list shows the new row — proves the
		// write went to the ACTIVE project's `projectId` (not a parallel
		// DRAFT). The post-creation surface and the wizard's inline list
		// both read from `projects.contexts.list({ projectId, organizationId })`
		// per spec §7.5.
		const pendingList = page.getByTestId("pending-items-list");
		await expect(pendingList).toBeVisible();
		await expect(pendingList).toContainText(/example\.com.*edit-mode/i, {
			timeout: 10_000,
		});

		// (5) Navigate to the project's contexts tab — assert the new URL
		// row is present there too (the post-creation list reads the same
		// data source, so this is a redundancy check that the spec §7.6
		// "no isEditMode branch" promise actually holds at runtime).
		await page.goto(`/app/projects/${ACTIVE_PROJECT_ID}/contexts`);
		await expect(page.getByText(/example\.com.*edit-mode/i)).toBeVisible({
			timeout: 15_000,
		});
	});
});
