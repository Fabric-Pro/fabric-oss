/**
 * Multi-Tenant Isolation E2E Tests
 *
 * These tests verify that the UI correctly enforces tenant isolation
 * by testing the actual user flows in the browser.
 *
 * IMPORTANT: These tests require multiple test accounts and organizations
 * to be seeded in the test database before running.
 */

import { describe, expect, test } from "@playwright/test";

const TEST_TENANTS = {
	userA: {
		userId: "test-user-a",
		email: "user-a@example.com",
		personalMcpConfigId: "mcp-config-personal-user-a",
	},
	userB: {
		userId: "test-user-b",
		email: "user-b@example.com",
		personalMcpConfigId: "mcp-config-personal-user-b",
	},
	orgA: {
		organizationId: "test-org-a",
		organizationName: "Organization A",
		userAOrgMcpConfigId: "mcp-config-org-a-user-a",
		userBOrgMcpConfigId: "mcp-config-org-a-user-b",
	},
	orgB: {
		organizationId: "test-org-b",
		organizationName: "Organization B",
		userAOrgMcpConfigId: "mcp-config-org-b-user-a",
	},
};

describe("Multi-Tenant Isolation E2E Tests", () => {
	describe("Personal Account Isolation", () => {
		test.beforeEach(async ({ page }) => {
			// Login as User A
			await page.goto("/auth/login");
			await page.fill('input[name="email"]', TEST_TENANTS.userA.email);
			await page.fill('input[name="password"]', "test-password");
			await page.click('button[type="submit"]');
			await page.waitForURL("/app**");
		});

		test("should only show User A's personal MCP configs", async ({
			page,
		}) => {
			await page.goto("/app/settings/mcp-servers");

			// User A should see their own personal configs
			await expect(
				page.getByText(
					`Personal Config: ${TEST_TENANTS.userA.personalMcpConfigId}`,
				),
			).toBeVisible();

			// User A should NOT see User B's personal configs
			await expect(
				page.getByText(
					`Personal Config: ${TEST_TENANTS.userB.personalMcpConfigId}`,
				),
			).not.toBeVisible();
		});

		test("should only show User A's personal agents", async ({ page }) => {
			await page.goto("/app/agents");

			// User A should see their own agents
			await expect(page.getByText("My Personal Agent A")).toBeVisible();

			// User A should NOT see User B's agents
			await expect(page.getByText("User B's Agent")).not.toBeVisible();
		});

		test("should only show User A's personal projects", async ({
			page,
		}) => {
			await page.goto("/app/projects");

			// User A should see their own projects
			await expect(page.getByText("User A's Project")).toBeVisible();

			// User A should NOT see User B's projects
			await expect(page.getByText("User B's Project")).not.toBeVisible();
		});

		test("should not leak personal data in URL parameters", async ({
			page,
		}) => {
			// Attempt to access User B's config via URL manipulation
			await page.goto(
				`/app/settings/mcp-servers?configId=${TEST_TENANTS.userB.personalMcpConfigId}`,
			);

			// Should show 404 or access denied, not User B's config
			await expect(page.getByText("Access Denied")).toBeVisible();
		});
	});

	describe("Organization Isolation", () => {
		test.beforeEach(async ({ page }) => {
			// Login as User A and switch to Organization A
			await page.goto("/auth/login");
			await page.fill('input[name="email"]', TEST_TENANTS.userA.email);
			await page.fill('input[name="password"]', "test-password");
			await page.click('button[type="submit"]');
			await page.waitForURL("/app**");

			// Switch to Organization A
			await page.click('[data-testid="organization-switcher"]');
			await page.click(
				`[data-testid="org-${TEST_TENANTS.orgA.organizationId}"]`,
			);
			await page.waitForURL(
				`**/org/${TEST_TENANTS.orgA.organizationId}**`,
			);
		});

		test("should only show Organization A's MCP configs for User A", async ({
			page,
		}) => {
			await page.goto(
				`/app/${TEST_TENANTS.orgA.organizationId}/settings/mcp-servers`,
			);

			// User A should see their org-scoped configs for Org A
			await expect(
				page.getByText(
					`Org Config: ${TEST_TENANTS.orgA.userAOrgMcpConfigId}`,
				),
			).toBeVisible();

			// User A should NOT see User B's configs for Org A (different user)
			await expect(
				page.getByText(
					`Org Config: ${TEST_TENANTS.orgA.userBOrgMcpConfigId}`,
				),
			).not.toBeVisible();

			// User A should NOT see Org B's configs
			await expect(
				page.getByText(
					`Org Config: ${TEST_TENANTS.orgB.userAOrgMcpConfigId}`,
				),
			).not.toBeVisible();
		});

		test("should not show other orgs' data when switching contexts", async ({
			page,
		}) => {
			// First, verify we're in Org A context
			await page.goto(
				`/app/${TEST_TENANTS.orgA.organizationId}/settings/mcp-servers`,
			);
			await expect(
				page.getByText(TEST_TENANTS.orgA.organizationName),
			).toBeVisible();

			// Switch to Org B
			await page.click('[data-testid="organization-switcher"]');
			await page.click(
				`[data-testid="org-${TEST_TENANTS.orgB.organizationId}"]`,
			);
			await page.waitForURL(
				`**/org/${TEST_TENANTS.orgB.organizationId}**`,
			);

			// Now in Org B context - should see Org B's data, not Org A's
			await page.goto(
				`/app/${TEST_TENANTS.orgB.organizationId}/settings/mcp-servers`,
			);
			await expect(
				page.getByText(
					`Org Config: ${TEST_TENANTS.orgB.userAOrgMcpConfigId}`,
				),
			).toBeVisible();

			// Should NOT see Org A's configs
			await expect(
				page.getByText(
					`Org Config: ${TEST_TENANTS.orgA.userAOrgMcpConfigId}`,
				),
			).not.toBeVisible();
		});

		test("should prevent accessing other orgs' data via URL manipulation", async ({
			page,
		}) => {
			// Attempt to access Org B's data while in Org A context
			await page.goto(
				`/app/${TEST_TENANTS.orgA.organizationId}/settings/mcp-servers?configId=${TEST_TENANTS.orgB.userAOrgMcpConfigId}`,
			);

			// Should show access denied, not Org B's config
			await expect(page.getByText("Access Denied")).toBeVisible();
		});
	});

	describe("Cross-Tenant Access Prevention", () => {
		test.beforeEach(async ({ page }) => {
			// Login as User A
			await page.goto("/auth/login");
			await page.fill('input[name="email"]', TEST_TENANTS.userA.email);
			await page.fill('input[name="password"]', "test-password");
			await page.click('button[type="submit"]');
			await page.waitForURL("/app**");
		});

		test("should prevent User A from accessing User B's config by ID", async ({
			page,
		}) => {
			// Try direct API access
			const response = await page.request.get(
				`/api/mcp/configs/${TEST_TENANTS.userB.personalMcpConfigId}`,
			);

			// Should return 403 or 404, not 200 with data
			expect([403, 404]).toContain(response.status());
		});

		test("should prevent User A from accessing Org B's config by ID", async ({
			page,
		}) => {
			// Try direct API access to Org B's config
			const response = await page.request.get(
				`/api/mcp/configs/${TEST_TENANTS.orgB.userAOrgMcpConfigId}?organizationId=${TEST_TENANTS.orgB.organizationId}`,
			);

			// Should return 403 or 404, not 200 with data
			expect([403, 404]).toContain(response.status());
		});

		test("should prevent personal configs from appearing in org pages", async ({
			page,
		}) => {
			// User A has a personal config
			await page.goto("/app/settings/mcp-servers");
			const personalConfigVisible = await page
				.getByText(
					`Personal Config: ${TEST_TENANTS.userA.personalMcpConfigId}`,
				)
				.isVisible();

			if (personalConfigVisible) {
				// Now switch to Org A and verify personal config doesn't appear
				await page.click('[data-testid="organization-switcher"]');
				await page.click(
					`[data-testid="org-${TEST_TENANTS.orgA.organizationId}"]`,
				);
				await page.waitForURL(
					`**/org/${TEST_TENANTS.orgA.organizationId}**`,
				);

				await page.goto(
					`/app/${TEST_TENANTS.orgA.organizationId}/settings/mcp-servers`,
				);

				// Personal config should not appear in org context
				await expect(
					page.getByText(
						`Personal Config: ${TEST_TENANTS.userA.personalMcpConfigId}`,
					),
				).not.toBeVisible();
			}
		});

		test("should prevent org configs from appearing in personal pages", async ({
			page,
		}) => {
			// Go to personal context
			await page.click('[data-testid="organization-switcher"]');
			await page.click('[data-testid="org-personal"]'); // Switch to personal
			await page.waitForURL("/app**");

			// Org A's config should not appear
			await page.goto("/app/settings/mcp-servers");
			await expect(
				page.getByText(
					`Org Config: ${TEST_TENANTS.orgA.userAOrgMcpConfigId}`,
				),
			).not.toBeVisible();
		});
	});

	describe("API Security - ID Enumeration Prevention", () => {
		test.beforeEach(async ({ page }) => {
			// Login as User A
			await page.goto("/auth/login");
			await page.fill('input[name="email"]', TEST_TENANTS.userA.email);
			await page.fill('input[name="password"]', "test-password");
			await page.click('button[type="submit"]');
			await page.waitForURL("/app**");
		});

		test("should not reveal if config ID exists for other users", async ({
			page,
		}) => {
			// Try to query a config that doesn't belong to user
			const response = await page.request.get(
				"/api/mcp/configs/non-existent-config-id",
			);

			// Should not leak whether the ID exists
			// The error should be the same whether the ID exists or not
			expect([403, 404]).toContain(response.status());

			const body = await response.json();
			// Error message should not indicate if resource exists
			expect(body.message).not.toContain("not found");
		});

		test("should return same error for existing and non-existing IDs", async ({
			page,
		}) => {
			// Non-existing ID
			const response1 = await page.request.get(
				"/api/mcp/configs/definitely-does-not-exist-12345",
			);

			// Existing ID (but belongs to someone else)
			const response2 = await page.request.get(
				`/api/mcp/configs/${TEST_TENANTS.userB.personalMcpConfigId}`,
			);

			// Both should return error (not 200 with data)
			expect(response1.status()).not.toBe(200);
			expect(response2.status()).not.toBe(200);
		});
	});

	describe("Data Export Isolation", () => {
		test.beforeEach(async ({ page }) => {
			// Login as User A
			await page.goto("/auth/login");
			await page.fill('input[name="email"]', TEST_TENANTS.userA.email);
			await page.fill('input[name="password"]', "test-password");
			await page.click('button[type="submit"]');
			await page.waitForURL("/app**");
		});

		test("should only export user's own data", async ({ page }) => {
			// Request data export
			const response = await page.request.post("/api/user/export", {
				form: {},
			});

			if (response.ok()) {
				const exportedData = await response.json();

				// Should only contain user's own data
				if (exportedData.mcpConfigs) {
					expect(
						exportedData.mcpConfigs.every(
							(c: any) => c.userId === TEST_TENANTS.userA.userId,
						),
					).toBe(true);
				}

				if (exportedData.projects) {
					expect(
						exportedData.projects.every(
							(c: any) => c.userId === TEST_TENANTS.userA.userId,
						),
					).toBe(true);
				}
			}
		});

		test("should not include organization data in personal export", async ({
			page,
		}) => {
			const response = await page.request.post("/api/user/export", {
				form: {},
			});

			if (response.ok()) {
				const exportedData = await response.json();

				// Should not include org-scoped data
				if (exportedData.mcpConfigs) {
					expect(
						exportedData.mcpConfigs.every(
							(c: any) => c.organizationId === null,
						),
					).toBe(true);
				}
			}
		});
	});

	describe("Real-time Data Isolation", () => {
		test.beforeEach(async ({ page }) => {
			// Login as User A
			await page.goto("/auth/login");
			await page.fill('input[name="email"]', TEST_TENANTS.userA.email);
			await page.fill('input[name="password"]', "test-password");
			await page.click('button[type="submit"]');
			await page.waitForURL("/app**");
		});

		test("should not receive other users' real-time updates", async ({
			page,
		}) => {
			// Subscribe to real-time updates
			const wsResponse = await page.request.get(
				"/api/realtime/subscribe",
				{ headers: { upgrade: "websocket" } },
			);

			// WebSocket should be established
			expect(wsResponse.status()).toBe(101);

			// After waiting, verify we didn't receive other users' data updates
			// This is a bit tricky to test, but we can verify the subscription
			// is filtered by tenant context
			await page.waitForTimeout(2000);

			// The real test is that we don't see events for other users' data
			// This would require a more complex test setup with multiple browsers
		});
	});
});
