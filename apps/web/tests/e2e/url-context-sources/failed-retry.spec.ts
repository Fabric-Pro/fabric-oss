/**
 * E2E: URL Context Sources — Failed badge → Retry
 *
 * Spec: fabric/specs/2026-05-13-url-context-sources/spec.md §10, §15.3
 * Tasks: fabric/specs/2026-05-13-url-context-sources/tasks.md §10.5
 *
 * Scope:
 *   1. A LINK context in FAILED state renders the destructive badge.
 *   2. Clicking Retry calls `resyncUrlSource` and the pill flips back
 *      to Crawling.
 *
 * Status: SKIPPED in CI. Needs a fixture context that's been forced
 * into FAILED state (e.g. via a robots-blocked URL). Best driven from
 * a Prisma snippet against the dev DB in the same setup that seeds
 * the Group 10.3 add-and-cadence fixtures.
 *
 * TODO(group-10-followup): enable once a fixture LINK context in
 * `extractionStatus === "FAILED"` exists in the dev DB and the
 * Firecrawl mock supports a "first call fails, second succeeds"
 * recipe so the post-Retry transition is observable.
 */

import { expect, test } from "@playwright/test";

const PROJECT_ID =
	process.env.TEST_PROJECT_WITH_FAILED_URL_ID ?? "<project-id>";
const CONTEXT_ID =
	process.env.TEST_LINK_CONTEXT_FAILED_ID ?? "<failed-context-id>";

function isPlaceholder(v: string): boolean {
	return v.startsWith("<") && v.endsWith(">");
}

test.describe("URL Context Sources — Failed badge + Retry", () => {
	test.skip(
		() => true,
		"Group 10 deferral: enable once a fixture FAILED LINK context exists in the dev DB",
	);

	test("destructive badge → click Retry → status flips to Crawling", async ({
		page,
	}) => {
		if (isPlaceholder(PROJECT_ID) || isPlaceholder(CONTEXT_ID)) {
			test.skip();
		}

		await page.goto(`/app/projects/${PROJECT_ID}/contexts`);
		const card = page.getByTestId(`link-card-${CONTEXT_ID}`);

		// Destructive badge is keyboard-focusable per Group 8 a11y notes.
		const failedBadge = card.getByRole("button", { name: /failed/i });
		await expect(failedBadge).toBeVisible();

		await failedBadge.click(); // Opens the destructive tooltip.
		await page.getByRole("button", { name: /retry/i }).click();

		// Status pill should flip back to Crawling within the polling window.
		await expect(card).toContainText(/Crawling/i, { timeout: 30_000 });
	});
});
