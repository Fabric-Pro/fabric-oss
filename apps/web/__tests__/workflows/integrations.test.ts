/**
 * Integration tests for Workflow Integrations
 * Tests the plugin registry, credential fetching, and node execution
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock database
const mockDb = {
	workflowIntegration: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
	},
};

vi.mock("@repo/database", () => ({
	db: mockDb,
	fetchCredentialsByProvider: vi.fn(),
}));

// Mock encryption utilities. Avoid importOriginal — it loads the
// real @repo/utils which transitively can pull in modules that
// keep handles open and prevent vitest exit (vitest #4373).
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `encrypted_${value}`,
	decryptApiKey: (value: string) => value.replace("encrypted_", ""),
	hashApiKey: (value: string) => `hash_${value}`,
	// Pass-through normalizers / common util shapes — extend as needed.
	getBaseUrl: () => "http://localhost:3001",
	normalizeUrl: (raw: string | null) => raw ?? undefined,
	COMMON_URL_FIELDS: ["url", "link", "webUrl", "web_url", "html_url"],
}));

describe("Workflow Integration Plugin Registry", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	function getCredentialMapperOrThrow(
		getCredentialMapping: (
			plugin: NonNullable<
				ReturnType<
					typeof import("../../modules/saas/workflows/lib/plugins")["getIntegration"]
				>
			>,
		) => (config: Record<string, unknown>) => Record<string, string>,
		plugin: ReturnType<
			typeof import("../../modules/saas/workflows/lib/plugins")["getIntegration"]
		>,
	) {
		expect(plugin).toBeDefined();
		if (!plugin) {
			throw new Error("Expected integration plugin to be defined");
		}

		return getCredentialMapping(plugin);
	}

	describe("Plugin Registration", () => {
		it("should register Linear plugin correctly", async () => {
			const { getIntegration, hasIntegration } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			expect(hasIntegration("LINEAR")).toBe(true);

			const linearPlugin = getIntegration("LINEAR");
			expect(linearPlugin).toBeDefined();
			expect(linearPlugin?.label).toBe("Linear");
			expect(linearPlugin?.type).toBe("LINEAR");
			expect(linearPlugin?.actions.length).toBe(2);
		});

		it("should register Slack plugin correctly", async () => {
			const { getIntegration, hasIntegration } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			expect(hasIntegration("SLACK")).toBe(true);

			const slackPlugin = getIntegration("SLACK");
			expect(slackPlugin).toBeDefined();
			expect(slackPlugin?.label).toBe("Slack");
			expect(slackPlugin?.actions.length).toBe(1);
			expect(slackPlugin?.actions[0].slug).toBe("send-message");
		});

		it("should register Resend plugin correctly", async () => {
			const { getIntegration, hasIntegration } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			expect(hasIntegration("RESEND")).toBe(true);

			const resendPlugin = getIntegration("RESEND");
			expect(resendPlugin).toBeDefined();
			expect(resendPlugin?.label).toBe("Resend");
			expect(resendPlugin?.actions[0].slug).toBe("send-email");
		});

		it("should register MCP plugin correctly", async () => {
			const { getIntegration, hasIntegration } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			expect(hasIntegration("MCP")).toBe(true);

			const mcpPlugin = getIntegration("MCP");
			expect(mcpPlugin).toBeDefined();
			expect(mcpPlugin?.label).toBe("MCP Tools");
		});
	});

	describe("Plugin Queries", () => {
		it("should get all integrations", async () => {
			const { getAllIntegrations } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const integrations = getAllIntegrations();
			expect(integrations.length).toBeGreaterThanOrEqual(4);
			expect(integrations.some((i) => i.type === "LINEAR")).toBe(true);
			expect(integrations.some((i) => i.type === "SLACK")).toBe(true);
			expect(integrations.some((i) => i.type === "RESEND")).toBe(true);
			expect(integrations.some((i) => i.type === "MCP")).toBe(true);
		});

		it("should get all actions", async () => {
			const { getAllActions } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const actions = getAllActions();
			expect(actions.length).toBeGreaterThanOrEqual(5);

			// Node type defaults to "<integration-type>-<slug>".
			expect(
				actions.some((a) => a.nodeType === "linear-create-ticket"),
			).toBe(true);
			expect(
				actions.some((a) => a.nodeType === "linear-find-issues"),
			).toBe(true);

			// Slack, Resend and MCP predate that convention and pin their node
			// type explicitly. This test previously asserted the DERIVED names
			// (slack-send-message, resend-send-email, mcp-execute-tool), which
			// are not what the executor is keyed by, nor what saved workflows
			// contain — it was codifying a registry/runtime disagreement.
			expect(actions.some((a) => a.nodeType === "slack-send")).toBe(true);
			expect(actions.some((a) => a.nodeType === "email-send")).toBe(true);
			expect(actions.some((a) => a.nodeType === "mcp-tool")).toBe(true);
		});

		it("should get actions by category", async () => {
			const { getActionsByCategory } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const categories = getActionsByCategory();

			// Categories are defined by the plugin actions (e.g., "Productivity", "Communication", "AI")
			expect(categories.Productivity).toBeDefined();
			expect(categories.Communication).toBeDefined();

			// Linear should be in Productivity
			expect(
				categories.Productivity.some(
					(a) => a.nodeType === "linear-create-ticket",
				),
			).toBe(true);

			// Slack and Resend should be in Communication
			expect(
				categories.Communication.some(
					(a) => a.nodeType === "slack-send",
				),
			).toBe(true);
			expect(
				categories.Communication.some(
					(a) => a.nodeType === "email-send",
				),
			).toBe(true);
		});

		it("should find action by ID", async () => {
			const { findActionById } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const linearAction = findActionById("linear-create-ticket");
			expect(linearAction).toBeDefined();
			expect(linearAction?.label).toBe("Create Linear Ticket");
			expect(linearAction?.integrationType).toBe("LINEAR");

			const nonExistent = findActionById("non-existent-action");
			expect(nonExistent).toBeUndefined();
		});
	});

	describe("Credential Mapping", () => {
		it("should map Linear credentials correctly", async () => {
			const { getIntegration, getCredentialMapping } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const linearPlugin = getIntegration("LINEAR");
			const credentialMapper = getCredentialMapperOrThrow(
				getCredentialMapping,
				linearPlugin,
			);
			const mapped = credentialMapper({
				apiKey: "lin_api_test123",
				teamId: "team-123",
			});

			expect(mapped).toEqual({
				LINEAR_API_KEY: "lin_api_test123",
				LINEAR_TEAM_ID: "team-123",
			});
		});

		it("should have empty credential mapping for OAuth-based Slack", async () => {
			const { getIntegration, getCredentialMapping } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const slackPlugin = getIntegration("SLACK");
			// Slack uses OAuth - credentials are fetched via fetchCredentialsByProvider
			// (SLACK_TOKEN from credential-fetcher.ts), not via formFields mapping
			const credentialMapper = getCredentialMapperOrThrow(
				getCredentialMapping,
				slackPlugin,
			);
			const mapped = credentialMapper({});

			expect(mapped).toEqual({});
		});

		it("should map Resend credentials correctly", async () => {
			const { getIntegration, getCredentialMapping } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const resendPlugin = getIntegration("RESEND");
			const credentialMapper = getCredentialMapperOrThrow(
				getCredentialMapping,
				resendPlugin,
			);
			const mapped = credentialMapper({
				apiKey: "re_test123",
				fromEmail: "noreply@example.com",
			});

			expect(mapped).toEqual({
				RESEND_API_KEY: "re_test123",
				RESEND_FROM_EMAIL: "noreply@example.com",
			});
		});

		it("should handle empty config gracefully", async () => {
			const { getIntegration, getCredentialMapping } = await import(
				"../../modules/saas/workflows/lib/plugins"
			);

			const linearPlugin = getIntegration("LINEAR");
			const credentialMapper = getCredentialMapperOrThrow(
				getCredentialMapping,
				linearPlugin,
			);
			const mapped = credentialMapper({});

			expect(mapped).toEqual({
				LINEAR_API_KEY: "",
				LINEAR_TEAM_ID: "",
			});
		});
	});
});

describe("Workflow Integration Settings Components", () => {
	it("should have formFields for Linear plugin", async () => {
		const { linearPlugin } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		expect(linearPlugin.formFields).toBeDefined();
		expect(linearPlugin.formFields.length).toBeGreaterThan(0);
	});

	it("should have empty formFields for OAuth-based Slack plugin", async () => {
		const { slackPlugin } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		// Slack uses OAuth - no form fields needed (credentials via OAuth flow)
		expect(slackPlugin.formFields).toBeDefined();
		expect(slackPlugin.formFields.length).toBe(0);
	});

	it("should have formFields for Resend plugin", async () => {
		const { resendPlugin } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		expect(resendPlugin.formFields).toBeDefined();
		expect(resendPlugin.formFields.length).toBeGreaterThan(0);
	});

	it("should have correct form fields for Linear", async () => {
		const { linearPlugin } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		expect(linearPlugin.formFields.length).toBe(2);
		expect(linearPlugin.formFields[0].id).toBe("apiKey");
		expect(linearPlugin.formFields[0].type).toBe("password");
		expect(linearPlugin.formFields[1].id).toBe("teamId");
	});

	it("should have correct form fields for Resend", async () => {
		const { resendPlugin } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		expect(resendPlugin.formFields.length).toBe(2);
		expect(resendPlugin.formFields[0].id).toBe("apiKey");
		expect(resendPlugin.formFields[1].id).toBe("fromEmail");
		expect(resendPlugin.formFields[1].type).toBe("email");
	});
});

describe("Workflow Integration Test Connection", () => {
	// Note: Test connections are now handled server-side via the API procedure
	// at packages/api/modules/workflows/procedures/integrations/test-connection.ts
	// These tests verify the plugins don't have client-side testConnection functions

	it("should not have client-side testConnection on plugins (moved to server-side)", async () => {
		const { linearPlugin, slackPlugin, resendPlugin, mcpPlugin } =
			await import("../../modules/saas/workflows/lib/plugins");

		// Client-side testConnection functions have been removed to avoid CORS issues
		// All test connections are now handled via the server-side API
		expect(linearPlugin.testConnection).toBeUndefined();
		expect(slackPlugin.testConnection).toBeUndefined();
		expect(resendPlugin.testConnection).toBeUndefined();
		expect(mcpPlugin.testConnection).toBeUndefined();
	});
});

describe("Node Definition Integration", () => {
	it("should have node definitions for core integration types", async () => {
		const { nodeDefinitions } = await import(
			"../../modules/saas/workflows/lib/node-definitions"
		);

		const nodeTypes = nodeDefinitions.map((n) => n.type);

		// Verify core node types exist in node definitions
		// Note: plugin-generated nodeTypes may use different naming conventions
		expect(nodeTypes).toContain("linear-create-ticket");
		expect(nodeTypes).toContain("linear-find-issues");
		expect(nodeTypes).toContain("slack-send");
		expect(nodeTypes).toContain("email-send");
		expect(nodeTypes).toContain("mcp-tool");
		expect(nodeTypes).toContain("ai-generate-text");
		expect(nodeTypes).toContain("firecrawl-scrape");
		expect(nodeTypes).toContain("github-create-issue");
	});

	it("should have correct config fields for Linear create ticket", async () => {
		const { findActionById } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		// Config fields live on the plugin action, not on the palette entry.
		// The palette is derived and carries display metadata only; the config
		// UI renders from the action's own declaration via ActionConfigPanel.
		// Keeping a second copy on the node definition is what drifted.
		const action = findActionById("linear-create-ticket");

		expect(action).toBeDefined();
		const keys = action?.configFields?.map((f) => f.key) ?? [];
		expect(keys).toEqual(
			expect.arrayContaining([
				"ticketTitle",
				"ticketDescription",
				"priority",
			]),
		);
	});

	it("should have correct config fields for Slack send", async () => {
		const { findActionById } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		const action = findActionById("slack-send");

		expect(action).toBeDefined();
		const keys = action?.configFields?.map((f) => f.key) ?? [];
		expect(keys).toEqual(
			expect.arrayContaining(["slackChannel", "slackMessage"]),
		);
	});

	it("should have correct config fields for Email send", async () => {
		const { findActionById } = await import(
			"../../modules/saas/workflows/lib/plugins"
		);

		const action = findActionById("email-send");

		expect(action).toBeDefined();
		const keys = action?.configFields?.map((f) => f.key) ?? [];
		expect(keys).toEqual(expect.arrayContaining(["to", "subject", "body"]));
	});
});
