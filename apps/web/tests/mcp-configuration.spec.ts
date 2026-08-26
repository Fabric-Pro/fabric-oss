import { expect, test } from "@playwright/test";

/**
 * E2E tests for MCP Server Configuration CRUD operations
 * Prerequisites: User must be logged in, database seeded with test MCP servers
 */

test.describe("MCP Server Configuration", () => {
	test.beforeEach(async ({ page }) => {
		// Navigate to MCP settings page
		// Adjust the URL based on your actual route structure
		await page.goto("/app/settings/mcp-servers");

		// Wait for page to load
		await page.waitForLoadState("networkidle");
	});

	test.describe("View MCP Servers", () => {
		test("should display list of available MCP servers", async ({
			page,
		}) => {
			// Check if the page header is visible
			await expect(
				page.getByRole("heading", { name: /MCP Servers/i }),
			).toBeVisible();

			// Check if server cards are rendered
			const serverCards = page.locator('[data-testid="mcp-server-card"]');
			await expect(serverCards.first()).toBeVisible();
		});

		test("should display system-provided and custom servers separately", async ({
			page,
		}) => {
			// Check for system-provided servers section
			const systemServersSection = page.locator(
				'[data-testid="system-servers"]',
			);
			if (await systemServersSection.isVisible()) {
				await expect(systemServersSection).toContainText(
					/System Provided/i,
				);
			}

			// Check for custom servers section
			const customServersSection = page.locator(
				'[data-testid="custom-servers"]',
			);
			if (await customServersSection.isVisible()) {
				await expect(customServersSection).toContainText(
					/Custom Servers/i,
				);
			}
		});
	});

	test.describe("Create MCP Configuration", () => {
		test("should create API Key configuration", async ({ page }) => {
			// Find a server with API_KEY auth support
			const configureButton = page
				.locator('[data-testid="mcp-server-card"]')
				.first()
				.getByRole("button", { name: /configure/i });

			await configureButton.click();

			// Fill in configuration form
			await page
				.getByLabel(/base url/i)
				.fill("https://test-mcp.example.com");

			// Select API Key auth type
			await page.getByLabel(/auth.*type/i).click();
			await page.getByRole("option", { name: /api.*key/i }).click();

			// Enter API key
			await page.getByLabel(/api.*key/i).fill("test-api-key-123456789");

			// Optional: Enter display name
			await page.getByLabel(/display.*name/i).fill("My Test MCP Server");

			// Save configuration
			await page.getByRole("button", { name: /save|create/i }).click();

			// Wait for success message
			await expect(page.getByText(/success|created/i)).toBeVisible({
				timeout: 5000,
			});

			// Verify configuration appears in list
			await expect(page.getByText("My Test MCP Server")).toBeVisible();
		});

		test("should create OAuth2 configuration and initiate flow", async ({
			page,
			context,
		}) => {
			// Find a server with OAUTH2 auth support
			const configureButton = page
				.locator('[data-testid="mcp-server-card"]')
				.filter({ hasText: /oauth/i })
				.first()
				.getByRole("button", { name: /configure/i });

			// Skip if no OAuth servers available
			if (!(await configureButton.isVisible())) {
				test.skip();
				return;
			}

			await configureButton.click();

			// Fill in configuration form
			await page
				.getByLabel(/base url/i)
				.fill("https://oauth-mcp.example.com");

			// Select OAuth2 auth type
			await page.getByLabel(/auth.*type/i).click();
			await page.getByRole("option", { name: /oauth/i }).click();

			// Optional: Enter scopes
			const scopesInput = page.getByLabel(/scopes/i);
			if (await scopesInput.isVisible()) {
				await scopesInput.fill("read write");
			}

			// Save configuration first
			await page.getByRole("button", { name: /save|create/i }).click();

			// Wait for configuration to be saved
			await page.waitForTimeout(1000);

			// Wait for and click "Connect with OAuth" button
			const connectButton = page.getByRole("button", {
				name: /connect.*oauth/i,
			});

			// Set up listener for popup window
			const popupPromise = context.waitForEvent("page");

			await connectButton.click();

			// Get the popup window
			const popup = await popupPromise;

			// Wait for popup to load (OAuth authorization page)
			await popup.waitForLoadState("networkidle");

			// The popup should redirect to OAuth provider
			// In a real test, you would:
			// 1. Fill in OAuth provider credentials
			// 2. Authorize the app
			// 3. Wait for redirect back to callback
			// 4. Verify success message in parent window

			// For this test, we just verify the popup opened
			expect(popup.url()).toContain("oauth");

			// Close popup
			await popup.close();
		});

		test("should validate required fields", async ({ page }) => {
			const configureButton = page
				.locator('[data-testid="mcp-server-card"]')
				.first()
				.getByRole("button", { name: /configure/i });

			await configureButton.click();

			// Try to save without filling required fields
			await page.getByRole("button", { name: /save|create/i }).click();

			// Should show validation errors
			await expect(
				page.getByText(/base url.*required|please.*enter.*url/i),
			).toBeVisible();
		});

		test("should handle invalid URL format", async ({ page }) => {
			const configureButton = page
				.locator('[data-testid="mcp-server-card"]')
				.first()
				.getByRole("button", { name: /configure/i });

			await configureButton.click();

			// Enter invalid URL
			await page.getByLabel(/base url/i).fill("not-a-valid-url");

			// Try to save
			await page.getByRole("button", { name: /save|create/i }).click();

			// Should show validation error
			await expect(
				page.getByText(/invalid.*url|valid.*url.*required/i),
			).toBeVisible();
		});
	});

	test.describe("Test Connection", () => {
		test("should test connection for existing configuration", async ({
			page,
		}) => {
			// Find a configured server
			const configuredServer = page.locator(
				'[data-testid="mcp-config-tile"]',
			);

			// Skip if no configured servers
			if (!(await configuredServer.first().isVisible())) {
				test.skip();
				return;
			}

			// Click test connection button
			const testButton = configuredServer
				.first()
				.getByRole("button", { name: /test.*connection/i });

			await testButton.click();

			// Wait for test result
			// Success case
			const successToast = page.getByText(/connection.*success/i);
			// Or failure case
			const errorToast = page.getByText(/connection.*failed/i);

			// Either success or failure should appear
			await expect(successToast.or(errorToast)).toBeVisible({
				timeout: 10000,
			});
		});

		test("should show detailed server information on successful test", async ({
			page,
		}) => {
			// This test assumes a working MCP server is configured
			const configuredServer = page.locator(
				'[data-testid="mcp-config-tile"]',
			);

			if (!(await configuredServer.first().isVisible())) {
				test.skip();
				return;
			}

			const testButton = configuredServer
				.first()
				.getByRole("button", { name: /test.*connection/i });

			await testButton.click();

			// Look for detailed information in toast/modal
			// Should show: server name, version, protocol version, response time
			const detailsRegex = /server.*version|protocol|response.*time|ms/i;

			await expect(page.getByText(detailsRegex)).toBeVisible({
				timeout: 10000,
			});
		});
	});

	test.describe("Update MCP Configuration", () => {
		test("should update configuration base URL", async ({ page }) => {
			const configuredServer = page
				.locator('[data-testid="mcp-config-tile"]')
				.first();

			if (!(await configuredServer.isVisible())) {
				test.skip();
				return;
			}

			// Click edit/configure button
			const editButton = configuredServer.getByRole("button", {
				name: /edit|configure/i,
			});

			await editButton.click();

			// Update base URL
			const urlInput = page.getByLabel(/base url/i);
			await urlInput.clear();
			await urlInput.fill("https://updated-mcp.example.com");

			// Save changes
			await page.getByRole("button", { name: /save|update/i }).click();

			// Wait for success message
			await expect(page.getByText(/success|updated/i)).toBeVisible({
				timeout: 5000,
			});
		});

		test("should toggle configuration enabled/disabled state", async ({
			page,
		}) => {
			const configuredServer = page
				.locator('[data-testid="mcp-config-tile"]')
				.first();

			if (!(await configuredServer.isVisible())) {
				test.skip();
				return;
			}

			// Find the enable/disable toggle switch
			const toggleSwitch = configuredServer.getByRole("switch", {
				name: /enable|disable/i,
			});

			// Get current state
			const isChecked = await toggleSwitch.isChecked();

			// Toggle it
			await toggleSwitch.click();

			// Wait for state change
			await page.waitForTimeout(500);

			// Verify it changed
			await expect(toggleSwitch).toHaveAttribute(
				"aria-checked",
				isChecked ? "false" : "true",
			);
		});
	});

	test.describe("Delete MCP Configuration", () => {
		test("should delete configuration with confirmation", async ({
			page,
		}) => {
			const configuredServer = page
				.locator('[data-testid="mcp-config-tile"]')
				.first();

			if (!(await configuredServer.isVisible())) {
				test.skip();
				return;
			}

			// Get config name for verification
			const configName =
				(await configuredServer.textContent()) || "Test Config";

			// Click delete button
			const deleteButton = configuredServer.getByRole("button", {
				name: /delete|remove/i,
			});

			await deleteButton.click();

			// Confirm deletion in dialog
			const confirmButton = page.getByRole("button", {
				name: /confirm|yes|delete/i,
			});

			await confirmButton.click();

			// Wait for success message
			await expect(
				page.getByText(/success|deleted|removed/i),
			).toBeVisible({
				timeout: 5000,
			});

			// Verify configuration is no longer in list
			await expect(page.getByText(configName)).not.toBeVisible();
		});

		test("should cancel deletion when clicking cancel", async ({
			page,
		}) => {
			const configuredServer = page
				.locator('[data-testid="mcp-config-tile"]')
				.first();

			if (!(await configuredServer.isVisible())) {
				test.skip();
				return;
			}

			const configName =
				(await configuredServer.textContent()) || "Test Config";

			// Click delete button
			const deleteButton = configuredServer.getByRole("button", {
				name: /delete|remove/i,
			});

			await deleteButton.click();

			// Cancel deletion
			const cancelButton = page.getByRole("button", { name: /cancel/i });

			await cancelButton.click();

			// Verify configuration still exists
			await expect(page.getByText(configName)).toBeVisible();
		});
	});

	test.describe("OAuth Token Management", () => {
		test("should refresh expired OAuth token", async ({ page }) => {
			// Find OAuth config with expired token
			const oauthConfig = page
				.locator('[data-testid="mcp-config-tile"]')
				.filter({ hasText: /oauth|token.*expired/i })
				.first();

			if (!(await oauthConfig.isVisible())) {
				test.skip();
				return;
			}

			// Click refresh token button
			const refreshButton = oauthConfig.getByRole("button", {
				name: /refresh.*token/i,
			});

			await refreshButton.click();

			// Wait for success message
			await expect(
				page.getByText(/token.*refresh.*success/i),
			).toBeVisible({
				timeout: 10000,
			});
		});

		test("should show OAuth status (authenticated/expired)", async ({
			page,
		}) => {
			const oauthConfig = page
				.locator('[data-testid="mcp-config-tile"]')
				.filter({ hasText: /oauth/i })
				.first();

			if (!(await oauthConfig.isVisible())) {
				test.skip();
				return;
			}

			// Should display OAuth status badge
			const statusBadge = oauthConfig.locator(
				'[data-testid="oauth-status"]',
			);

			if (await statusBadge.isVisible()) {
				// Status should indicate: authenticated, expired, or disconnected
				const statusText = await statusBadge.textContent();
				expect(statusText).toMatch(/authenticated|expired|disconnect/i);
			}
		});
	});

	test.describe("Error Handling", () => {
		test("should handle network errors gracefully", async ({ page }) => {
			// Simulate offline mode
			await page.route("**/api/mcp/**", (route) => route.abort("failed"));

			const configureButton = page
				.locator('[data-testid="mcp-server-card"]')
				.first()
				.getByRole("button", { name: /configure/i });

			await configureButton.click();

			await page.getByLabel(/base url/i).fill("https://test.example.com");

			await page.getByRole("button", { name: /save/i }).click();

			// Should show error message
			await expect(
				page.getByText(/error|failed|something.*wrong/i),
			).toBeVisible({
				timeout: 5000,
			});
		});

		test("should handle server errors (500) gracefully", async ({
			page,
		}) => {
			// Mock server error
			await page.route("**/api/mcp/configs**", (route) =>
				route.fulfill({
					status: 500,
					body: JSON.stringify({ error: "Internal server error" }),
				}),
			);

			const configureButton = page
				.locator('[data-testid="mcp-server-card"]')
				.first()
				.getByRole("button", { name: /configure/i });

			await configureButton.click();

			await page.getByLabel(/base url/i).fill("https://test.example.com");

			await page.getByRole("button", { name: /save/i }).click();

			// Should show error message
			await expect(page.getByText(/error|failed/i)).toBeVisible({
				timeout: 5000,
			});
		});
	});

	test.describe("Organization-scoped MCP Configs", () => {
		test("should switch between user and organization scope", async ({
			page,
		}) => {
			// Look for scope selector (if user is in an organization)
			const scopeSelector = page.locator(
				'[data-testid="mcp-scope-selector"]',
			);

			if (!(await scopeSelector.isVisible())) {
				test.skip(); // User not in any organization
				return;
			}

			// Switch to organization scope
			await scopeSelector.click();
			await page.getByRole("option", { name: /organization/i }).click();

			// Verify organization configs are shown
			await expect(
				page.getByText(/organization.*configs|org.*servers/i),
			).toBeVisible();

			// Switch back to user scope
			await scopeSelector.click();
			await page.getByRole("option", { name: /personal|user/i }).click();

			// Verify user configs are shown
			await expect(
				page.getByText(/personal.*configs|my.*servers/i),
			).toBeVisible();
		});
	});
});
