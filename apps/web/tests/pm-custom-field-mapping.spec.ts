/**
 * PM custom field read-mapping — E2E happy path.
 *
 * STATUS: DEFERRED TO LIVE VERIFICATION.
 * ------------------------------------------------------------------------------
 * This is a reviewable SKELETON, intentionally not executed in CI. The full flow
 * needs live infrastructure that is not available in the authoring session:
 *   - a running app (:3001) with a seeded admin on an ADO-connected project,
 *   - the project-level `pmFieldMappingEnabled` flag flipped ON,
 *   - a real (or `page.route`-mocked) ADO MCP surface for enumerate / preview /
 *     get, plus a work item with populated custom fields.
 *
 * The suite is wrapped in `test.describe.fixme(...)` so Playwright reports it as
 * pending (never a false red) until wired against staging/dev per Task 7.9. To
 * bring it live, mirror the oRPC route-interception strategy in
 * `gitlab-issues-sync.spec.ts` / `pm-import-filtering.spec.ts` (intercept
 * `projects.pm.enumerateFields`, `projects.pm.previewTicketFields`,
 * `projects.update`, and `stories/sync`), set `TEST_PERSONAL_PROJECT_ID`, and
 * remove the `.fixme`.
 *
 * Run (once wired): pnpm --filter web e2e tests/pm-custom-field-mapping.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

const PROJECT_ID = process.env.TEST_PERSONAL_PROJECT_ID ?? "";

async function openProjectManagementTab(_page: Page): Promise<void> {
	// TODO(7.9): navigate to the project settings, open the flag-gated
	// "Project Management" tab, and wait for the field-mapping panel to mount.
	throw new Error("skeleton — wire against live app per Task 7.9");
}

test.describe.fixme(
	"PM custom field mapping — admin configure + sync (deferred to live verification)",
	() => {
		test.skip(!PROJECT_ID, "requires TEST_PERSONAL_PROJECT_ID");

		test("admin enumerates fields, previews a ticket, selects + reorders, saves", async ({
			page,
		}) => {
			// Scenario 1: configure the mapping end-to-end.
			await openProjectManagementTab(page);

			// 1. Field catalog enumerates on panel mount (union of work-item-type
			//    fields); plumbing hidden by default, revealed via "Show all fields".
			await expect(
				page.getByRole("button", { name: "Refresh fields" }),
			).toBeVisible();

			// 2. Preview a real work item → per-field live values / (empty) affordance.
			await page.getByLabel(/Preview an example ticket/i).fill("1234");
			await page.getByRole("button", { name: "Preview" }).click();
			await expect(page.getByText(/has content|\(empty\)/)).toBeVisible();

			// 3. Select content-bearing fields, reorder via keyboard move-up/down,
			//    and Save. Assert the "Saved" confirmation appears.
			await page
				.getByRole("button", { name: /Add Business Rules/i })
				.click();
			await page
				.getByRole("button", { name: /Move .* up/ })
				.first()
				.click();
			await page.getByRole("button", { name: "Save mapping" }).click();
			await expect(page.getByText("Saved")).toBeVisible();
		});

		test("synced work item body shows configured ## sections in order, empty omitted", async ({
			page,
		}) => {
			// Scenario 2: trigger a sync on a work item with populated
			// custom fields → Fabric content shows the configured `##` sections in
			// the configured order; empty configured fields are omitted.
			await openProjectManagementTab(page);
			// TODO(7.9): push/pull the work item, open the feature, assert the
			// rendered markdown headings + order + omission of empty fields.
			expect(true).toBe(true);
		});

		test("rename: the settings tab reads Development and deep-links land correctly", async ({
			page,
		}) => {
			// Scenario 3: the former "Execution" tab now reads
			// "Development"; deep-links land on the correct tab; no lost persistence
			// after the sessionStorage-key fix (a stale "execution" value migrates).
			await openProjectManagementTab(page);
			await expect(
				page.getByRole("tab", { name: "Development" }),
			).toBeVisible();
			await expect(
				page.getByRole("tab", { name: "Execution" }),
			).toHaveCount(0);
		});
	},
);
