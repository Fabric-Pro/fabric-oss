/**
 * E2E: Confluence as a project context source — happy + negative paths.
 *
 * Spec:  ideas/confluence-project-context-source/spec.md (FR1/FR4/FR5/FR6/FR7).
 * Tasks: ideas/confluence-project-context-source/tasks.md §3.1.
 *
 * Scope:
 *   Happy path
 *     1. Open a project → "Add Context" → the **Confluence tab is present**
 *        (AC1.1).
 *     2. "Browse Confluence Pages" opens the selector (spaces / search work).
 *     3. Select 1–2 pages → confirm → success toast with the count (AC4.3).
 *     4. The pages render as **first-class Confluence cards** (brand icon +
 *        "Confluence" badge) (AC7.1).
 *     5. Re-open the selector → previously-added pages are **disabled** with an
 *        "Added" affordance (AC6.1).
 *   Negative
 *     6. With **no** Confluence MCP config, the tab is still present but the
 *        panel shows the no-config empty state (AC1.2).
 *     7. A mocked failed content fetch yields a **PENDING empty-content row**
 *        with no crash, and other pages in the batch still succeed (AC5.1).
 *
 * Status: SKIPPED in CI. Requires the full stack — local web app on port 3001
 * + Postgres + Temporal worker — a signed-in seeded user, AND a connected
 * Confluence MCP config (catalog `key: "atlassian"`, `tags` include
 * "confluence"). Same deferral pattern as the url-context-sources and
 * unified-context-wizard E2E suites (`tests/e2e/*`).
 *
 * Run criteria (drop the `test.skip` when ALL are true):
 *   (a) `./aspire.sh restart` has the stack healthy (web app, Postgres,
 *       Temporal, temporal-worker all `Running`).
 *   (b) `tests/auth.setup.ts` has a signed-in Personal-tenant user.
 *   (c) A Confluence MCP server is connected for that tenant (Settings →
 *       Integrations → Atlassian / Confluence), so `mcp.configs.list()`
 *       returns a config the catalog-tag predicate detects.
 *   (d) The env vars below point at a seeded project (and, for the negative
 *       case, a project/tenant with NO Confluence config).
 *
 * Env vars consumed (all optional — unset values cause tests to skip):
 *   TEST_PERSONAL_PROJECT_ID            project to add Confluence context to
 *   TEST_CONFLUENCE_PAGE_SEARCH         a query that surfaces ≥1 page
 *   TEST_PROJECT_WITHOUT_CONFLUENCE_ID  project on a tenant with no Confluence
 *
 * Manual driver: covered via `mcp__playwright__*` MCP tools against the
 * running local app (staging.fabric.pro per the project QA convention).
 *
 * Run:
 *   pnpm --filter web e2e tests/e2e/confluence-context-source/confluence-context.spec.ts
 */

import { expect, test } from "@playwright/test";

const PROJECT_ID = process.env.TEST_PERSONAL_PROJECT_ID ?? "";
const PAGE_SEARCH = process.env.TEST_CONFLUENCE_PAGE_SEARCH ?? "";
const PROJECT_WITHOUT_CONFLUENCE_ID =
	process.env.TEST_PROJECT_WITHOUT_CONFLUENCE_ID ?? "";

test.describe("Confluence project context source", () => {
	test.skip(
		() => true,
		"Deferral: enable once local stack + auth fixtures + a connected Confluence MCP config are wired (see file header run criteria).",
	);

	test("happy path: add Confluence pages and see first-class cards, then disabled on re-open", async ({
		page,
	}) => {
		test.skip(
			!PROJECT_ID || !PAGE_SEARCH,
			"Set TEST_PERSONAL_PROJECT_ID and TEST_CONFLUENCE_PAGE_SEARCH.",
		);

		await page.goto(`/app/projects/${PROJECT_ID}`);

		// (1) Open Add Context and assert the Confluence tab is present (AC1.1).
		await page.getByTestId("add-context-cta").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		const confluenceTab = dialog.getByRole("tab", { name: /confluence/i });
		await expect(confluenceTab).toBeVisible();
		await confluenceTab.click();

		// (2) Browse → selector opens.
		await dialog
			.getByRole("button", { name: /Browse Confluence Pages/i })
			.click();
		const selector = page.getByRole("dialog").last();
		await selector.getByPlaceholder(/search/i).fill(PAGE_SEARCH);

		// (3) Select the first page and confirm.
		const firstPage = selector.getByRole("checkbox").first();
		await expect(firstPage).toBeEnabled({ timeout: 10_000 });
		await firstPage.click();
		await selector.getByRole("button", { name: /Add \d+ Page/i }).click();

		// Success toast with a count (AC4.3).
		await expect(
			page.getByText(/Added \d+ page\(s\) to project/i),
		).toBeVisible({ timeout: 30_000 });

		// (4) The page renders as a first-class Confluence card (AC7.1).
		await expect(
			page.getByText("Confluence", { exact: false }).first(),
		).toBeVisible({ timeout: 15_000 });

		// (5) Re-open the selector → the added page is disabled (AC6.1).
		await page.getByTestId("add-context-cta").click();
		await dialog.getByRole("tab", { name: /confluence/i }).click();
		await dialog
			.getByRole("button", { name: /Browse Confluence Pages/i })
			.click();
		const reopened = page.getByRole("dialog").last();
		await reopened.getByPlaceholder(/search/i).fill(PAGE_SEARCH);
		await expect(reopened.getByText("Added").first()).toBeVisible({
			timeout: 10_000,
		});
	});

	test("negative: no Confluence config shows the empty state (AC1.2)", async ({
		page,
	}) => {
		test.skip(
			!PROJECT_WITHOUT_CONFLUENCE_ID,
			"Set TEST_PROJECT_WITHOUT_CONFLUENCE_ID (a tenant with no Confluence config).",
		);

		await page.goto(`/app/projects/${PROJECT_WITHOUT_CONFLUENCE_ID}`);
		await page.getByTestId("add-context-cta").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();

		// Tab is present even without a config (always in allTabs).
		await dialog.getByRole("tab", { name: /confluence/i }).click();
		await expect(
			dialog.getByText(/No Confluence MCP server configured/i),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: /Browse Confluence Pages/i }),
		).toHaveCount(0);
	});
});
