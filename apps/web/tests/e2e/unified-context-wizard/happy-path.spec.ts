/**
 * E2E: Unified Context Wizard — Happy path (File + Link + Text)
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §13.4
 *   (first bullet) + AC1–AC5.
 * Tasks: fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md §14.1.
 *
 * Scope:
 *   1. New project wizard → enter name → "Add Context" CTA opens dialog.
 *   2. Add a File (PDF) → Link (URL with PATH_PREFIX auto-detect) → Text
 *      snippet — close dialog after each.
 *   3. Inline pending-items list (`pending-items-list`) shows 3 rows with
 *      status pills.
 *   4. Click "Create Project" → redirect to project page → contexts tab
 *      shows all 3 items (file processed, URL extracting, text indexed).
 *
 * Status: SKIPPED in CI. Requires the full stack — local web app on port
 * 3001 + Postgres + Temporal worker + LangGraph agents + a configured
 * Firecrawl key (or a network-mocked one) — and a signed-in seeded user.
 * Same deferral pattern as the prior url-context-sources E2E suite
 * (`tests/e2e/url-context-sources/*.spec.ts`).
 *
 * Run criteria (drop the `test.skip` when ALL are true):
 *   (a) `./aspire.sh restart` has the stack healthy (Postgres, Temporal,
 *       temporal-worker, web app all `Running`).
 *   (b) `tests/auth.setup.ts` has seeded at least one Personal-tenant user
 *       with a configured Firecrawl key (or a network-mocked one via the
 *       follow-up `helpers/firecrawl-mock.ts` recipe).
 *   (c) The wizard route `/app/projects/new/create` is reachable
 *       post-login.
 *
 * Manual driver: covered in Group 15.4 (`spec.md` §15.4) via
 * `mcp__playwright__*` MCP tools against the running local app.
 */

import * as path from "node:path";
import { expect, test } from "@playwright/test";

const PDF_FIXTURE = path.join(__dirname, "..", "..", "fixtures", "sample.pdf");
const LINK_URL = "https://docs.example.com/hc/en-us";
const TEXT_SNIPPET =
	"Architectural overview: the unified context wizard accepts files, links, and free-text snippets in a single dialog.";

test.describe("Unified Context Wizard — happy path (File + Link + Text)", () => {
	test.skip(
		() => true,
		"Group 14 deferral: enable once local stack + Firecrawl mock + auth fixtures are wired (see file header for run criteria).",
	);

	test("create project with 3 context items and land on the contexts tab", async ({
		page,
	}) => {
		// (1) Open the wizard, enter a project name.
		await page.goto("/app/projects/new/create");

		const projectName = `E2E Wizard Happy Path ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		// Blur to trigger the DRAFT autosave + duplicate-name check.
		await page.getByLabel(/project name/i).blur();

		// (2) Click "Add Context" CTA — bound to the DRAFT projectId per
		// spec §7.3. The CTA's `aria-label` is "Add project context" and
		// it carries `data-testid="add-context-cta"`.
		const addContextCta = page.getByTestId("add-context-cta");
		await expect(addContextCta).toBeEnabled({ timeout: 5_000 });
		await addContextCta.click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });

		// (3a) Add a File via the File tab.
		await dialog.getByRole("tab", { name: /file/i }).click();
		await dialog.setInputFiles('input[type="file"]', PDF_FIXTURE);
		// Single-file submit label per spec §7.1.
		await dialog.getByRole("button", { name: /^upload$/i }).click();
		// Dialog auto-closes after the last file completes.
		await expect(dialog).toBeHidden({ timeout: 60_000 });

		// (3b) Re-open and add a Link.
		await addContextCta.click();
		await expect(dialog).toBeVisible();
		await dialog.getByRole("tab", { name: /link/i }).click();
		await dialog.getByLabel(/url/i).fill(LINK_URL);
		await dialog.getByLabel(/url/i).blur();
		// Auto-detect should flip the scope to PATH_PREFIX for a /hc/ path.
		await expect(
			dialog.getByRole("radio", { name: /path-prefix/i }),
		).toHaveAttribute("data-state", "checked");
		await dialog.getByRole("button", { name: /^add context$/i }).click();
		// Sonner toast at submit per spec §8.4.
		await expect(page.getByText(/indexing/i)).toBeVisible({
			timeout: 5_000,
		});

		// (3c) Re-open and add a Text snippet.
		await addContextCta.click();
		await expect(dialog).toBeVisible();
		await dialog.getByRole("tab", { name: /text/i }).click();
		await dialog
			.getByRole("textbox", { name: /content|text/i })
			.fill(TEXT_SNIPPET);
		await dialog
			.getByRole("button", { name: /^add (context|text)$/i })
			.click();
		await expect(dialog).toBeHidden({ timeout: 10_000 });

		// (4) Inline pending-items list shows 3 rows with status pills.
		const pendingList = page.getByTestId("pending-items-list");
		await expect(pendingList).toBeVisible();
		// Rows render with `data-testid="pending-row-{contextId}"` —
		// asserting `>= 3` rows lets the test tolerate any extra noise rows.
		await expect
			.poll(async () =>
				pendingList.locator("[data-testid^='pending-row-']").count(),
			)
			.toBeGreaterThanOrEqual(3);

		// (5) Click "Create Project" — DRAFT → ACTIVE flip, redirect.
		await page.getByRole("button", { name: /^create project$/i }).click();
		// Project page URL contains the new projectId (DRAFT.id was reused).
		await expect(page).toHaveURL(/\/projects\/[^/]+$/, { timeout: 30_000 });

		// (6) Open the contexts tab — all 3 items survive activation per AC2.
		await page.getByRole("tab", { name: /context/i }).click();
		const cards = page.locator(
			"[data-testid^='link-card-'], [data-testid^='file-card-'], [data-testid^='text-card-']",
		);
		await expect
			.poll(async () => cards.count(), { timeout: 15_000 })
			.toBeGreaterThanOrEqual(3);
	});
});
