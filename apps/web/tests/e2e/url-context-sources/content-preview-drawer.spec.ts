/**
 * E2E: URL Context Sources — Content preview drawer
 *
 * Spec: fabric/specs/2026-05-13-url-context-sources/spec.md §9.3, §15.3
 * Tasks: fabric/specs/2026-05-13-url-context-sources/tasks.md §10.4
 *
 * Scope:
 *   1. Drawer opens on "View content" → shows header (URL, scope, cadence,
 *      last-synced, "X pages indexed").
 *   2. Row list paginates via cursor: "Load more" appends rows.
 *   3. Expanding a row triggers lazy `getUrlPageContent` → markdown renders.
 *   4. No `vector` field shows up in any network response (privacy invariant).
 *
 * Status: SKIPPED in CI. Requires an existing LINK context with > 10
 * indexed pages so the cursor "Load more" path exercises. The "no
 * vectors" assertion uses Playwright's `page.on('response')` to inspect
 * JSON bodies — fast in practice, but needs a stable fixture project.
 *
 * TODO(group-10-followup): enable once
 *   (a) the v2 flag is set ON in the Playwright env, and
 *   (b) a fixture project with ≥ 25 URL pages exists in the dev DB.
 */

import { expect, test } from "@playwright/test";

const PROJECT_ID =
	process.env.TEST_PROJECT_WITH_INDEXED_URL_ID ?? "<project-id>";
const CONTEXT_ID =
	process.env.TEST_LINK_CONTEXT_WITH_PAGES_ID ?? "<link-context-id>";

function isPlaceholder(v: string): boolean {
	return v.startsWith("<") && v.endsWith(">");
}

test.describe("URL Context Sources — Content preview drawer", () => {
	test.skip(
		() => true,
		"Group 10 deferral: enable once a fixture project with ≥ 25 indexed URL pages exists in the dev DB",
	);

	test("opens drawer, paginates, expands a row, asserts no vectors", async ({
		page,
	}) => {
		if (isPlaceholder(PROJECT_ID) || isPlaceholder(CONTEXT_ID)) {
			test.skip();
		}

		// Hook every JSON response and assert it never contains a `vector`
		// field. Vectors live ONLY in Qdrant; the API contract
		// explicitly strips them from the response payload.
		const violations: string[] = [];
		page.on("response", async (res) => {
			const ct = res.headers()["content-type"] ?? "";
			if (!ct.includes("application/json")) {
				return;
			}
			try {
				const body = await res.json();
				const json = JSON.stringify(body);
				if (/"vector"\s*:/i.test(json)) {
					violations.push(`${res.url()} → contains "vector"`);
				}
			} catch {
				// Non-JSON response or already consumed body — ignore.
			}
		});

		await page.goto(`/app/projects/${PROJECT_ID}/contexts`);
		const card = page.getByTestId(`link-card-${CONTEXT_ID}`);
		await card.getByRole("button", { name: /view content/i }).click();

		// Drawer header.
		const drawer = page.getByRole("dialog");
		await expect(drawer).toBeVisible({ timeout: 10_000 });
		await expect(drawer.getByText(/pages indexed/i)).toBeVisible();

		// First page of rows.
		const initialRows = await drawer.locator("[data-page-row]").count();
		expect(initialRows).toBeGreaterThan(0);

		// Cursor pagination.
		const loadMore = drawer.getByRole("button", { name: /load more/i });
		if (await loadMore.isVisible()) {
			await loadMore.click();
			await expect
				.poll(async () => drawer.locator("[data-page-row]").count())
				.toBeGreaterThan(initialRows);
		}

		// Row expand triggers getUrlPageContent.
		const firstRow = drawer.locator("[data-page-row]").first();
		await firstRow.click();
		await expect(drawer.getByRole("article")).toBeVisible({
			timeout: 10_000,
		});

		expect(
			violations,
			`Privacy invariant breach: ${violations.join(", ")}`,
		).toEqual([]);
	});
});
