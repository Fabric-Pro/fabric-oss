/**
 * E2E: Unified Context Wizard — Notification flow (started → completed)
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §13.4
 *   (fifth bullet) + §13.5 (validation target estimate copy) + §8 (notifications).
 * Tasks: fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md §14.5.
 *
 * Scope:
 *   1. Open the wizard, add a Link (path-prefix URL).
 *   2. Close the wizard BEFORE the crawl finishes (the wizard's "X" /
 *      navigate-away path — the DRAFT survives for in-flight crawls).
 *   3. Navigate to `/app`, open the notification bell.
 *   4. Assert one `CONTEXT_INDEXING_STARTED` row with the exact §13.5
 *      estimate copy: `"Estimated 9 min — we'll notify you when it's ready."`
 *      (`maxPages = 100`, scope = PATH_PREFIX, `100 * 5 + 30 = 530s ≈ 9 min`).
 *   5. Wait for the crawl to finish (Firecrawl mock returns quickly).
 *   6. Assert a second row appears: `CONTEXT_INDEXING_COMPLETED` titled
 *      `"Indexed {url}"`.
 *
 * Status: SKIPPED in CI. Hardest of the 6 to wire — needs the Firecrawl
 * mock to:
 *   (a) hold the workflow in EXTRACTING long enough for the user to close
 *       the wizard and navigate (step 2 → step 3), AND
 *   (b) complete within the test's overall timeout (step 5).
 * The current `helpers/firecrawl-mock.ts` does not exist yet; once it
 * does, ship it with a "completes after 5 s" recipe and drop the skip.
 *
 * Run criteria: see `happy-path.spec.ts` header + the slow-then-fast
 * Firecrawl mock recipe.
 *
 * Manual driver: covered in Group 15.5 (`spec.md` §15.5) — uses
 * `mcp__aspire__list_console_logs` resource=`temporal-worker` to
 * observe the workflow progression in real time.
 */

import { expect, test } from "@playwright/test";

const LINK_URL = "https://docs.example.com/hc/en-us";
// `100 * 5 + 30 = 530s ≈ 9 min` per spec §8.3 + §13.5.
const EXPECTED_ESTIMATE_COPY =
	"Estimated 9 min — we'll notify you when it's ready.";

test.describe("Unified Context Wizard — notification flow", () => {
	test.skip(
		() => true,
		"Group 14 deferral: enable once the slow-then-fast Firecrawl mock + auth fixtures + notification poller are wired (see file header).",
	);

	test("started + completed notifications appear with correct copy", async ({
		page,
	}) => {
		// (1) Open the wizard, name the project.
		await page.goto("/app/projects/new/create");
		const projectName = `E2E Notif Flow ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		await page.getByLabel(/project name/i).blur();

		// (2) Open the dialog, submit a Link.
		await page.getByTestId("add-context-cta").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		await dialog.getByRole("tab", { name: /link/i }).click();
		await dialog.getByLabel(/url/i).fill(LINK_URL);
		await dialog.getByLabel(/url/i).blur();
		await dialog.getByRole("button", { name: /^add context$/i }).click();
		// Dialog closes after `processLink` returns. The notification row is
		// created server-side inside `process-context-link.ts` immediately
		// after `workflow.start` returns, so it's already in
		// the DB by the time the dialog hides.
		await expect(dialog).toBeHidden({ timeout: 15_000 });

		// (3) Navigate to `/app` BEFORE the crawl finishes. The DRAFT must
		// survive (no Discard click) so the workflow keeps running in the
		// background.
		await page.goto("/app");

		// (4) Open the notification bell, find the "started" row.
		await page
			.getByRole("button", { name: /notifications?|bell/i })
			.click();
		const notifPopover = page.getByRole("dialog", {
			name: /notifications?/i,
		});
		await expect(notifPopover).toBeVisible({ timeout: 5_000 });

		// Started-row title: `Indexing docs.example.com/hc/en-us`.
		const startedRow = notifPopover
			.locator("[data-notification-row]")
			.filter({ hasText: /^Indexing/i })
			.first();
		await expect(startedRow).toBeVisible({ timeout: 10_000 });

		// Estimate copy: exact match per §13.5. Loose regex tolerates the
		// em-dash being either U+2014 or a hyphen in the renderer.
		await expect(startedRow).toContainText(EXPECTED_ESTIMATE_COPY, {
			timeout: 5_000,
		});

		// (5) Wait for the second row. The mock should complete within
		// ~30 s; we poll the popover with a generous ceiling. The
		// `urlSourceCrawlWorkflow` finalize activity emits the
		// `CONTEXT_INDEXING_COMPLETED` row.
		const completedRow = notifPopover
			.locator("[data-notification-row]")
			.filter({ hasText: /^Indexed/i })
			.first();
		await expect(completedRow).toBeVisible({ timeout: 60_000 });

		// Completed-row title: `Indexed docs.example.com/hc/en-us`.
		await expect(completedRow).toContainText(/^Indexed docs\.example/i);
	});
});
