/**
 * E2E: Workspace document upload — happy path, failure surfacing, and retry.
 *
 * Spec: `specs/2026-05-14-workspace-document-upload-failed-fetch/spec.md`
 *   §7.3 (Playwright e2e plan) and §4 measurable success criteria
 *   M1 (row reaches success within 30 s), M2 (status `READY` within 60 s),
 *   M6 (counter increments to `1/20` within 10 s).
 * Tasks: `tasks.md` §5.1, §6.1, §6.2.
 *
 * Reframing per `verification.md`:
 *   Staging's R2 bucket already has CORS configured correctly, so "Failed to
 *   fetch" cannot be reproduced there. The happy-path test below is therefore
 *   a **regression guard** for AC #1 and AC #4 — it locks in that the
 *   currently-working staging upload flow continues to work after the Group 3
 *   (error mapper) and Group 4 (UI / retry button) code changes land. The
 *   real production verification for the CORS rollout (Group 2) is the manual
 *   smoke documented in spec §8 step 6.
 *
 * The failure and retry tests are deterministic — they intercept the PUT to
 * the presigned URL via `page.route()` and never touch a real bucket. That
 * keeps the regression guard for AC #2 (actionable error) and AC #3 (in-place
 * retry) reproducible across environments.
 *
 * Runtime: gated behind staging env vars. Skipped at runtime if `STAGING_URL`
 * is not set, so the default `pnpm --filter web e2e` against local dev does
 * not attempt to hit staging.
 *
 * Required env vars:
 *   - STAGING_URL              base URL of the staging app (e.g. https://staging.fabric.pro)
 *   - STAGING_USER_EMAIL       seeded staging user email
 *   - STAGING_USER_PASSWORD    seeded staging user password (magic-link flow signs in via password fallback)
 *   - STAGING_WORKSPACE_ID     existing personal-account workspace id to upload into
 */

import * as path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";

const PDF_FIXTURE = path.join(__dirname, "..", "..", "fixtures", "sample.pdf");

const STAGING_URL = process.env.STAGING_URL ?? "";
const STAGING_USER_EMAIL = process.env.STAGING_USER_EMAIL ?? "";
const STAGING_USER_PASSWORD = process.env.STAGING_USER_PASSWORD ?? "";
const STAGING_WORKSPACE_ID = process.env.STAGING_WORKSPACE_ID ?? "";

const STAGING_CONFIGURED =
	STAGING_URL.length > 0 &&
	STAGING_USER_EMAIL.length > 0 &&
	STAGING_USER_PASSWORD.length > 0 &&
	STAGING_WORKSPACE_ID.length > 0;

/**
 * Sign in to staging via the password form and land on the workspace detail
 * page. Mirrors `tests/auth.setup.ts` but inline (this spec is not part of
 * the global setup project — it runs against a different baseURL).
 */
async function signInToStagingAndOpenWorkspace(page: Page): Promise<void> {
	await page.goto(`${STAGING_URL}/auth/login`);
	await page.fill('input[name="email"]', STAGING_USER_EMAIL);
	await page.fill('input[name="password"]', STAGING_USER_PASSWORD);
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
	await page.goto(`${STAGING_URL}/app/workspaces/${STAGING_WORKSPACE_ID}`);
	// Workspace detail renders the "Documents" stat card once the workspace
	// query resolves — wait on that as the page-ready signal.
	await expect(
		page.getByText("Documents", { exact: true }).first(),
	).toBeVisible({ timeout: 30_000 });
}

/**
 * Open the upload modal and drop the local PDF fixture into the hidden file
 * input. Returns the row locator so each test can assert against it directly.
 */
async function openUploaderAndAttachPdf(page: Page) {
	await page
		.getByRole("button", { name: /Upload Document/i })
		.first()
		.click();
	const dialog = page.getByRole("dialog", { name: /Upload Documents/i });
	await expect(dialog).toBeVisible({ timeout: 10_000 });

	const fileInput = dialog.locator('input[type="file"]#file-upload');
	await fileInput.setInputFiles(PDF_FIXTURE);

	const row = dialog.locator(":scope >> text=sample.pdf").first();
	await expect(row).toBeVisible({ timeout: 5_000 });
	return { dialog };
}

test.describe("Workspace document upload", () => {
	test.skip(
		() => !STAGING_CONFIGURED,
		"Staging env vars not set (STAGING_URL / STAGING_USER_EMAIL / STAGING_USER_PASSWORD / STAGING_WORKSPACE_ID). " +
			"This spec runs only against staging — set the env vars in the CI job to enable.",
	);

	test("happy path — uploads, row reaches success, counter increments, status becomes READY", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(120_000);

		await signInToStagingAndOpenWorkspace(page);

		// Capture the documents counter value BEFORE the upload so we can
		// assert it strictly increments (the workspace may already contain
		// other documents from prior runs).
		const documentsCard = page
			.getByText("Documents", { exact: true })
			.first()
			.locator("..")
			.locator("..");
		const initialCounterText =
			(await documentsCard.locator("div").nth(1).textContent()) ?? "0/20";
		const initialCount = Number(
			initialCounterText.match(/(\d+)\s*\/\s*\d+/)?.[1] ?? "0",
		);
		const expectedCount = initialCount + 1;

		const { dialog } = await openUploaderAndAttachPdf(page);

		await dialog.getByRole("button", { name: /Upload 1 File/i }).click();

		// M1 — the row reaches success within 30 s. The success state surfaces
		// the CheckCircle icon; in the absence of an `aria-label` on the row
		// itself we wait for the success icon's accessible parent. The toast
		// "uploaded successfully" is the user-visible confirmation that the
		// PUT + confirmUpload pipeline finished cleanly.
		await expect(
			page.getByText(/uploaded successfully/i).first(),
		).toBeVisible({ timeout: 30_000 });

		// Close the modal — the existing implementation auto-dismisses success
		// rows after ~2 s; close explicitly so the assertion below is on the
		// page proper, not on a transient dialog overlay.
		await dialog.getByRole("button", { name: /^Cancel$|^Close$/i }).click();
		await expect(dialog).not.toBeVisible({ timeout: 10_000 });

		// M6 — counter increments within 10 s (one 3 s polling cycle + margin).
		// This is the regression guard for AC #4 per `verification.md`.
		await expect(
			page.getByText(
				new RegExp(`Documents\\s+${expectedCount}\\s*/\\s*20`),
				{
					exact: false,
				},
			),
		).toBeVisible({ timeout: 10_000 });

		// M2 — Temporal processing window. The document row in the list shows
		// a `READY` status badge once chunking / embeddings finish. 60 s is
		// the spec-allotted window; if staging is slow, the test reports a
		// real regression (or a Bug B recurrence — see `verification.md`).
		await expect(page.getByText(/sample\.pdf/i).first()).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.getByText(/READY/i).first()).toBeVisible({
			timeout: 60_000,
		});
	});

	test("failure path — PUT 403 surfaces STORAGE_REJECTED with Retry button", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await signInToStagingAndOpenWorkspace(page);

		// Stub the presigned PUT with a 403. The presigned URL host varies
		// per provider (R2 / S3 / MinIO); intercept by HTTP method on any
		// PUT that is NOT one of the oRPC POST endpoints, which is robust
		// against host changes. The `**/*` pattern matches every URL; we
		// then filter by method inside the handler.
		await page.route("**/*", async (route) => {
			const request = route.request();
			if (request.method() === "PUT") {
				await route.fulfill({
					status: 403,
					contentType: "application/xml",
					body: "<Error><Code>AccessDenied</Code></Error>",
				});
				return;
			}
			await route.continue();
		});

		const { dialog } = await openUploaderAndAttachPdf(page);
		await dialog.getByRole("button", { name: /Upload 1 File/i }).click();

		// The mapper resolves a 403 from the PUT to STORAGE_REJECTED, whose
		// friendly copy per spec 6c is "Upload was rejected by storage…".
		await expect(
			dialog.getByText(/rejected by storage|link may have expired/i),
		).toBeVisible({ timeout: 15_000 });

		// AC #3 — the Retry button is present and accessible by name.
		await expect(
			dialog.getByRole("button", { name: /Retry upload/i }),
		).toBeVisible();
	});

	test("retry path — first PUT 403, second PUT 200, row recovers to success", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(90_000);

		await signInToStagingAndOpenWorkspace(page);

		// Deterministic two-attempt stub: the first PUT returns 403, the
		// second returns 200 (so the retry succeeds). All other requests
		// (including the oRPC `createUploadUrl` / `confirmUpload` POSTs)
		// continue to the real staging backend.
		let putAttempt = 0;
		await page.route("**/*", async (route: Route) => {
			const request = route.request();
			if (request.method() === "PUT") {
				putAttempt += 1;
				if (putAttempt === 1) {
					await route.fulfill({
						status: 403,
						contentType: "application/xml",
						body: "<Error><Code>AccessDenied</Code></Error>",
					});
					return;
				}
				await route.fulfill({
					status: 200,
					headers: { etag: '"deterministic-retry-etag"' },
					body: "",
				});
				return;
			}
			await route.continue();
		});

		const { dialog } = await openUploaderAndAttachPdf(page);
		await dialog.getByRole("button", { name: /Upload 1 File/i }).click();

		// Wait for the first-attempt error to land — the friendly message
		// is the same STORAGE_REJECTED string from the failure-path test.
		await expect(
			dialog.getByText(/rejected by storage|link may have expired/i),
		).toBeVisible({ timeout: 15_000 });

		// Click Retry — the row transitions error → retrying → success. We
		// observe the success terminal state via the bulk-upload toast.
		await dialog.getByRole("button", { name: /Retry upload/i }).click();

		await expect(
			page.getByText(/uploaded successfully/i).first(),
		).toBeVisible({ timeout: 30_000 });

		// Sanity: the PUT was attempted exactly twice (once failed, once
		// succeeded). Guards against a future refactor that silently retries
		// in a loop or fires extra PUTs.
		expect(putAttempt).toBe(2);
	});
});
