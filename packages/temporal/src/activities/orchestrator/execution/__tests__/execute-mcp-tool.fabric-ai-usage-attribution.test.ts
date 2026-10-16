/**
 * executeMcpTool — usage attribution of the Fabric AI tools.
 *
 * An Advisor round's `fabric_pattern`, `fabric_search_and_analyze` and
 * `fabric_scrape_and_analyze` calls run a model in the Fabric AI activities;
 * the call's conversation goes with them so the usage row records the chat.
 * A call with no conversation passes none, and never the execution ID.
 *
 * Mock set copied from `execute-mcp-tool.turn-fabric-ai.test.ts`, with the
 * Fabric AI activities replaced at their module boundary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	fabricAi: {
		searchAndAnalyzeActivity: vi.fn(),
		scrapeAndAnalyzeActivity: vi.fn(),
		executeFabricPattern: vi.fn(),
	},
	getCachedMcpClientForConfig: vi.fn(async () => {
		throw new Error("MCP configuration not found");
	}),
	runFabricCatalogTool: vi.fn(),
	ensureSensitiveOperationAuthority: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	generateImageActivity: vi.fn(),
	checkDispatchable: vi.fn(),
	// Rows exist for org-1 only: a lookup that drops the organization finds
	// no provider and the tool would go to the Fabric AI server instead.
	getMergedSearchProviderConfigs: vi.fn(
		async (args: { userId: string; organizationId?: string | null }) =>
			args.organizationId === "org-1"
				? [
						{
							providerName: "jina",
							encryptedApiKey: "jina-key",
							endpoint: null,
							enabled: true,
							isDefault: true,
							priority: 0,
							source: "organization",
						},
					]
				: [],
	),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: h.getCachedMcpClientForConfig,
	invalidateMcpClientCache: vi.fn(),
	McpGitLabOriginMismatchError: class extends Error {},
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/utils", async () => {
	const actual = (await vi.importActual(
		"../../../../../../utils/lib/read-only-mode",
	)) as Record<string, unknown>;
	return {
		getBaseUrl: () => "http://localhost:3000",
		decryptApiKey: (value: string) => `decrypted-${value}`,
		...actual,
	};
});
vi.mock("@repo/database", () => ({
	db: { mCPConfig: { findMany: vi.fn(async () => []) } },
	isProjectReadOnly: h.isProjectReadOnly,
	checkAuthority: vi.fn(),
	ensureSensitiveOperationAuthority: h.ensureSensitiveOperationAuthority,
	resolveCanonicalProviderKey: (key: string) => key.toLowerCase(),
	checkConversationTurnDispatchable: h.checkDispatchable,
	getMergedSearchProviderConfigs: h.getMergedSearchProviderConfigs,
	getSearchProviderConfig: vi.fn(async () => null),
	logAiUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: vi.fn(async () => "example-ai-token"),
}));
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_provider: string,
		_operation: string,
		fn: () => Promise<unknown>,
	) => fn(),
}));
vi.mock("@repo/integrations/github", () => ({ executeGitHubTool: vi.fn() }));
vi.mock("@repo/integrations/slack", () => ({ executeSlackTool: vi.fn() }));
vi.mock("../../../letta-memory-activities", () => ({
	cacheToolResult: vi.fn(),
	getCachedToolResult: vi.fn(async () => ({ found: false })),
}));
vi.mock("../../../shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(async () => ({ frameId: "f1" })),
	getFirstClassFrame: vi.fn(async () => ({ frameId: "f1" })),
	listFirstClassFrames: vi.fn(async () => ({ frames: [] })),
	shareFirstClassFrame: vi.fn(async () => ({ frameId: "f1" })),
	updateFirstClassFrame: vi.fn(async () => ({ frameId: "f1" })),
}));
vi.mock("../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

vi.mock("../../../image-generation", () => ({
	generateImageActivity: h.generateImageActivity,
}));
vi.mock("../fabric-catalog-adapter", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fabric-catalog-adapter")>()),
	runFabricCatalogTool: h.runFabricCatalogTool,
}));

vi.mock("../../../fabric-ai", () => h.fabricAi);

const { executeMcpTool } = await import("../execute-mcp-tool");

const TOOLS: Array<[string, keyof typeof h.fabricAi, Record<string, unknown>]> =
	[
		["fabric_pattern", "executeFabricPattern", { input: "text" }],
		[
			"fabric_search_and_analyze",
			"searchAndAnalyzeActivity",
			{ query: "q" },
		],
		[
			"fabric_scrape_and_analyze",
			"scrapeAndAnalyzeActivity",
			{ url: "https://example.com" },
		],
	];

beforeEach(() => {
	for (const fn of Object.values(h.fabricAi)) {
		fn.mockReset();
		fn.mockResolvedValue({ success: true, output: "o", analysis: "a" });
	}
});

describe("executeMcpTool — Fabric AI usage attribution", () => {
	for (const [toolName, activity, args] of TOOLS) {
		it(`${toolName} passes the call's conversation to ${activity}`, async () => {
			await executeMcpTool({
				toolName,
				args,
				userId: "u1",
				organizationId: "org-1",
				mcpConfigId: "fabric-ai-server",
				executionId: "exec-1",
				conversationId: "conv-1",
			});

			expect(h.fabricAi[activity]).toHaveBeenCalledTimes(1);
			expect(h.fabricAi[activity].mock.calls[0][0]).toMatchObject({
				userId: "u1",
				organizationId: "org-1",
				conversationId: "conv-1",
			});
		});

		it(`${toolName} passes no conversation without one, never the execution ID`, async () => {
			await executeMcpTool({
				toolName,
				args,
				userId: "u1",
				organizationId: "org-1",
				mcpConfigId: "fabric-ai-server",
				executionId: "exec-1",
			});

			const request = h.fabricAi[activity].mock.calls[0][0];
			expect(request).not.toHaveProperty("conversationId");
			expect(JSON.stringify(request)).not.toContain("exec-1");
		});
	}
});
