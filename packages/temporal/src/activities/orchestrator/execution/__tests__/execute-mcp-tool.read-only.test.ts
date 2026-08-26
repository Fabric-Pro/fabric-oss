/**
 * Read-only mode write-gate at the universal MCP chokepoint.
 *
 * executeMcpToolImpl is the final dispatch point for MCP tool calls (and the
 * Teams/GitHub/Slack executor routes), so the gate here is what blocks writes
 * that were already queued or in-flight when the mode was enabled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	execute: vi.fn(async () => ({ ok: true })),
	isProjectReadOnly: vi.fn(async () => false),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(async () => ({
		client: {
			tools: async () => ({
				create_card: { execute: h.execute },
				get_card: { execute: h.execute },
				fabric_pattern: { execute: h.execute },
			}),
		},
		serverName: "Fizzy",
		fromCache: true,
	})),
	invalidateMcpClientCache: vi.fn(),
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/utils", async () => {
	// Real classifier/output-builder (the gate under test), relative import so
	// we don't drag the whole @repo/utils barrel into the mock.
	const actual = (await vi.importActual(
		"../../../../../../utils/lib/read-only-mode",
	)) as Record<string, unknown>;
	return {
		getBaseUrl: () => "http://localhost:3000",
		...actual,
	};
});
vi.mock("@repo/database", () => ({
	db: {},
	isProjectReadOnly: h.isProjectReadOnly,
}));
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

const { executeMcpTool } = await import("../execute-mcp-tool");

describe("executeMcpTool read-only mode gate", () => {
	beforeEach(() => {
		h.execute.mockClear();
		h.isProjectReadOnly.mockReset();
		h.isProjectReadOnly.mockResolvedValue(false);
	});

	it("blocks a write-classified tool when the project is read-only", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);
		const res = await executeMcpTool({
			toolName: "create_card",
			args: { title: "x" },
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "cfg1",
		});
		expect(res.success).toBe(false);
		expect((res.output as { code?: string; error?: string }).code).toBe(
			"PROJECT_READ_ONLY",
		);
		expect(h.execute).not.toHaveBeenCalled();
	});

	it("lets read-classified tools through when the project is read-only", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);
		const res = await executeMcpTool({
			toolName: "get_card",
			args: { id: "1" },
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "cfg1",
		});
		expect(res.success).toBe(true);
		expect(h.execute).toHaveBeenCalledTimes(1);
	});

	it("lets writes through when the project is NOT read-only", async () => {
		const res = await executeMcpTool({
			toolName: "create_card",
			args: { title: "x" },
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "cfg1",
		});
		expect(res.success).toBe(true);
		expect(h.execute).toHaveBeenCalledTimes(1);
	});

	it("does not gate when no projectId is in scope (org-level boundary)", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);
		const res = await executeMcpTool({
			toolName: "create_card",
			args: { title: "x" },
			userId: "u1",
			mcpConfigId: "cfg1",
		});
		expect(res.success).toBe(true);
		expect(h.isProjectReadOnly).not.toHaveBeenCalled();
	});

	it("exempts fabric_ internal tools even in read-only mode", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);
		// fabric_pattern routes to the Fabric AI branch, which we don't mock —
		// the point is only that the gate must NOT produce the blocked output.
		const res = await executeMcpTool({
			toolName: "fabric_pattern",
			args: {},
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "cfg1",
		});
		expect((res.output as { code?: string } | null)?.code).not.toBe(
			"PROJECT_READ_ONLY",
		);
		expect(h.isProjectReadOnly).not.toHaveBeenCalled();
	});
});
