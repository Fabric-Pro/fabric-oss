/**
 * A Fabric AI tool through executeMcpTool inside an Advisor chat turn, with
 * the real Fabric AI activities and client underneath (only `fetch` and the
 * stores are mocked).
 *
 * The tenant's configured search provider is Jina (a row under its
 * organization only), so the real Jina client sends the request. The turn is
 * stopped before that request: its dispatch check refuses it, and the stop
 * must leave executeMcpTool as the refusal, not come back as a
 * `{ success: false }` tool error the model works around. Without a turn the
 * same upstream failure still ends as an ordinary tool error.
 */

import { ApplicationFailure } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
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

const { executeMcpTool } = await import("../execute-mcp-tool");
const { runWithTurnDispatch } = await import("../../turn-dispatch");

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "u1",
	organizationId: "org-1",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	h.checkDispatchable.mockReset();
	fetchMock = vi.fn(
		async () => new Response("upstream unavailable", { status: 502 }),
	);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function webSearch(withTurn: boolean) {
	return executeMcpTool({
		toolName: "fabric_web_search",
		args: { query: "release notes" },
		userId: "u1",
		organizationId: "org-1",
		mcpConfigId: "fabric-ai-server",
		...(withTurn ? { turnScope: TURN_SCOPE } : {}),
	});
}

describe("fabric_web_search in a chat turn", () => {
	it("a stop met before the provider request leaves as the refusal, not as a tool error", async () => {
		// The launch check passes; the Stop is recorded before the search.
		h.checkDispatchable
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValue({ ok: false, reason: "cancelled" });

		const outcome = await runWithTurnDispatch(TURN_SCOPE, () =>
			webSearch(true),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(ApplicationFailure);
		expect((outcome as ApplicationFailure).type).toBe(
			"TurnNotDispatchable",
		);
		// Neither the Jina request nor a Fabric AI server fallback was sent.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.getMergedSearchProviderConfigs).toHaveBeenCalledWith({
			userId: "u1",
			organizationId: "org-1",
		});
	});

	it("without a turn, an upstream failure still ends as an ordinary tool error", async () => {
		const result = await webSearch(false);

		expect(result.success).toBe(false);
		// One request, to the configured provider (Jina), reported as failed.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain("s.jina.ai");
		expect(h.checkDispatchable).not.toHaveBeenCalled();
	});
});
