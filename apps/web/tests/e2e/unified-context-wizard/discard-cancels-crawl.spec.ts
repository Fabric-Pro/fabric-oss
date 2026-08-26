/**
 * E2E: Unified Context Wizard — Discard draft cancels in-flight crawls
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §13.4
 *   (second bullet) + §6.2 + §6.4 (silent cancellation contract).
 * Tasks: fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md §14.2.
 *
 * Scope:
 *   1. New project wizard → enter name → "Add Context" → submit a Link
 *      with PATH_PREFIX (`https://docs.example.com/hc/en-us` — same
 *      validation URL as spec §13.5).
 *   2. Click "Discard draft" before the crawl finishes.
 *   3. Assert the `projects.contexts.cancelDraftCrawls` oRPC call fired via
 *      `page.on('request')` network intercept (verifies §6.2 explicit-cancel
 *      pathway).
 *   4. Assert the DRAFT was soft-deleted — navigate to `/app` and confirm
 *      the discarded project is NOT in the project list.
 *   5. Assert no Notification appears in the bell (silent per §6.4 — the
 *      finalize activity skips `db.notification.create` when the workflow
 *      finalizes with `CANCELLED`).
 *
 * Status: SKIPPED in CI. Same deferral pattern as `happy-path.spec.ts` —
 * needs the full local stack + a Firecrawl key (or a network-mocked one
 * via the follow-up `helpers/firecrawl-mock.ts` recipe). Crucially, the
 * mock must keep the workflow in EXTRACTING long enough for the user to
 * click Discard before completion.
 *
 * Run criteria: see `happy-path.spec.ts` header.
 *
 * Manual driver: covered in Group 15.7 (`spec.md` §15.7) via
 * `mcp__playwright__*` MCP tools.
 */

import { expect, test } from "@playwright/test";

const LINK_URL = "https://docs.example.com/hc/en-us";

test.describe("Unified Context Wizard — Discard draft cancels crawl", () => {
	test.skip(
		() => true,
		"Group 14 deferral: enable once local stack + slow-Firecrawl mock + auth fixtures are wired (see file header).",
	);

	test("Discard draft fires cancelDraftCrawls + soft-deletes the DRAFT silently", async ({
		page,
	}) => {
		// Intercept oRPC requests so we can assert `cancelDraftCrawls` fired.
		// oRPC paths follow the `/rpc/<router>.<procedure>` convention — the
		// procedure name is `projects.contexts.cancelDraftCrawls`.
		const cancelCalls: string[] = [];
		page.on("request", (req) => {
			const url = req.url();
			if (url.includes("projects.contexts.cancelDraftCrawls")) {
				cancelCalls.push(url);
			}
		});

		// (1) Open the wizard, enter a project name.
		await page.goto("/app/projects/new/create");

		const projectName = `E2E Discard Draft ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		await page.getByLabel(/project name/i).blur();

		// (2) Open the dialog and submit a Link.
		await page.getByTestId("add-context-cta").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });

		await dialog.getByRole("tab", { name: /link/i }).click();
		await dialog.getByLabel(/url/i).fill(LINK_URL);
		await dialog.getByLabel(/url/i).blur();
		await dialog.getByRole("button", { name: /^add context$/i }).click();
		// Wait for the dialog to close (success) — confirms `processLink`
		// returned and `urlSourceCrawlWorkflow` was kicked off.
		await expect(dialog).toBeHidden({ timeout: 15_000 });

		// (3) Inline pending row should show "Crawling" / "Indexing" — proves
		// the LINK is in EXTRACTING state and the workflow handle is still
		// open (cancellation will have real cancel work to do).
		const pendingList = page.getByTestId("pending-items-list");
		await expect(pendingList).toContainText(/crawl|index/i, {
			timeout: 5_000,
		});

		// (4) Click "Discard draft" BEFORE the crawl finishes.
		const discardBtn = page.getByTestId("discard-draft-button");
		await expect(discardBtn).toBeVisible();
		await discardBtn.click();
		// Confirm the destructive shadcn `confirmDialog` modal — copy
		// hardcoded in `handleDiscardDraft` at ProjectCreationWizard.tsx:1149-1156.
		await page
			.getByRole("button", { name: /^discard draft$/i })
			.last()
			.click();

		// (5) Assert `cancelDraftCrawls` oRPC call fired (network intercept).
		await expect
			.poll(() => cancelCalls.length, { timeout: 15_000 })
			.toBeGreaterThanOrEqual(1);

		// (6) The user lands on `/app` after the cascade (cancel → delete →
		// router.push). Confirm the discarded DRAFT is NOT in the project list.
		await expect(page).toHaveURL(/\/app(\/[^/]+)?$/, { timeout: 15_000 });
		await expect(page.getByText(projectName)).toHaveCount(0);

		// (7) Silent-cancellation assertion (§6.4): open the notification
		// bell and confirm NO `CONTEXT_INDEXING_*` row for the cancelled
		// crawl. We don't have a stable testid for the bell across the
		// notification refresh, so we assert by content — the dedupeKey
		// `context-indexing-started:{contextId}` would have surfaced an
		// "Indexing" row IF the system mistakenly emitted on cancel.
		await page
			.getByRole("button", { name: /notifications?|bell/i })
			.click();
		const notifPopover = page.getByRole("dialog", {
			name: /notifications?/i,
		});
		await expect(notifPopover).toBeVisible({ timeout: 5_000 });
		// The Notification copy for the LINK would have read
		// `Indexing docs.example.com/hc/en-us` if emitted. Silent
		// cancel ⇒ that copy never appears.
		await expect(
			notifPopover.getByText(/indexing docs\.example\.com/i),
		).toHaveCount(0);
	});
});
