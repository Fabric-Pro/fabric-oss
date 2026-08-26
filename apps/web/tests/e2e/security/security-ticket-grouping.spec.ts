/**
 * E2E: "Group into tickets" (spec `2026-07-01-security-finding-tickets`).
 *
 * Scenarios:
 *   1. Config toggle off → the "Group into tickets" button is disabled with
 *      the correct tooltip; enabling the toggle and saving re-enables it.
 *   2. Happy path — trigger grouping on a project with a mix of
 *      SECURITY/ACCESSIBILITY findings across several themes → toast
 *      headline shows the correct counts → results dialog lists each theme
 *      with its correct outcome badge → navigating to a created ticket shows
 *      the assembled description, the theme tag chip, and (for accessibility
 *      themes) the `needs-rule-review` chip.
 *   3. Cancel-while-running → the button returns to its idle state and no
 *      spurious "completed" toast fires afterward.
 *
 * Each scenario uses its OWN seeded project (rather than one shared project)
 * so the suite is safe under Playwright's `fullyParallel` config — a run that
 * mutates the toggle or triggers a real grouping workflow in one test must
 * never race with another test reading the same project. This mirrors the
 * per-scenario fixture-id convention already used by
 * `apps/web/tests/e2e/stories/ai-generated-title.spec.ts`.
 *
 * Setup: reuses the existing `auth.setup.ts` storageState. Concrete IDs are
 * read from env vars; tests skip themselves when placeholders remain unset so
 * the suite stays green on PR checks while still being runnable manually.
 *
 * Env vars consumed (all optional — unset values cause tests to skip):
 *   TEST_SECURITY_GROUPING_TOGGLE_PROJECT_ID
 *     - A personal project with `agentTicketGenerationEnabled` OFF (the
 *       default) and at least one OPEN Security/Accessibility finding, so the
 *       only reason the button is disabled is the config gate, not an empty
 *       findings list.
 *   TEST_SECURITY_GROUPING_HAPPY_PATH_PROJECT_ID
 *     - A personal project with the toggle already ON and a COMPLETED scan
 *       whose OPEN findings span at least one SECURITY theme and one
 *       ACCESSIBILITY theme (distinct `ruleSource` values), so the results
 *       dialog has more than one row and at least one `needs-rule-review`
 *       ticket to verify.
 *   TEST_SECURITY_GROUPING_CANCEL_PROJECT_ID
 *     - A personal project with the toggle ON and enough open findings/themes
 *       that a run stays RUNNING long enough to reliably click Cancel (a
 *       project with a couple dozen distinct rule sources is a safe bet —
 *       tune this per-environment if the run completes before Cancel can be
 *       clicked).
 *
 * Manual runbook:
 *   - Toggle scenario: create a project, run at least one scan so a finding
 *     exists, leave "Fabric Agent ticket generation" off. Export its id as
 *     TEST_SECURITY_GROUPING_TOGGLE_PROJECT_ID.
 *   - Happy-path scenario: create a project with both Security and
 *     Accessibility scanning enabled, run a scan against seeded content that
 *     produces findings across multiple rule sources, then enable "Fabric
 *     Agent ticket generation" and save. Export its id as
 *     TEST_SECURITY_GROUPING_HAPPY_PATH_PROJECT_ID.
 *   - Cancel scenario: same setup as the happy-path project, but seed enough
 *     distinct findings/themes that the run doesn't settle before Cancel is
 *     clicked. Export its id as TEST_SECURITY_GROUPING_CANCEL_PROJECT_ID.
 *
 * Run:
 *   pnpm --filter web e2e tests/e2e/security/security-ticket-grouping.spec.ts
 */

import { expect, test } from "@playwright/test";

const TEST_DATA = {
	toggleProjectId:
		process.env.TEST_SECURITY_GROUPING_TOGGLE_PROJECT_ID ??
		"<toggle-project-id>",
	happyPathProjectId:
		process.env.TEST_SECURITY_GROUPING_HAPPY_PATH_PROJECT_ID ??
		"<happy-path-project-id>",
	cancelProjectId:
		process.env.TEST_SECURITY_GROUPING_CANCEL_PROJECT_ID ??
		"<cancel-project-id>",
} as const;

function isPlaceholder(value: string): boolean {
	return value.startsWith("<") && value.endsWith(">");
}

function skipIfAnyPlaceholder(...values: string[]): void {
	for (const v of values) {
		if (isPlaceholder(v)) {
			test.skip();
			return;
		}
	}
}

const SECURITY_URL = (projectId: string) =>
	`/app/projects/${projectId}/security`;

const GROUP_BUTTON_NAME = /group open findings into thematic tickets/i;
const ENABLE_TOGGLE_TOOLTIP =
	/enable fabric agent ticket generation in scan settings/i;
const HEADLINE_TOAST_PATTERN =
	/Created \d+ ticket\(s\), updated \d+, skipped \d+ already-covered theme\(s\)/;
const RESULTS_DIALOG_TITLE = /grouping results/i;
const NEEDS_RULE_REVIEW_TAG = "needs-rule-review";
// Deterministic per §4.6: `theme-<category>-<slug>-<8-char hash>`.
const THEME_TAG_PATTERN = /\btheme-(security|accessibility)-[a-z0-9-]+\b/;

test.describe("Group into tickets — config toggle gate", () => {
	test("disabled with the enable-toggle tooltip while off; enabling + saving re-enables it", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.toggleProjectId);

		await page.goto(SECURITY_URL(TEST_DATA.toggleProjectId));

		const groupButton = page.getByRole("button", {
			name: GROUP_BUTTON_NAME,
		});
		await expect(groupButton).toBeVisible({ timeout: 15_000 });
		await expect(groupButton).toBeDisabled();

		await groupButton.hover();
		await expect(page.getByText(ENABLE_TOGGLE_TOOLTIP).first()).toBeVisible(
			{
				timeout: 5_000,
			},
		);

		// Enable the toggle in the Configuration card and save.
		const toggle = page.getByRole("switch", {
			name: /toggle fabric agent ticket generation/i,
		});
		await expect(toggle).toBeVisible();
		await toggle.click();

		await page.getByRole("button", { name: /^save changes$/i }).click();
		await expect(
			page.getByText(/scan configuration saved/i).first(),
		).toBeVisible({ timeout: 15_000 });

		// The button re-enables once the gate is on (this project is seeded
		// with at least one open finding, so the only remaining gate — the
		// config toggle — is now satisfied).
		await expect(groupButton).toBeEnabled({ timeout: 15_000 });
	});
});

test.describe("Group into tickets — happy path", () => {
	test("groups findings into tickets, shows the headline toast, and the results dialog lists themes", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.happyPathProjectId);

		await page.goto(SECURITY_URL(TEST_DATA.happyPathProjectId));

		const groupButton = page.getByRole("button", {
			name: GROUP_BUTTON_NAME,
		});
		await expect(groupButton).toBeVisible({ timeout: 15_000 });
		await expect(groupButton).toBeEnabled();
		await groupButton.click();

		// In-progress toast fires immediately on start.
		await expect(
			page.getByText(/grouping findings into tickets/i).first(),
		).toBeVisible({ timeout: 5_000 });

		// Headline toast on completion — exact D20 phrasing with real counts.
		// Grouping involves an LLM drafting call per theme, so allow generous
		// time (mirrors this suite's AI-latency timeouts elsewhere).
		await expect(
			page.getByText(HEADLINE_TOAST_PATTERN).first(),
		).toBeVisible({
			timeout: 120_000,
		});

		// Results dialog opens automatically and lists themes with outcome
		// badges.
		const dialog = page.getByRole("dialog", { name: RESULTS_DIALOG_TITLE });
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		const outcomeBadge = dialog
			.getByText(/^(Created|Updated|Skipped)$/)
			.first();
		await expect(outcomeBadge).toBeVisible();

		// Navigate to a created ticket via its in-app link (F-XXX / B-XXX
		// identifier) and verify the assembled description + tag chips.
		const ticketLink = dialog
			.getByRole("link", { name: /\b[FB]-\d+\b/ })
			.first();
		await expect(ticketLink).toBeVisible();
		const href = await ticketLink.getAttribute("href");
		await dialog
			.getByRole("button", { name: /^close$/i })
			.first()
			.click();

		expect(href).toBeTruthy();
		await page.goto(href as string);

		// Assembled description's deterministic sections (§6).
		await expect(page.getByText(/severity breakdown/i).first()).toBeVisible(
			{ timeout: 15_000 },
		);
		await expect(
			page.getByText(/suggested remediation/i).first(),
		).toBeVisible();

		// The deterministic theme tag chip is always present on a generated
		// ticket.
		await expect(page.getByText(THEME_TAG_PATTERN).first()).toBeVisible();
	});

	test("an Accessibility-themed ticket carries the needs-rule-review tag", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.happyPathProjectId);

		await page.goto(SECURITY_URL(TEST_DATA.happyPathProjectId));

		const groupButton = page.getByRole("button", {
			name: GROUP_BUTTON_NAME,
		});
		await expect(groupButton).toBeVisible({ timeout: 15_000 });

		// A prior run in this suite may have already produced the dialog with
		// a "View last run" link — reuse it if grouping isn't currently
		// re-runnable, otherwise trigger a fresh run.
		if (await groupButton.isEnabled()) {
			await groupButton.click();
			await expect(
				page.getByText(HEADLINE_TOAST_PATTERN).first(),
			).toBeVisible({ timeout: 120_000 });
		} else {
			await page.getByRole("button", { name: /view last run/i }).click();
		}

		const dialog = page.getByRole("dialog", { name: RESULTS_DIALOG_TITLE });
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		const accessibilityRow = dialog
			.getByText("Accessibility", { exact: true })
			.first();
		await expect(accessibilityRow).toBeVisible();
		const row = accessibilityRow.locator("xpath=ancestor::li[1]");
		const ticketLink = row
			.getByRole("link", { name: /\b[FB]-\d+\b/ })
			.first();
		const href = await ticketLink.getAttribute("href");

		await dialog
			.getByRole("button", { name: /^close$/i })
			.first()
			.click();

		expect(href).toBeTruthy();
		await page.goto(href as string);
		await expect(
			page.getByText(NEEDS_RULE_REVIEW_TAG, { exact: true }).first(),
		).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Group into tickets — cancel while running", () => {
	test("returns to idle with no spurious completed toast", async ({
		page,
	}) => {
		skipIfAnyPlaceholder(TEST_DATA.cancelProjectId);

		await page.goto(SECURITY_URL(TEST_DATA.cancelProjectId));

		const groupButton = page.getByRole("button", {
			name: GROUP_BUTTON_NAME,
		});
		await expect(groupButton).toBeVisible({ timeout: 15_000 });
		await expect(groupButton).toBeEnabled();
		await groupButton.click();

		const cancelButton = page.getByRole("button", {
			name: /cancel the running grouping/i,
		});
		await expect(cancelButton).toBeVisible({ timeout: 10_000 });
		await cancelButton.click();

		await expect(page.getByText(/grouping cancelled/i).first()).toBeVisible(
			{ timeout: 10_000 },
		);

		// Button returns to idle (re-enabled, cancel control gone).
		await expect(cancelButton).toHaveCount(0);
		await expect(groupButton).toBeEnabled({ timeout: 10_000 });
		await expect(groupButton).toHaveText(/group into tickets/i);

		// No stale "completed" toast surfaces afterward for the run we
		// cancelled — give the poll a couple of cycles to prove a negative.
		await page.waitForTimeout(8_000);
		await expect(page.getByText(HEADLINE_TOAST_PATTERN)).toHaveCount(0);
	});
});
