/**
 * Playwright tests for the Capabilities Picker in CopilotPage
 *
 * Tests that the capabilities picker shows the correct tools,
 * is searchable, and contains both built-in and integration capabilities.
 */

import { expect, test } from "@playwright/test";

// Helper to navigate to the copilot page
async function _goToCopilotPage(
	page: Parameters<typeof test>[1] extends (args: {
		page: infer P;
	}) => unknown
		? P
		: never,
) {
	await page.goto("/app/copilot");
}

test.describe("Capabilities Picker", () => {
	test.beforeEach(async ({ page }) => {
		// The copilot page may redirect to login if not authenticated
		// In CI, we skip authentication-dependent tests
		await page.goto("/app/copilot");
		// If redirected to login, skip
		if (page.url().includes("/auth/login")) {
			test.skip();
		}
	});

	test("capabilities button should exist in compose toolbar", async ({
		page,
	}) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await expect(capsButton).toBeVisible();
	});

	test("capabilities picker opens on click", async ({ page }) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		// The popover should appear
		await expect(
			page.getByText("Capabilities", { exact: true }),
		).toBeVisible();
	});

	test("capabilities picker has search input", async ({ page }) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		const searchInput = page.getByPlaceholder("Search capabilities...");
		await expect(searchInput).toBeVisible();
	});

	test("capabilities picker shows built-in tools", async ({ page }) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		// Check for built-in capabilities
		await expect(page.getByText("Create Files")).toBeVisible();
		await expect(page.getByText("Create Frames")).toBeVisible();
		await expect(page.getByText("Create Images")).toBeVisible();
		await expect(page.getByText("Discover Knowledge")).toBeVisible();
		await expect(page.getByText("Discover Tools")).toBeVisible();
		await expect(page.getByText("Speech Generator")).toBeVisible();
		await expect(page.getByText("Web Search & Browse")).toBeVisible();
	});

	test("capabilities picker shows integration tools", async ({ page }) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		// Check for integration capabilities
		await expect(page.getByText("Asana")).toBeVisible();
		await expect(page.getByText("Attio")).toBeVisible();
		await expect(page.getByText("Linear")).toBeVisible();
		await expect(page.getByText("Slack")).toBeVisible();
		await expect(page.getByText("GitHub")).toBeVisible();
		await expect(page.getByText("Notion")).toBeVisible();
		await expect(page.getByText("Front")).toBeVisible();
		await expect(page.getByText("Freshservice")).toBeVisible();
	});

	test("search filters capabilities correctly", async ({ page }) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		const searchInput = page.getByPlaceholder("Search capabilities...");
		await searchInput.fill("asana");

		// Should show Asana
		await expect(page.getByText("Asana")).toBeVisible();

		// Should not show unrelated items
		await expect(page.getByText("Create Files")).not.toBeVisible();
		await expect(page.getByText("Linear")).not.toBeVisible();
	});

	test("search shows empty state when no results", async ({ page }) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		const searchInput = page.getByPlaceholder("Search capabilities...");
		await searchInput.fill("xyznonexistent123");

		await expect(
			page.getByText("No capabilities match your search"),
		).toBeVisible();
	});

	test("integration tools have Configure badge", async ({ page }) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		// Integration capabilities should have "Configure" badges
		const configureButtons = page.getByText("Configure");
		await expect(configureButtons.first()).toBeVisible();
	});

	test("capabilities picker closes after clicking Discover Tools link", async ({
		page,
	}) => {
		const capsButton = page.getByRole("button", { name: "Capabilities" });
		await capsButton.click();

		const discoverToolsLink = page.getByText("Discover Tools");
		await discoverToolsLink.click();

		// Picker should close after clicking a link
		await expect(
			page.getByPlaceholder("Search capabilities..."),
		).not.toBeVisible();
	});
});
