/**
 * E2E: Unified Context Wizard — Multi-file upload (3 PDFs at once)
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §13.4
 *   (third bullet) + §7.1 (File-tab multi-file upgrade) + decision Q12.
 * Tasks: fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md §14.3.
 *
 * Scope:
 *   1. Open the wizard, enter a name, open the Add Context dialog on the
 *      File tab.
 *   2. Select 3 PDFs at once via `page.setInputFiles([...])` — verifies the
 *      Group 7 multi-file upgrade is wired.
 *   3. Per-file status rows appear in the dialog (3 rows).
 *   4. All 3 uploads + extracts succeed → dialog auto-closes → 3 cards
 *      appear in the inline `ContextPendingItemsList`.
 *
 * Fixture strategy: the canonical `apps/web/tests/fixtures/sample.pdf` is
 * the only PDF in the repo. Rather than commit duplicates, we feed the
 * input three uploads under distinct filenames via in-memory
 * `setInputFiles({ name, mimeType, buffer })` calls so the dialog renders
 * three distinct rows. See `fixtures/README.md` for rationale.
 *
 * Status: SKIPPED in CI. Same deferral pattern as `happy-path.spec.ts`.
 * Run criteria: see `happy-path.spec.ts` header. Multi-file upload depends
 * on S3 / R2 presigned URLs (`createUploadUrl`) being reachable from the
 * Playwright browser context — typically only true in a fully-bootstrapped
 * local stack.
 *
 * Manual driver: covered in Group 15.6 (`spec.md` §15.6).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";

const PDF_FIXTURE_PATH = path.join(
	__dirname,
	"..",
	"..",
	"fixtures",
	"sample.pdf",
);

test.describe("Unified Context Wizard — multi-file upload", () => {
	test.skip(
		() => true,
		"Group 14 deferral: enable once local stack + S3 presigned-URL reachability + auth fixtures are wired (see file header).",
	);

	test("drop 3 PDFs at once → 3 status rows → 3 cards in inline list", async ({
		page,
	}) => {
		// (0) Read the canonical fixture once; clone the bytes under three
		// distinct filenames so the dialog renders three distinct rows.
		const pdfBytes = fs.readFileSync(PDF_FIXTURE_PATH);

		// (1) Open the wizard, name the project.
		await page.goto("/app/projects/new/create");
		const projectName = `E2E Multi-File ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		await page.getByLabel(/project name/i).blur();

		// (2) Open the dialog on the File tab.
		await page.getByTestId("add-context-cta").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		await dialog.getByRole("tab", { name: /file/i }).click();

		// (3) Select 3 PDFs at once. The file input is hidden behind the
		// dropzone; `setInputFiles` targets it directly. The 3-element array
		// exercises the §7.1 contract: `setFiles((prev) => [...prev, ...files])`
		// MUST accumulate every dropped file.
		await dialog.locator('input[type="file"]').setInputFiles([
			{
				name: "spec-doc-1.pdf",
				mimeType: "application/pdf",
				buffer: pdfBytes,
			},
			{
				name: "spec-doc-2.pdf",
				mimeType: "application/pdf",
				buffer: pdfBytes,
			},
			{
				name: "spec-doc-3.pdf",
				mimeType: "application/pdf",
				buffer: pdfBytes,
			},
		]);

		// (4) Three per-file status rows appear inside the dialog.
		// Rows match the existing `WizardFileUploader.tsx:240-241` shape;
		// each row's filename is the stable identifier.
		await expect(dialog.getByText("spec-doc-1.pdf")).toBeVisible();
		await expect(dialog.getByText("spec-doc-2.pdf")).toBeVisible();
		await expect(dialog.getByText("spec-doc-3.pdf")).toBeVisible();

		// (5) Submit button label flips to "Upload 3 files" per spec §7.1.
		// Allow either copy in case the implementation normalises the label.
		const submit = dialog.getByRole("button", {
			name: /^upload(\s+3\s+files)?$/i,
		});
		await submit.click();

		// (6) Dialog auto-closes after the last file completes.
		await expect(dialog).toBeHidden({ timeout: 60_000 });

		// (7) Inline pending-items list shows 3 rows. The list polls the
		// `projects.contexts.list` procedure on a 2 s cadence;
		// `expect.poll` lets the assertion wait for the post-extract rows.
		const pendingList = page.getByTestId("pending-items-list");
		await expect(pendingList).toBeVisible();
		await expect
			.poll(
				async () =>
					pendingList
						.locator("[data-testid^='pending-row-']")
						.count(),
				{ timeout: 30_000 },
			)
			.toBeGreaterThanOrEqual(3);
	});
});
