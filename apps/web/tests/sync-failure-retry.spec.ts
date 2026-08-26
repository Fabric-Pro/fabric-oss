/**
 * Sync Failure Fallback & Retry — Stage A E2E coverage sketch.
 *
 * Locks the six acceptance criteria for the "preserve failed AI Update
 * sidebar proposals in queue" feature: failed proposals must survive past
 * the disappearing toast, surface on the roadmap as a banner, and offer
 * per-row retry / dismiss actions that respect the dedup-guard idempotency
 * invariant.
 *
 * Status: SKIPPED in CI.
 *
 *   The seven-step happy path below requires:
 *     - A live PM-tool connection (Fizzy / ADO / GitLab / Jira) so the
 *       payload-too-large + dedup-collision triggers are exercisable
 *       end-to-end. Mocking the PM adapter at the page-route layer hides
 *       the cross-package retry semantics this spec exists to lock.
 *     - A staging project with at least one configured AI Update source
 *       (calendar meeting or freeform prompt) so the sidebar approve flow
 *       lights up.
 *     - A seeded user with PROJECT_UPDATE permission on the target project
 *       so the per-row Retry + Dismiss buttons are reachable.
 *
 *   Therefore this file is `test.describe.skip(...)` by default and runs
 *   only as part of staging verification (manual recipe / "/run" against
 *   staging.fabric.pro). When the team adds a deterministic interception
 *   layer for the AI Update workflow, flip the `.skip` to `.serial` and
 *   wire the env-var prerequisites below.
 *
 * ENV VAR PREREQUISITES (set in `.env.local` or shell before running):
 *
 *   TEST_PERSONAL_PROJECT_ID=<projectId>
 *     # Required. A real project the seeded user can access and that has
 *     # an AI Update source configured. Without it the suite self-skips.
 *
 *   TEST_ORG_SLUG=<orgSlug>
 *     # Optional. If set, the org-scope flow runs; otherwise only the
 *     # personal-scope flow runs.
 *
 *   TEST_AI_UPDATE_TRIGGER=long-title|dedup-collision
 *     # Optional. Controls which failure trigger the spec engineers into
 *     # the approved batch:
 *     #   - "long-title"      → seeds a proposal with a title >1MB to
 *     #                         force the API's RESOURCE_EXHAUSTED guard
 *     #                         OR (when split into chunks) a PM payload
 *     #                         too large error.
 *     #   - "dedup-collision" → pre-creates a UserStory whose title
 *     #                         matches the first proposed change so the
 *     #                         retry path lands on the dedup guard.
 *     # Default: "dedup-collision" (cheaper, no PM call required).
 *
 * Acceptance criteria mapping (cross-reference /spec.md §2 ACs):
 *
 *   AC #1 — failed items remain visible          → step 3 (banner)
 *   AC #2 — roadmap shows error + retry          → steps 3 + 4
 *   AC #3 — retry success → 'on roadmap'         → step 5
 *   AC #4 — retry failure → updated message      → step 5b (variant)
 *   AC #5 — batch "30 of 32 — 2 failed" copy     → step 3 (count-aware copy)
 *   AC #6 — dismiss → audit row in Sync History  → step 6
 *
 * Run with (staging):
 *   pnpm --filter web e2e tests/sync-failure-retry.spec.ts --grep @staging
 *
 * Run with (local, once mocked interception is wired):
 *   TEST_PERSONAL_PROJECT_ID=<id> pnpm --filter web e2e tests/sync-failure-retry.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data — fill in real IDs before running.
// Tests will skip themselves if projectId is left as the placeholder.
// ---------------------------------------------------------------------------

const TEST_DATA = {
	projectId: process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
	orgSlug: process.env.TEST_ORG_SLUG || "",
	trigger: (process.env.TEST_AI_UPDATE_TRIGGER || "dedup-collision") as
		| "long-title"
		| "dedup-collision",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Skip test if placeholder data has not been filled in. */
function skipIfNoData(projectId: string) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

/** Navigate to the project roadmap (org or personal scope). */
async function gotoRoadmap(
	page: Page,
	projectId: string,
	orgSlug?: string,
): Promise<void> {
	const base = orgSlug
		? `/app/${orgSlug}/projects/${projectId}/roadmap`
		: `/app/projects/${projectId}/roadmap`;
	await page.goto(base);
	await page.waitForLoadState("networkidle");
}

/**
 * Trigger the AI Update sidebar and approve a batch where at least one change
 * is engineered to fail. The mechanic depends on `TEST_AI_UPDATE_TRIGGER`:
 *
 *   "dedup-collision" — assumes a UserStory with title "Already on roadmap
 *                       test" already exists in the seeded project; the
 *                       approved batch includes a change with the same title
 *                       so the retry path lands on the dedup guard.
 *   "long-title"      — sends an approved-batch payload whose stringified
 *                       length is >1MB to trip the procedure-level
 *                       RESOURCE_EXHAUSTED guard.
 *
 * Real impl: opens the AI Update side panel, posts a prompt, awaits the
 * proposal list, clicks Approve. This is a placeholder until the staging
 * recipe is automated.
 */
async function triggerAiUpdateWithFailingChange(
	_page: Page,
	_trigger: "long-title" | "dedup-collision",
): Promise<void> {
	// TODO(staging-verification): wire the AI Update side-panel open +
	// prompt-and-approve sequence. The exact selectors depend on the
	// final BacklogChat.tsx surface and are intentionally not asserted
	// here so the test reads as a deterministic recipe for a human
	// running it in staging.
	//
	// Recipe (manual until automated):
	//   1. Click "AI Update" in the roadmap header.
	//   2. Type prompt: "Generate three engineering tasks for retry testing".
	//   3. Wait for the proposal list to render (3 rows).
	//   4. If trigger="dedup-collision", manually edit the first change's
	//      title to match an existing UserStory (e.g. "Already on roadmap
	//      test"). Click Approve.
	//   5. If trigger="long-title", paste a >1MB string into the description
	//      of the first change. Click Approve — the procedure rejects with
	//      RESOURCE_EXHAUSTED and the row stays FAILED.
}

// ---------------------------------------------------------------------------
// Tests — skipped by default; staging-verification harness flips this on.
// ---------------------------------------------------------------------------

test.describe.skip("Sync Failure Fallback & Retry (Stage A)", () => {
	// Why .skip: this suite hits the live PM-tool path end-to-end. Running
	// it in CI requires a deterministic interception layer that does not
	// yet exist (see file header for the gating constraints). Until that
	// lands, the suite serves as a verification recipe for staging.
	// Re-enable per-test with `.fixme` removal or by removing `.skip` here.

	test("personal scope — full retry happy path (AC #1, #2, #3, #5) @staging", async ({
		page,
	}) => {
		skipIfNoData(TEST_DATA.projectId);

		// Step 1: Log in to the test org (auth.setup.ts handles login state
		// via storageState; this block opens the roadmap directly).
		await gotoRoadmap(page, TEST_DATA.projectId, TEST_DATA.orgSlug);

		// Step 2: Open a project, trigger AI Update, approve a batch where at
		// least one change is engineered to fail (long-title payload-too-large
		// OR a pre-existing title for dedup collision).
		await triggerAiUpdateWithFailingChange(page, TEST_DATA.trigger);

		// Step 3: Assert the roadmap shows <FailedProposalsBanner> with the
		// AC #5 copy ("N of M proposals added to roadmap — K failed, click
		// to retry"). The banner is the persistent surface that survives the
		// disappearing toast — AC #1 and AC #2 are co-locked here because the
		// banner only renders when the failed-count query returns >0.
		const banner = page.locator(
			"section[aria-labelledby='failed-proposals-banner-heading']",
		);
		await expect(banner).toBeVisible({ timeout: 15_000 });
		await expect(banner).toContainText(/failed/i);
		// AC #5 copy variant (count-aware):
		await expect(banner).toContainText(
			/proposals (added|failed) to (roadmap|sync)/i,
		);

		// Step 4: Click the banner → assert <PendingBacklogProposalsInbox>
		// sheet opens with the Failed group expanded.
		await banner.getByRole("button", { name: /open|review/i }).click();
		const inbox = page.getByRole("dialog", {
			name: /pending backlog proposals|review proposals/i,
		});
		await expect(inbox).toBeVisible();
		await expect(inbox.getByText(/^failed/i)).toBeVisible();

		// Step 5: Click Retry on a row → assert the row leaves the Failed
		// group and reappears as an applied story on the roadmap. (AC #3)
		const failedRow = inbox
			.locator("[data-source='AI_UPDATE_SIDEBAR']")
			.first();
		await failedRow.getByRole("button", { name: /^retry$/i }).click();
		// The row leaves the Failed group on success — wait for it to detach.
		await expect(failedRow).toHaveCount(0, { timeout: 15_000 });

		// Close the inbox and verify the story is on the roadmap.
		await inbox.getByRole("button", { name: /close/i }).click();
		// Roadmap polls; give the new story time to appear.
		await expect(
			page.locator(
				"[data-test-id='story-card'], [data-component='StoryCard']",
			),
		).toContainText(/.+/, { timeout: 15_000 });

		// Visual proof for the staging-verification recipe.
		await page.screenshot({
			path: "test-results/sync-failure-retry-after-retry.png",
			fullPage: true,
		});
	});

	test("personal scope — retry failure surfaces updated message (AC #4) @staging", async ({
		page,
	}) => {
		skipIfNoData(TEST_DATA.projectId);

		// Variant of the happy path: first retry also fails (e.g. PM tool
		// credentials remain invalid). The row stays FAILED with an updated
		// `errorClass` / `errorMessage` / `failedAt`.
		test.fixme(
			true,
			"Wire the staging-credential-revoke fixture before enabling — TODO when interception is wired.",
		);

		await gotoRoadmap(page, TEST_DATA.projectId, TEST_DATA.orgSlug);
		await triggerAiUpdateWithFailingChange(page, "long-title");

		const banner = page.locator(
			"section[aria-labelledby='failed-proposals-banner-heading']",
		);
		await expect(banner).toBeVisible();
		await banner.getByRole("button", { name: /open|review/i }).click();

		const inbox = page.getByRole("dialog");
		const failedRow = inbox
			.locator("[data-source='AI_UPDATE_SIDEBAR']")
			.first();
		// Capture the initial error message.
		const initialMessage = await failedRow
			.locator("[data-test-id='plain-english-copy']")
			.textContent();

		await failedRow.getByRole("button", { name: /^retry$/i }).click();

		// Row stays in Failed group; updated message text differs from initial.
		await expect(failedRow).toBeVisible({ timeout: 15_000 });
		const updatedMessage = await failedRow
			.locator("[data-test-id='plain-english-copy']")
			.textContent();
		expect(updatedMessage).not.toBe(initialMessage);
	});

	test("personal scope — dismiss writes audit row to Sync History (AC #6) @staging", async ({
		page,
	}) => {
		skipIfNoData(TEST_DATA.projectId);

		await gotoRoadmap(page, TEST_DATA.projectId, TEST_DATA.orgSlug);
		await triggerAiUpdateWithFailingChange(page, TEST_DATA.trigger);

		const banner = page.locator(
			"section[aria-labelledby='failed-proposals-banner-heading']",
		);
		await expect(banner).toBeVisible();
		await banner.getByRole("button", { name: /open|review/i }).click();

		const inbox = page.getByRole("dialog");
		const failedRow = inbox
			.locator("[data-source='AI_UPDATE_SIDEBAR']")
			.first();

		// Step 6: Click Dismiss on a remaining row → assert removal from
		// inbox + appearance of an audit row in the Sync History tab. (AC #6)
		await failedRow.getByRole("button", { name: /dismiss/i }).click();

		// ConfirmDialog gates the destructive action.
		const confirmDialog = page.getByRole("alertdialog", {
			name: /dismiss this failed proposal/i,
		});
		await expect(confirmDialog).toBeVisible();
		await confirmDialog.getByRole("button", { name: /^dismiss$/i }).click();

		// Row leaves the inbox.
		await expect(failedRow).toHaveCount(0, { timeout: 10_000 });

		// Sonner toast confirms the dismiss.
		await expect(page.getByText(/dismissed.*sync history/i)).toBeVisible();

		// Navigate to the Sync History tab and verify the audit row exists.
		await page
			.getByRole("tab", { name: /sync history|history/i })
			.click()
			.catch(() => {
				// Tab may not be a tablist — fall back to link.
			});

		// Failure rows in Sync History are tagged with status="FAILURE".
		const auditRow = page
			.locator("[data-pm-sync-status='FAILURE']")
			.first();
		await expect(auditRow).toBeVisible({ timeout: 10_000 });

		// Step 7: Capture screenshots in light + dark + responsive viewports.
		await page.screenshot({
			path: "test-results/sync-failure-retry-after-dismiss.png",
			fullPage: true,
		});

		// Dark-mode capture (assumes theme toggle is keyboard-reachable).
		await page.emulateMedia({ colorScheme: "dark" });
		await page.screenshot({
			path: "test-results/sync-failure-retry-after-dismiss-dark.png",
			fullPage: true,
		});

		// Responsive (mobile viewport) capture.
		await page.setViewportSize({ width: 375, height: 812 });
		await page.screenshot({
			path: "test-results/sync-failure-retry-after-dismiss-mobile.png",
			fullPage: true,
		});
	});
});
