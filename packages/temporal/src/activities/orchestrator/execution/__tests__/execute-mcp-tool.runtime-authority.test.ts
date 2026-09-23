/**
 * Runtime authority at the MCP chokepoint, for chat turns.
 *
 * The orchestrator's iterative loop ran generic MCP WRITE tools with no
 * authority check at all (Direct gated them). With `requestRuntimeAuthority`
 * the activity refuses an unauthorized write before it reaches the server,
 * raises a PENDING session bound to the conversation, and reports it in
 * `authorityRequired` so the workflow can ask the user. READ tools never
 * touch the authority tables. Without the flag nothing changes — that is the
 * path pre-patch workflow histories take.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	execute: vi.fn(async () => ({ ok: true })),
	ensureSensitiveOperationAuthority: vi.fn(),
	checkAuthority: vi.fn(),
	findConfig: vi.fn(),
	executeGitHubTool: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(async () => ({
		client: {
			tools: async () => ({
				"notion-create-pages": { execute: h.execute },
				"notion-search": { execute: h.execute },
			}),
		},
		serverName: "Notion",
		fromCache: true,
	})),
	invalidateMcpClientCache: vi.fn(),
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/utils", async () => {
	const actual = (await vi.importActual(
		"../../../../../../utils/lib/read-only-mode",
	)) as Record<string, unknown>;
	return {
		getBaseUrl: () => "http://localhost:3000",
		...actual,
	};
});
vi.mock("@repo/database", () => ({
	db: { mCPConfig: { findFirst: h.findConfig } },
	isProjectReadOnly: vi.fn(async () => false),
	checkAuthority: h.checkAuthority,
	ensureSensitiveOperationAuthority: h.ensureSensitiveOperationAuthority,
	resolveCanonicalProviderKey: (key: string) =>
		key.toLowerCase().replace(/_/g, "-"),
}));
vi.mock("@repo/integrations/github", () => ({
	executeGitHubTool: h.executeGitHubTool,
}));
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

const { executeMcpTool } = await import("../execute-mcp-tool");

const base = {
	args: {},
	userId: "u1",
	organizationId: "org-1",
	mcpConfigId: "cfg-notion",
	executionId: "orch-exec-1",
};

beforeEach(() => {
	h.execute.mockClear();
	h.executeGitHubTool.mockClear();
	h.ensureSensitiveOperationAuthority.mockReset();
	h.ensureSensitiveOperationAuthority.mockResolvedValue({
		authorized: false,
		reason: "No active authority grant",
		action: "request_authority",
		pendingSessionId: "sess-1",
	});
	h.checkAuthority.mockReset();
	h.findConfig.mockReset();
	h.findConfig.mockResolvedValue({
		displayName: "My Notion",
		mcpServer: { key: "notion", name: "Notion" },
	});
});

describe("executeMcpTool with requestRuntimeAuthority", () => {
	it("refuses an unauthorized WRITE and raises a session bound to the conversation", async () => {
		const res = await executeMcpTool({
			...base,
			toolName: "notion-create-pages",
			conversationId: "conv-1",
			requestRuntimeAuthority: true,
		});

		expect(h.execute).not.toHaveBeenCalled();
		expect(res.success).toBe(false);
		expect(res.authorityRequired).toEqual({
			pendingSessionId: "sess-1",
			providerKey: "notion",
			providerDisplayName: "Notion",
			accessLevel: "WRITE",
			toolName: "notion-create-pages",
		});
		expect(h.ensureSensitiveOperationAuthority).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "u1",
				organizationId: "org-1",
				providerKey: "notion",
				providerType: "MCP",
				providerRefId: "cfg-notion",
				accessLevel: "WRITE",
				runType: "ORCHESTRATOR",
				runId: "conv-1",
				toolName: "notion-create-pages",
			}),
		);
		// The config lookup is tenant-scoped (XOR, never OR).
		expect(h.findConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "cfg-notion",
					userId: "u1",
					organizationId: "org-1",
				},
			}),
		);
	});

	it("binds to the turn when there is no conversation", async () => {
		await executeMcpTool({
			...base,
			toolName: "notion-create-pages",
			requestRuntimeAuthority: true,
		});
		expect(h.ensureSensitiveOperationAuthority).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "orch-exec-1" }),
		);
	});

	it("runs an authorized WRITE", async () => {
		h.ensureSensitiveOperationAuthority.mockResolvedValue({
			authorized: true,
			grant: { id: "g1" },
		});
		const res = await executeMcpTool({
			...base,
			toolName: "notion-create-pages",
			conversationId: "conv-1",
			requestRuntimeAuthority: true,
		});
		expect(res.success).toBe(true);
		expect(res.authorityRequired).toBeUndefined();
		expect(h.execute).toHaveBeenCalledTimes(1);
	});

	it("never gates a READ tool", async () => {
		const res = await executeMcpTool({
			...base,
			toolName: "notion-search",
			conversationId: "conv-1",
			requestRuntimeAuthority: true,
		});
		expect(res.success).toBe(true);
		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
	});

	it("fails closed when the authority check throws", async () => {
		h.ensureSensitiveOperationAuthority.mockRejectedValue(
			new Error("db down"),
		);
		const res = await executeMcpTool({
			...base,
			toolName: "notion-create-pages",
			requestRuntimeAuthority: true,
		});
		expect(res.success).toBe(false);
		expect(h.execute).not.toHaveBeenCalled();
		expect((res.output as { error: string }).error).toContain(
			"Authority check failed",
		);
	});

	it("gates an OAuth-executor write (GitHub) the same way", async () => {
		const res = await executeMcpTool({
			...base,
			mcpConfigId: undefined,
			toolName: "GitHub__create_issue",
			conversationId: "conv-1",
			requestRuntimeAuthority: true,
		});
		expect(h.executeGitHubTool).not.toHaveBeenCalled();
		expect(res.authorityRequired).toMatchObject({
			pendingSessionId: "sess-1",
			providerKey: "github",
			providerDisplayName: "GitHub",
		});
		expect(h.ensureSensitiveOperationAuthority).toHaveBeenCalledWith(
			expect.objectContaining({
				providerType: "INTEGRATION",
				toolName: "create_issue",
				runId: "conv-1",
			}),
		);
	});

	it("lets an OAuth-executor read through", async () => {
		const res = await executeMcpTool({
			...base,
			mcpConfigId: undefined,
			toolName: "GitHub__list_issues",
			requestRuntimeAuthority: true,
		});
		expect(res.success).toBe(true);
		expect(h.executeGitHubTool).toHaveBeenCalledTimes(1);
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
	});
});

describe("executeMcpTool without requestRuntimeAuthority (pre-patch path)", () => {
	it("runs a WRITE without consulting authority, exactly as before", async () => {
		const res = await executeMcpTool({
			...base,
			toolName: "notion-create-pages",
		});
		expect(res.success).toBe(true);
		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
		expect(h.findConfig).not.toHaveBeenCalled();
	});

	it("does not gate OAuth-executor writes either", async () => {
		await executeMcpTool({
			...base,
			mcpConfigId: undefined,
			toolName: "GitHub__create_issue",
		});
		expect(h.executeGitHubTool).toHaveBeenCalledTimes(1);
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
	});
});
