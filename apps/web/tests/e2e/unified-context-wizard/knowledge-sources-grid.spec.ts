/**
 * E2E: Unified Context Wizard — Knowledge Sources grid sanity (Q8 binding)
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §7.4
 *   (Delete + Keep lists, Code Repository rename) + Q8 binding.
 * Tasks: fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md §14.6.
 *
 * Scope:
 *   1. Open the wizard.
 *   2. Confirm the section formerly titled "Project Knowledge Sources" now
 *      reads "Code Repository" (per spec §7.4 rename).
 *   3. Confirm GitHub + GitLab picker cards ARE visible.
 *   4. Confirm Teams + Slack + Notion picker cards are NOT visible — they
 *      were deleted in favour of the unified Add Context dialog (Q8
 *      binding).
 *
 * This is the lightest of the 6 specs — no DRAFT autosave, no oRPC writes,
 * no Temporal interaction. Pure render-assertion against the static wizard
 * shell. In theory it COULD run in CI today against a no-Firecrawl, no-Temporal
 * stack — but realistically it still needs:
 *   (a) auth fixtures so the wizard route is reachable post-login, AND
 *   (b) the seeded user must NOT have a GitHub / GitLab connection
 *       already (otherwise the picker cards collapse to "X repos added"
 *       state which still proves visibility but changes the locator copy).
 *
 * Status: SKIPPED in CI to stay consistent with the other 5 specs in this
 * group. Once (a) is wired, this is the FIRST spec in the group worth
 * un-skipping — it has the lowest infra requirements.
 *
 * Run criteria: auth fixtures wired (see `tests/auth.setup.ts` TODO).
 *
 * Manual driver: covered in Group 15.11 (`spec.md` §15.11).
 */

import { expect, test } from "@playwright/test";

test.describe("Unified Context Wizard — Knowledge Sources grid sanity", () => {
	test.skip(
		() => true,
		"Group 14 deferral: enable once auth fixtures are wired (lowest-friction of the 6 specs; un-skip first).",
	);

	test("Code Repository section shows GitHub + GitLab only — Teams/Slack/Notion deleted", async ({
		page,
	}) => {
		// (1) Open the wizard.
		await page.goto("/app/projects/new/create");

		// (2) Section heading copy renamed per spec §7.4. The renamed
		// section is rendered by `WizardIntegrationsSection.tsx:96` as
		// `<h4 className="font-medium text-sm">Code Repository</h4>`.
		await expect(
			page.getByRole("heading", { name: /^code repository$/i }),
		).toBeVisible({ timeout: 10_000 });

		// (3a) GitHub picker card is visible — per spec §7.4 Keep list.
		await expect(page.getByText(/^GitHub$/i)).toBeVisible();

		// (3b) GitLab picker card is visible — per spec §7.4 Keep list.
		await expect(page.getByText(/^GitLab$/i)).toBeVisible();

		// (4) Teams / Slack / Notion picker cards are NOT visible inside
		// the Code Repository section. The Teams chat picker
		// (`TeamsChatSelectorDialog`), Notion pages picker
		// (`NotionPagesPickerDialog`), and Slack channel picker
		// (`SlackChannelSelectorDialog`) were deleted per spec §7.4
		// Delete list. They still exist as components for the unified
		// dialog (`ContextUploaderDialog`) — so we scope the negative
		// assertion to the section heading's region, not the whole page.
		const codeRepoSection = page
			.getByRole("heading", { name: /^code repository$/i })
			.locator("xpath=ancestor::*[self::section or self::div][1]");

		// Confirm Teams/Slack/Notion card *titles* don't appear inside
		// this section. We match exact-text headings only — the words
		// might appear elsewhere on the page (e.g. inside the dialog if
		// it happens to be open, or in screen-reader-only labels).
		await expect(codeRepoSection.getByText(/^teams$/i)).toHaveCount(0);
		await expect(codeRepoSection.getByText(/^slack$/i)).toHaveCount(0);
		await expect(codeRepoSection.getByText(/^notion$/i)).toHaveCount(0);
	});
});
