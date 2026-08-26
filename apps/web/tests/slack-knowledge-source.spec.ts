/**
 * Playwright tests for the Slack card in the Project Knowledge Sources wizard.
 *
 * Verifies that the Slack integration card renders unconditionally
 * in the project creation wizard. The Slack channel selector dialog
 * uses OAuth-based Slack API (not MCP), mirroring the Teams pattern.
 *
 * The default test user is unlikely to have a connected Slack workspace,
 * so the "not connected" state is the expected dialog state.
 */

import { expect, test } from "@playwright/test";

test.describe("Slack Project Knowledge Source", () => {
	test.beforeEach(async ({ page }) => {
		// Navigate to the project creation wizard
		await page.goto("/app/projects/new/create");

		// If redirected to login, skip (not authenticated in this environment)
		if (page.url().includes("/auth/login")) {
			test.skip();
		}

		// Wait for the page to finish loading
		await page.waitForLoadState("networkidle");
	});

	test("Slack card is visible in Project Knowledge Sources without integration", async ({
		page,
	}) => {
		// The "Project Knowledge Sources" section should be visible
		await expect(page.getByText("Project Knowledge Sources")).toBeVisible();

		// The Slack card should render with its title
		const slackHeading = page.getByRole("heading", { name: "Slack" });
		await expect(slackHeading).toBeVisible();

		// The card should show the description text
		await expect(
			page.getByText(
				"Add Slack channels for project communication context",
			),
		).toBeVisible();
	});

	test("Slack Add button opens dialog with not-connected state", async ({
		page,
	}) => {
		// Click the Add button on the Slack card
		const slackSection = page.locator("div", {
			has: page.getByRole("heading", { name: "Slack", level: 5 }),
		});
		await slackSection.getByRole("button", { name: /Add/ }).click();

		// The dialog should open with "Slack Workspace Not Connected" message
		await expect(
			page.getByText("Slack Workspace Not Connected"),
		).toBeVisible();

		// Should show a link to connect Slack via Settings > Integrations
		const connectLink = page.getByRole("link", {
			name: "Connect Slack",
		});
		await expect(connectLink).toBeVisible();
		const href = await connectLink.getAttribute("href");
		expect(href).toContain("/settings/integrations");
	});

	test("Slack dialog confirm button is disabled when not connected", async ({
		page,
	}) => {
		// Click the Add button on the Slack card
		const slackSection = page.locator("div", {
			has: page.getByRole("heading", { name: "Slack", level: 5 }),
		});
		await slackSection.getByRole("button", { name: /Add/ }).click();

		// The Add 0 Items button should be disabled
		const confirmButton = page.getByRole("button", {
			name: /Add 0 Item/,
		});
		await expect(confirmButton).toBeDisabled();
	});
});
