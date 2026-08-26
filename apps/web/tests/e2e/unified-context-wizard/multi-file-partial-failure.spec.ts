/**
 * E2E: Unified Context Wizard — Multi-file PARTIAL-failure UX
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §7.1
 * Static review (H1/H2): verifications/static-review.md
 * Post-review fixes:    verifications/post-review-fixes.md
 *
 * Verifies the H1+H2 fix to `ContextUploaderDialog.handleFileUpload`:
 *
 *   - When some queued rows succeed and some fail at S3 PUT time,
 *     the dialog MUST stay open (no auto-close) and surface an
 *     amber `toast.warning("X uploaded, Y failed …")`.
 *   - The pending-items list query MUST still be invalidated so
 *     the successful rows surface immediately in the inline cards.
 *   - The failed rows MUST render inline error pills so the user
 *     can read what went wrong and retry/remove.
 *
 * Strategy: use `page.route()` to intercept the per-row PUT requests
 * after `createUploadUrl` returns. We let the first and third PUT
 * succeed (200) and force the second to fail (403). This avoids
 * depending on MinIO being reachable from the browser context and
 * exercises the runtime-failure branch deterministically.
 *
 * Status: SKIPPED in CI alongside the other 6 specs in this folder.
 * Run criteria: local stack with reachable `projects.contexts.createUploadUrl`
 * (i.e. Aspire-managed dev server with Postgres + MinIO via the configured
 * storage provider). The unit-level coverage for the same branch lives at
 * `apps/web/modules/saas/projects/components/__tests__/ContextUploaderDialog.file-tab.test.tsx`
 * tests (f), (g), (h).
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

test.describe("Unified Context Wizard — multi-file PARTIAL failure", () => {
	test.skip(
		() => true,
		"Group 14 deferral — same convention as the other specs in this folder. Unit-level coverage at ContextUploaderDialog.file-tab.test.tsx (f/g/h) locks in the branch logic without infra deps.",
	);

	test("dialog stays open + amber warning toast when 1 of 3 PUTs fails", async ({
		page,
	}) => {
		const pdfBytes = fs.readFileSync(PDF_FIXTURE_PATH);

		// (0) Intercept S3 / R2 / MinIO PUTs from the browser. The
		// `createUploadUrl` server procedure returns a presigned URL with the
		// filename embedded in the path; we match by that to deterministically
		// fail the second file's PUT and let the others through.
		await page.route(
			/\/project-contexts\/projects\/.*\.pdf(\?|$)/i,
			async (route) => {
				const url = route.request().url();
				if (/spec-doc-2\.pdf/.test(decodeURIComponent(url))) {
					await route.fulfill({
						status: 403,
						body: "Forbidden (E2E partial-failure injection)",
					});
				} else {
					// Let the browser complete the PUT normally — MinIO will
					// 200 the real bytes.
					await route.continue();
				}
			},
		);

		await page.goto("/app/projects/new/create");
		const projectName = `E2E Partial-Failure ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		await page.getByLabel(/project name/i).blur();

		// Wait for DRAFT autosave so the Add Context CTA enables.
		await expect(page.getByText(/Draft saved/i).first()).toBeVisible({
			timeout: 15_000,
		});
		await page.getByTestId("add-context-cta").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		await dialog.getByRole("tab", { name: /^file$/i }).click();

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

		await expect(dialog.getByText("spec-doc-1.pdf")).toBeVisible();
		await expect(dialog.getByText("spec-doc-2.pdf")).toBeVisible();
		await expect(dialog.getByText("spec-doc-3.pdf")).toBeVisible();

		await dialog.getByRole("button", { name: /upload 3 files/i }).click();

		// Wait for the batch to settle: doc-1 and doc-3 should reach
		// "Done" (or "Completed"), and doc-2 should carry an inline error
		// pill mentioning the failure.
		await expect(
			dialog.getByText("spec-doc-2.pdf").locator("xpath=ancestor::li[1]"),
		).toContainText(/Failed:?\s*\w+/i, { timeout: 30_000 });

		// (H2) Dialog MUST stay open after partial failure.
		await expect(dialog).toBeVisible();

		// (H1) Amber warning toast carries the success + failure counts.
		// We accept any text shape that contains "2" + "uploaded" + "1" + "failed"
		// in the toaster region.
		const toaster = page.locator(
			'[data-sonner-toaster], [aria-label*="otification"]',
		);
		await expect(toaster).toContainText(/2\s+upload(ed)?/i, {
			timeout: 5_000,
		});
		await expect(toaster).toContainText(/1\s+failed/i, { timeout: 5_000 });

		// Successful rows surface in the inline pending-items list.
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
			.toBeGreaterThanOrEqual(2);

		// (Bonus) User can dismiss the dialog manually — Cancel is reachable
		// and closes the dialog cleanly.
		await dialog.getByRole("button", { name: /cancel/i }).click();
		await expect(dialog).toBeHidden({ timeout: 5_000 });
	});

	test("dialog stays open + red error toast when ALL PUTs fail", async ({
		page,
	}) => {
		const pdfBytes = fs.readFileSync(PDF_FIXTURE_PATH);

		await page.route(
			/\/project-contexts\/projects\/.*\.pdf(\?|$)/i,
			async (route) => {
				await route.fulfill({
					status: 403,
					body: "Forbidden (E2E all-failed injection)",
				});
			},
		);

		await page.goto("/app/projects/new/create");
		const projectName = `E2E All-Failed ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		await page.getByLabel(/project name/i).blur();
		await expect(page.getByText(/Draft saved/i).first()).toBeVisible({
			timeout: 15_000,
		});
		await page.getByTestId("add-context-cta").click();

		const dialog = page.getByRole("dialog");
		await dialog.getByRole("tab", { name: /^file$/i }).click();
		await dialog.locator('input[type="file"]').setInputFiles([
			{
				name: "fail-a.pdf",
				mimeType: "application/pdf",
				buffer: pdfBytes,
			},
			{
				name: "fail-b.pdf",
				mimeType: "application/pdf",
				buffer: pdfBytes,
			},
		]);

		await dialog.getByRole("button", { name: /upload 2 files/i }).click();

		// Both rows reach Failed state
		await expect(
			dialog.getByText("fail-a.pdf").locator("xpath=ancestor::li[1]"),
		).toContainText(/Failed/i, { timeout: 30_000 });
		await expect(
			dialog.getByText("fail-b.pdf").locator("xpath=ancestor::li[1]"),
		).toContainText(/Failed/i, { timeout: 30_000 });

		// (H2) Dialog stays open
		await expect(dialog).toBeVisible();

		// Red error toast
		const toaster = page.locator(
			'[data-sonner-toaster], [aria-label*="otification"]',
		);
		await expect(toaster).toContainText(/all 2 uploads failed/i, {
			timeout: 5_000,
		});
	});
});
