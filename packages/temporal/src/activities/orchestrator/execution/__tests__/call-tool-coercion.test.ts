import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	execute: vi.fn(async () => ({
		content: [{ type: "text", text: "Example records" }],
	})),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(async () => ({
		client: {
			tools: async () => ({
				example_read: {
					execute: h.execute,
					inputSchema: {
						jsonSchema: {
							type: "object",
							properties: { limit: { type: "number" } },
						},
					},
				},
			}),
		},
		serverName: "Example",
		fromCache: true,
	})),
	invalidateMcpClientCache: vi.fn(),
	isClosedClientRefusedBeforeSend: () => false,
	McpGitLabOriginMismatchError: class extends Error {},
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "http://localhost:3000" }));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/integrations/github", () => ({ executeGitHubTool: vi.fn() }));
vi.mock("@repo/integrations/slack", () => ({ executeSlackTool: vi.fn() }));
vi.mock("../../../letta-memory-activities", () => ({
	cacheToolResult: vi.fn(),
	getCachedToolResult: vi.fn(async () => ({ found: false })),
}));
vi.mock("../../../shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));
vi.mock("../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

import {
	normalizedEntry,
	unwrapCall,
} from "../../../../workflows/orchestrator/advisor-call-tool";

it("passes coercible wrapper arguments through the existing executor normalization", async () => {
	const entry = normalizedEntry(
		"example_read",
		{
			description: "Read",
			inputSchema: {
				type: "object",
				properties: { limit: { type: "number" } },
			},
		},
		{ kind: "config", configId: "config-example" },
		"search",
		1,
	);
	const result = unwrapCall(
		{
			id: "example-call",
			args: { name: "example_read", arguments: '{"limit":"100"}' },
		},
		new Map([["example_read", entry]]),
		new Set(),
	);
	expect(result).toHaveProperty("call");
	if (!("call" in result)) {
		throw new Error("Wrapper refused");
	}
	const { executeMcpTool } = await import("../execute-mcp-tool");
	const output = await executeMcpTool({
		toolName: result.call.name,
		args: result.call.args,
		userId: "example-user",
		organizationId: "example-org",
		mcpConfigId: "config-example",
	});
	expect(output.success).toBe(true);
	expect(h.execute).toHaveBeenCalledWith({ limit: 100 }, expect.anything());
});
