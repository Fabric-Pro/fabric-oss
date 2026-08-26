import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	execute: vi.fn(() => new Promise(() => {})), // never settles by default
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(async () => ({
		client: {
			tools: async () => ({ fizzy_get_card: { execute: h.execute } }),
		},
		serverName: "Fizzy",
		fromCache: true,
	})),
	invalidateMcpClientCache: vi.fn(),
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

describe("executeMcpTool timeoutMs", () => {
	afterEach(() => {
		vi.useRealTimers();
		h.execute.mockReset();
		h.execute.mockImplementation(() => new Promise(() => {}));
	});

	it("times out a hung MCP call and clears the heartbeat interval (no leak)", async () => {
		vi.useFakeTimers();
		const { executeMcpTool } = await import("../execute-mcp-tool");
		const promise = executeMcpTool({
			toolName: "fizzy_get_card",
			args: { card_number: 1 },
			userId: "u1",
			mcpConfigId: "cfg1",
			timeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000);
		const res = await promise;
		expect(res.success).toBe(false);
		expect(String((res.output as { error?: string }).error)).toMatch(
			/timed out/i,
		);
		expect(vi.getTimerCount()).toBe(0); // heartbeat interval + race timer both cleared
	});

	it("aborts the underlying tool.execute on timeout (finding 8)", async () => {
		vi.useFakeTimers();
		let captured: AbortSignal | undefined;
		h.execute.mockImplementation((...callArgs: unknown[]) => {
			captured = (
				callArgs[1] as { abortSignal?: AbortSignal } | undefined
			)?.abortSignal;
			return new Promise(() => {}); // never settles
		});
		const { executeMcpTool } = await import("../execute-mcp-tool");
		const promise = executeMcpTool({
			toolName: "fizzy_get_card",
			args: { card_number: 1 },
			userId: "u1",
			mcpConfigId: "cfg1",
			timeoutMs: 20_000,
		});
		await vi.advanceTimersByTimeAsync(20_000);
		await promise;
		expect(captured?.aborted).toBe(true);
	});

	it("is unchanged when no timeoutMs is set (default path)", async () => {
		h.execute.mockResolvedValueOnce({
			content: [
				{
					type: "text",
					text: JSON.stringify({ card_number: 1, title: "X" }),
				},
			],
		});
		const { executeMcpTool } = await import("../execute-mcp-tool");
		const res = await executeMcpTool({
			toolName: "fizzy_get_card",
			args: { card_number: 1 },
			userId: "u1",
			mcpConfigId: "cfg1",
		});
		expect(res.success).toBe(true);
	});
});
