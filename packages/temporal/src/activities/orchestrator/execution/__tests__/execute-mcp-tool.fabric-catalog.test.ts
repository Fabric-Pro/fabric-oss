/**
 * Every Fabric AI tool the chat can discover through `search_tools` must run.
 *
 * The catalog is indexed under the virtual config id `fabric-ai-server`. Names
 * the in-process `fabric_` switch did not handle used to fall through to a
 * strict MCP lookup of that id and came back "MCP configuration not found",
 * which the model reads as a broken integration (Fizzy #2040, F7). Each
 * catalog name now has exactly one executor: the iterative loop, the switch,
 * or the catalog adapter (Direct's builders, else the plan-mode step handler).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getCachedMcpClientForConfig: vi.fn(async () => {
		throw new Error("MCP configuration not found");
	}),
	runFabricCatalogTool: vi.fn(async () => ({
		success: true,
		output: "ran",
	})),
	ensureSensitiveOperationAuthority: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	fabricActivity: vi.fn(async () => ({
		success: true,
		results: [],
		analysis: "",
		content: "",
		output: "",
	})),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: h.getCachedMcpClientForConfig,
	invalidateMcpClientCache: vi.fn(),
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
	generateImageActivity: vi.fn(async () => ({ success: true })),
}));
vi.mock("../fabric-catalog-adapter", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fabric-catalog-adapter")>()),
	runFabricCatalogTool: h.runFabricCatalogTool,
}));

const { executeMcpTool } = await import("../execute-mcp-tool");
const { resolveFabricCatalogRoute } = await import("../fabric-catalog-adapter");
const { getFabricAiTools } = await import("../../tools/fabric-ai-tools");

const src = (relative: string) =>
	readFileSync(resolve(__dirname, relative), "utf8");

/** Names the iterative loop dispatches itself, never reaching executeMcpTool. */
const LOOP_DISPATCHED = [
	"workspace_rag_query",
	"workspace_rag_summarize",
	"project_rag_query",
	"fabric_list_meeting_transcripts",
	"search_slack_messages",
	"search_teams_messages",
];

const catalogNames = getFabricAiTools().map((t) => t.name);

beforeEach(() => {
	h.getCachedMcpClientForConfig.mockClear();
	h.runFabricCatalogTool.mockClear();
	h.ensureSensitiveOperationAuthority.mockReset();
	h.ensureSensitiveOperationAuthority.mockResolvedValue({
		authorized: false,
		reason: "No active authority grant",
		action: "request_authority",
		pendingSessionId: "sess-1",
	});
});

describe("Fabric AI catalog executability", () => {
	it("the loop really dispatches the names listed as loop-dispatched", () => {
		const loop = src(
			"../../../../workflows/orchestrator/phases/iterative-execution.ts",
		);
		expect(loop).toContain('toolCall.name.startsWith("workspace_rag")');
		for (const name of LOOP_DISPATCHED.filter(
			(n) => !n.startsWith("workspace_rag"),
		)) {
			expect(loop).toContain(`toolCall.name === "${name}"`);
		}
	});

	it.each(catalogNames.filter((name) => !LOOP_DISPATCHED.includes(name)))(
		"%s runs without an MCP server lookup",
		async (toolName) => {
			const res = await executeMcpTool({
				toolName,
				args: {},
				userId: "u1",
				organizationId: "org-1",
				projectId: "p1",
				mcpConfigId: "fabric-ai-server",
			});

			expect(h.getCachedMcpClientForConfig).not.toHaveBeenCalled();
			expect(JSON.stringify(res.output)).not.toMatch(
				/MCP configuration not found|Tool not found|not available in chat/,
			);
			if (h.runFabricCatalogTool.mock.calls.length > 0) {
				expect(resolveFabricCatalogRoute(toolName)).toBeDefined();
			}
		},
	);

	it("every adapter route has a real implementation behind it", () => {
		const builtIns = src("../../../direct-chat/built-in-tools.ts");
		const handlers = [
			"weave-query-handler",
			"code-search-handler",
			"architecture-decisions-handler",
			"feature-decisions-handler",
			"security-findings-handler",
			"fabric-ai-handler",
		].map((f) => src(`../handlers/${f}.ts`));

		for (const name of catalogNames) {
			const route = resolveFabricCatalogRoute(name);
			if (route?.executor === "direct-builder") {
				expect(
					builtIns.includes(`toolId === "${name}"`) ||
						builtIns.includes(`${name}: tool(`),
					`${name} has a Direct builder`,
				).toBe(true);
			}
			if (route?.executor === "step-handler") {
				expect(
					handlers.some((h) => h.includes(`"${name}"`)),
					`${name} has a step handler`,
				).toBe(true);
			}
		}
	});

	it("every always-available capability is a catalog tool", async () => {
		const { ALWAYS_AVAILABLE_CAPABILITIES } = await import(
			"../../tools/capability-keywords"
		);
		for (const capability of ALWAYS_AVAILABLE_CAPABILITIES) {
			expect(catalogNames).toContain(capability.id);
		}
	});

	it("unknown names on the virtual config fail clearly instead of looking up MCP", async () => {
		h.runFabricCatalogTool.mockResolvedValueOnce({
			success: false,
			error: 'Fabric tool "nope" is not available in chat.',
		} as never);
		const res = await executeMcpTool({
			toolName: "nope",
			args: {},
			userId: "u1",
			mcpConfigId: "fabric-ai-server",
		});
		expect(h.getCachedMcpClientForConfig).not.toHaveBeenCalled();
		expect(res.success).toBe(false);
		expect(res.output).toEqual({
			error: 'Fabric tool "nope" is not available in chat.',
		});
	});
});

describe("Fabric catalog WRITE tools and runtime authority", () => {
	it("fabric_create_story waits for approval when the loop asks for authority", async () => {
		const res = await executeMcpTool({
			toolName: "fabric_create_story",
			args: { title: "x" },
			userId: "u1",
			organizationId: "org-1",
			projectId: "p1",
			mcpConfigId: "fabric-ai-server",
			conversationId: "conv-1",
			requestRuntimeAuthority: true,
		});

		expect(h.runFabricCatalogTool).not.toHaveBeenCalled();
		expect(res.success).toBe(false);
		expect(res.authorityRequired).toMatchObject({
			pendingSessionId: "sess-1",
			providerKey: "fabric",
			accessLevel: "WRITE",
			toolName: "fabric_create_story",
		});
		expect(h.ensureSensitiveOperationAuthority).toHaveBeenCalledWith(
			expect.objectContaining({
				providerKey: "fabric",
				accessLevel: "WRITE",
				runType: "ORCHESTRATOR",
				runId: "conv-1",
			}),
		);
	});

	it("a vendor write is gated as that integration", async () => {
		const res = await executeMcpTool({
			toolName: "fabric_asana_create_task",
			args: {},
			userId: "u1",
			organizationId: "org-1",
			mcpConfigId: "fabric-ai-server",
			conversationId: "conv-1",
			requestRuntimeAuthority: true,
		});

		expect(h.runFabricCatalogTool).not.toHaveBeenCalled();
		expect(res.authorityRequired).toMatchObject({
			providerDisplayName: "Asana",
			accessLevel: "WRITE",
		});
		expect(h.ensureSensitiveOperationAuthority).toHaveBeenCalledWith(
			expect.objectContaining({
				providerKey: "asana",
				providerType: "INTEGRATION",
			}),
		);
	});

	it("a read never touches the authority tables", async () => {
		await executeMcpTool({
			toolName: "code_search",
			args: { query: "directChatWorkflow" },
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "fabric-ai-server",
			requestRuntimeAuthority: true,
		});
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
		expect(h.runFabricCatalogTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "code_search",
				projectId: "p1",
			}),
		);
	});

	it("without the authority flag (pre-patch histories) a write runs as before", async () => {
		await executeMcpTool({
			toolName: "fabric_create_story",
			args: {},
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "fabric-ai-server",
		});
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
		expect(h.runFabricCatalogTool).toHaveBeenCalledOnce();
	});
});

describe("failed tool results carry a readable string error (F42)", () => {
	const onServer = (output: unknown) => {
		h.getCachedMcpClientForConfig.mockResolvedValueOnce({
			client: {
				tools: async () => ({
					notion_get_page: { execute: vi.fn(async () => output) },
				}),
			},
			serverName: "Notion",
			fromCache: true,
		} as never);
	};

	it("an MCP isError result gets its content text as output.error", async () => {
		onServer({
			isError: true,
			content: [{ type: "text", text: "Page not shared" }],
		});
		const res = await executeMcpTool({
			toolName: "notion_get_page",
			args: {},
			userId: "u1",
			mcpConfigId: "cfg-notion",
		});
		expect(res.success).toBe(false);
		expect(res.output).toMatchObject({
			error: "Page not shared",
			content: [{ type: "text", text: "Page not shared" }],
		});
	});

	it("a thrown JSON-RPC error object becomes its message, not [object Object]", async () => {
		h.getCachedMcpClientForConfig.mockResolvedValueOnce({
			client: {
				tools: async () => ({
					notion_get_page: {
						execute: vi.fn(async () => {
							throw {
								code: -32603,
								message: "Resource not found",
							};
						}),
					},
				}),
			},
			serverName: "Notion",
			fromCache: true,
		} as never);
		const res = await executeMcpTool({
			toolName: "notion_get_page",
			args: {},
			userId: "u1",
			// A config of its own: the tool list is cached per config.
			mcpConfigId: "cfg-notion-throws",
		});
		expect(res.output).toEqual({ error: "Resource not found" });
	});
});

describe("Read-only projects gate catalog tools on their declared access", () => {
	beforeEach(() => {
		h.isProjectReadOnly.mockResolvedValue(true);
	});
	afterEach(() => {
		h.isProjectReadOnly.mockResolvedValue(false);
	});

	it.each([
		"code_tree",
		"weave_query",
		"fabric_youtube_transcript",
		"fabric_readability",
		"fabric_text_to_speech",
	])("%s (a read) still runs", async (toolName) => {
		const res = await executeMcpTool({
			toolName,
			args: {},
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "fabric-ai-server",
		});
		expect(res.success).toBe(true);
		expect(h.runFabricCatalogTool).toHaveBeenCalledWith(
			expect.objectContaining({ toolName }),
		);
	});

	it("fabric_create_story (a write) is refused", async () => {
		const res = await executeMcpTool({
			toolName: "fabric_create_story",
			args: {},
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "fabric-ai-server",
		});
		expect(res.success).toBe(false);
		expect(h.runFabricCatalogTool).not.toHaveBeenCalled();
	});

	it("a same-named tool on a real server keeps the strict name check", async () => {
		const res = await executeMcpTool({
			toolName: "fabric_readability",
			args: {},
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "cfg-external",
		});
		expect(res.success).toBe(false);
		expect(h.runFabricCatalogTool).not.toHaveBeenCalled();
		expect(h.getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});
});
