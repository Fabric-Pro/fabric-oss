/**
 * E2E: URL Context Sources — Add a URL and change cadence
 *
 * Spec: fabric/specs/2026-05-13-url-context-sources/spec.md §15.3
 * Tasks: fabric/specs/2026-05-13-url-context-sources/tasks.md §10.3
 *
 * Scope:
 *   1. With a configured Firecrawl key, the Link tab submits a new
 *      PATH_PREFIX URL and the LINK card pill flips Crawling → Indexed
 *      within the polling window.
 *   2. The Manage expander surfaces the cadence dropdown; changing
 *      ONCE → WEEKLY persists via `updateUrlSource` and the schedule
 *      is observable in the database (or via mocked Temporal
 *      `ScheduleClient`).
 *
 * Status: SKIPPED in CI. Requires a configured Firecrawl key in the
 * dev env (or a network-mocked one) and a known project ID. The mock
 * surface in `apps/web/tests/helpers` needs a Firecrawl stub recipe —
 * captured as a follow-up.
 *
 * TODO(group-10-followup): enable once `helpers/firecrawl-mock.ts` is
 * added (drop the workflow in a fast-success no-op variant for E2E).
 */

import { expect, test } from "@playwright/test";

const PROJECT_ID = process.env.TEST_PROJECT_WITH_FIRECRAWL_ID ?? "<project-id>";

test.describe("URL Context Sources — Add + cadence change", () => {
	test.skip(
		() => true,
		"Group 10 deferral: enable once Firecrawl mock is wired in CI",
	);

	test("add a PATH_PREFIX URL → pill flips Crawling → Indexed", async ({
		page,
	}) => {
		await page.goto(`/app/projects/${PROJECT_ID}/contexts`);
		await page.getByRole("button", { name: /add context/i }).click();
		await page.getByRole("tab", { name: /link/i }).click();

		const url = "https://example.com/docs/api";
		await page.getByLabel("URL").fill(url);
		await page.getByLabel("URL").blur();

		// Auto-detect should have flipped scope to PATH_PREFIX.
		await expect(
			page.getByRole("radio", { name: /Path-prefix/i }),
		).toHaveAttribute("data-state", "checked");

		await page.getByLabel(/Label/i).fill("Acme API docs");
		await page.getByRole("button", { name: /^Add Context$/i }).click();

		// Optimistic "Crawling…" pill.
		const card = page.getByText("Acme API docs").locator("..");
		await expect(card).toContainText(/Crawling/i, { timeout: 5_000 });

		// After mocked workflow success, pill flips to "Indexed".
		await expect(card).toContainText(/Indexed/i, { timeout: 60_000 });
	});

	test("Manage expander changes cadence ONCE → WEEKLY", async ({ page }) => {
		await page.goto(`/app/projects/${PROJECT_ID}/contexts`);

		const card = page.locator("[data-testid^='link-card-']").first();
		await card.getByRole("button", { name: /manage/i }).click();
		await page
			.getByRole("combobox", { name: /refresh|cadence/i })
			.selectOption("WEEKLY");

		// The select onChange dispatches updateUrlSource; the success
		// toast surfaces once the procedure resolves.
		await expect(
			page.getByText(/cadence updated|schedule.*created/i),
		).toBeVisible({ timeout: 10_000 });
	});
});
