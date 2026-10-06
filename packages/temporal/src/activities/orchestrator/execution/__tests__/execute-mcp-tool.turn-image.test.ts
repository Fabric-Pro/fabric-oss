/**
 * `fabric_generate_image` through executeMcpTool inside an Advisor chat turn:
 * the turn scope reaches the image activity, and a stop (a refused dispatch
 * or a cancelled activity) is rethrown — never turned into the ordinary
 * `{ success: false }` tool error the model would then work around. A run
 * without a turn keeps converting a failure into a tool error.
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getCachedMcpClientForConfig: vi.fn(async () => {
		throw new Error("MCP configuration not found");
	}),
	runFabricCatalogTool: vi.fn(),
	ensureSensitiveOperationAuthority: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	fabricActivity: vi.fn(),
	generateImageActivity: vi.fn(),
	checkDispatchable: vi.fn(),
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
	return { getBaseUrl: () => "http://localhost:3000", ...actual };
});
vi.mock("@repo/database", () => ({
	db: { mCPConfig: { findMany: vi.fn(async () => []) } },
	isProjectReadOnly: h.isProjectReadOnly,
	checkAuthority: vi.fn(),
	ensureSensitiveOperationAuthority: h.ensureSensitiveOperationAuthority,
	resolveCanonicalProviderKey: (key: string) => key.toLowerCase(),
	checkConversationTurnDispatchable: h.checkDispatchable,
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
vi.mock("../../../fabric-ai", () => ({
	searchWebActivity: h.fabricActivity,
	searchAndAnalyzeActivity: h.fabricActivity,
	scrapeUrlActivity: h.fabricActivity,
	scrapeAndAnalyzeActivity: h.fabricActivity,
	executeFabricPattern: h.fabricActivity,
}));
vi.mock("../../../image-generation", () => ({
	generateImageActivity: h.generateImageActivity,
}));
vi.mock("../fabric-catalog-adapter", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fabric-catalog-adapter")>()),
	runFabricCatalogTool: h.runFabricCatalogTool,
}));

const { executeMcpTool } = await import("../execute-mcp-tool");

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "u1",
	organizationId: "org-1",
};

function imageCall(withTurn: boolean) {
	return executeMcpTool({
		toolName: "fabric_generate_image",
		args: { prompt: "a paper boat" },
		userId: "u1",
		organizationId: "org-1",
		mcpConfigId: "fabric-ai-server",
		...(withTurn ? { turnScope: TURN_SCOPE } : {}),
	});
}

beforeEach(() => {
	h.generateImageActivity.mockReset();
	h.fabricActivity.mockReset();
	h.checkDispatchable.mockReset();
	h.checkDispatchable.mockResolvedValue({ ok: true });
});

describe("fabric_generate_image in a chat turn", () => {
	it("passes the turn scope to the image activity", async () => {
		h.generateImageActivity.mockResolvedValue({
			success: true,
			imageUrl: "https://example.com/i.png",
			provider: "gateway",
			model: "m",
			durationMs: 1,
		});
		await imageCall(true);
		expect(h.generateImageActivity).toHaveBeenCalledWith(
			expect.objectContaining({ turnScope: TURN_SCOPE }),
		);
	});

	it("rethrows a refused dispatch instead of returning a tool error", async () => {
		h.generateImageActivity.mockRejectedValue(
			ApplicationFailure.create({
				type: "TurnNotDispatchable",
				message: "Turn may not make another model request (cancelled)",
				nonRetryable: true,
				details: [{ reason: "cancelled" }],
			}),
		);
		const outcome = await imageCall(true).then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
		expect(outcome).toBeInstanceOf(ApplicationFailure);
		expect((outcome as ApplicationFailure).type).toBe(
			"TurnNotDispatchable",
		);
	});

	it("a run without a turn still gets an ordinary tool error", async () => {
		h.generateImageActivity.mockRejectedValue(new Error("provider down"));
		const result = await imageCall(false);
		expect(result.success).toBe(false);
	});
});

describe("any tool in a chat turn", () => {
	it("is not launched once a Stop is recorded", async () => {
		h.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});
		const outcome = await executeMcpTool({
			toolName: "fabric_pattern",
			args: { pattern: "summarize", input: "launch notes" },
			userId: "u1",
			organizationId: "org-1",
			mcpConfigId: "fabric-ai-server",
			turnScope: TURN_SCOPE,
		}).then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
		expect(h.fabricActivity).not.toHaveBeenCalled();
		expect(outcome).toBeInstanceOf(ApplicationFailure);
		expect((outcome as ApplicationFailure).type).toBe(
			"TurnNotDispatchable",
		);
	});

	it("a run without a turn launches the tool without consulting a turn", async () => {
		h.fabricActivity.mockResolvedValue({ success: true, output: "ok" });
		const result = await executeMcpTool({
			toolName: "fabric_pattern",
			args: { pattern: "summarize", input: "launch notes" },
			userId: "u1",
			organizationId: "org-1",
			mcpConfigId: "fabric-ai-server",
		});
		expect(h.fabricActivity).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		expect(h.checkDispatchable).not.toHaveBeenCalled();
	});
});
