/**
 * The Orchestrator reaches Fabric's workflow and frame tools the way it reaches
 * every Fabric catalog tool: it finds them through `search_tools` under the
 * virtual `fabric-ai-server` config and calls them through `executeMcpTool`.
 * What is new is where they run — on the Fabric MCP gateway, as the acting user
 * — and what each call asks of the person, which is the tool's own definition:
 * every workflow write asks for every call, a frame write asks only when it
 * gives the page tools, anything else asks nothing. An approval is for the call
 * (a one-shot grant fingerprinted on the tool and its arguments) or for the one
 * tool, never for the whole provider.
 *
 * The gateway client is a stand-in; everything between `executeMcpTool` and it
 * (the catalog route, the authority gate, the read-only guard, the acting
 * context) is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	FABRIC_GATEWAY_TOOL_DEFINITIONS,
} from "../../../../lib/fabric-gateway-tools";
import {
	type FabricToolDefinition,
	toolAccess,
} from "../../../../lib/fabric-tool-definition";

const h = vi.hoisted(() => ({
	callAuthorized: vi.fn(),
	close: vi.fn(async () => undefined),
	loadFabricPlatformTools: vi.fn(),
	ensureSensitiveOperationAuthority: vi.fn(),
	createApprovedRequestGrants: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
}));

vi.mock("../../../shared/fabric-platform-mcp", () => ({
	loadFabricPlatformTools: h.loadFabricPlatformTools,
}));
vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(),
	invalidateMcpClientCache: vi.fn(),
	isClosedClientRefusedBeforeSend: () => false,
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
	createApprovedRequestGrants: h.createApprovedRequestGrants,
	authorityRequestFingerprint: (
		tool: string,
		args: Record<string, unknown>,
	) => `fingerprint:${tool}:${JSON.stringify(args)}`,
	resolveCanonicalProviderKey: (key: string) => key.toLowerCase(),
}));
vi.mock("@repo/integrations/github", () => ({ executeGitHubTool: vi.fn() }));
vi.mock("@repo/integrations/slack", () => ({ executeSlackTool: vi.fn() }));
vi.mock("../../../letta-memory-activities", () => ({
	cacheToolResult: vi.fn(),
	getCachedToolResult: vi.fn(async () => ({ found: false })),
}));
vi.mock("../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));
vi.mock("../../../fabric-ai", () => ({}));
vi.mock("../../../image-generation", () => ({
	generateImageActivity: vi.fn(),
}));

const { executeMcpTool } = await import("../execute-mcp-tool");
const {
	resolveCatalogApproval,
	resolveFabricCatalogRoute,
	runFabricCatalogTool,
} = await import("../fabric-catalog-adapter");

const TOOLS = FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name);
const GATEWAY_TOOLS: readonly FabricToolDefinition[] =
	FABRIC_GATEWAY_TOOL_DEFINITIONS;
const PAGE_ONLY_TOOLS = GATEWAY_TOOLS.filter(
	(tool) => tool.pageOnly === true,
).map((tool) => tool.name);
const WORKFLOW_WRITES = FABRIC_CHAT_TOOL_DEFINITIONS.filter(
	(tool) => tool.name.endsWith("_workflow") && toolAccess(tool) === "WRITE",
).map((tool) => tool.name);
const READS = FABRIC_CHAT_TOOL_DEFINITIONS.filter(
	(tool) => toolAccess(tool) === "READ",
).map((tool) => tool.name);
const FRAME_WRITES_THAT_ALWAYS_ASK = [
	"fabric_share_frame",
	"fabric_restore_frame_version",
	"fabric_page_data_delete",
	"fabric_page_file_delete",
];
const FRAME_WRITES_THAT_ASK_NOTHING = [
	"fabric_create_slideshow",
	"fabric_duplicate_frame",
	"fabric_page_data_set",
	"fabric_page_file_upload",
	"fabric_page_comment_add",
];

const call = {
	args: { workflowId: "wf-1" },
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
	mcpConfigId: "fabric-ai-server",
	executionId: "exec-1",
	conversationId: "conv-1",
	requestRuntimeAuthority: true,
	actingGrant: "grant-from-the-web-route",
	launchWorkspaceId: "workspace-frame-1",
	launchSurface: "workspace" as const,
};

function grantNotInForce() {
	h.ensureSensitiveOperationAuthority.mockResolvedValue({
		authorized: false,
		reason: "No active authority grant",
		action: "request_authority",
		pendingSessionId: "sess-1",
	});
}

function grantInForce() {
	h.ensureSensitiveOperationAuthority.mockResolvedValue({
		authorized: true,
		grant: { id: "grant-1" },
	});
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	h.callAuthorized.mockReset();
	h.callAuthorized.mockResolvedValue({ workflow: { id: "wf-1" } });
	h.close.mockClear();
	h.loadFabricPlatformTools.mockReset();
	h.loadFabricPlatformTools.mockResolvedValue({
		tools: {},
		runApproved: vi.fn(),
		callAuthorized: h.callAuthorized,
		close: h.close,
	});
	h.createApprovedRequestGrants.mockReset();
	h.createApprovedRequestGrants.mockResolvedValue({
		id: "follow-up-session",
	});
	h.ensureSensitiveOperationAuthority.mockReset();
	grantNotInForce();
	h.isProjectReadOnly.mockReset();
	h.isProjectReadOnly.mockResolvedValue(false);
});

describe("which tools are the gateway's", () => {
	it("serves every workflow, frame and page tool the chat offers from the gateway, and nothing else", () => {
		for (const name of TOOLS) {
			expect(resolveFabricCatalogRoute(name)?.executor).toBe("gateway");
		}
		for (const name of PAGE_ONLY_TOOLS) {
			expect(resolveFabricCatalogRoute(name), name).toBeUndefined();
		}
		expect(resolveFabricCatalogRoute("fabric_create_story")?.executor).toBe(
			"direct-builder",
		);
		expect(resolveFabricCatalogRoute("toString")).toBeUndefined();
		expect(resolveFabricCatalogRoute("constructor")).toBeUndefined();
	});

	it("declares access from the definition: only a plain read-only tool is a READ", () => {
		for (const name of READS) {
			expect(resolveFabricCatalogRoute(name)?.access).toBe("READ");
		}
		for (const name of TOOLS.filter((tool) => !READS.includes(tool))) {
			expect(resolveFabricCatalogRoute(name)?.access).toBe("WRITE");
		}
	});
});

describe("what a call asks of the person", () => {
	it.each(WORKFLOW_WRITES)("%s asks for every call", (name) => {
		expect(resolveCatalogApproval(name, { workflowId: "wf-1" })).toBe(
			"every-call",
		);
	});

	it.each(FRAME_WRITES_THAT_ALWAYS_ASK)("%s asks for every call", (name) => {
		expect(resolveCatalogApproval(name, { frameId: "frame-1" })).toBe(
			"every-call",
		);
	});

	it.each([
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_duplicate_frame",
	])("%s asks only when the call gives the page tools", (name) => {
		expect(resolveCatalogApproval(name, { title: "Status" })).toBe("none");
		expect(
			resolveCatalogApproval(name, {
				title: "Status",
				runtimeTools: [],
			}),
		).toBe("none");
		expect(
			resolveCatalogApproval(name, {
				title: "Status",
				runtimeTools: ["fabric_list_workflows"],
			}),
		).toBe("every-call");
	});

	it.each(FRAME_WRITES_THAT_ASK_NOTHING)("%s asks nothing", (name) => {
		expect(resolveCatalogApproval(name, { frameId: "frame-1" })).toBe(
			"none",
		);
	});

	it.each(READS)("%s asks nothing", (name) => {
		expect(resolveCatalogApproval(name, {})).toBe("none");
	});

	it("takes a dryRun at its word only on a tool that has one, because it writes nothing", () => {
		expect(
			resolveCatalogApproval("fabric_create_workflow", { dryRun: true }),
		).toBe("none");
		expect(
			resolveCatalogApproval("fabric_update_workflow", {
				workflowId: "wf-1",
				dryRun: true,
			}),
		).toBe("none");
		expect(
			resolveCatalogApproval("fabric_execute_workflow", {
				workflowId: "wf-1",
				dryRun: true,
			}),
		).toBe("every-call");
	});

	it("keeps a Fabric write that predates the definitions at a conversation approval for that tool", () => {
		expect(resolveCatalogApproval("fabric_create_story", {})).toBe(
			"conversation",
		);
	});
});

describe("a call that asks is refused until the person says yes", () => {
	it.each(WORKFLOW_WRITES)(
		"%s raises a one-shot grant for exactly this call and calls nothing",
		async (toolName) => {
			const result = await executeMcpTool({ ...call, toolName });

			expect(result.success).toBe(false);
			expect(result.authorityRequired).toEqual({
				pendingSessionId: "sess-1",
				providerKey: "fabric",
				providerDisplayName: "Fabric",
				accessLevel: "WRITE",
				toolName,
				grantScope: "call",
				callSummary: "workflowId: wf-1",
			});
			expect(h.ensureSensitiveOperationAuthority).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
					providerKey: "fabric",
					accessLevel: "WRITE",
					runType: "ORCHESTRATOR",
					runId: "conv-1",
					toolName,
					toolScope: [toolName],
					requestFingerprint: `fingerprint:${toolName}:{"workflowId":"wf-1"}`,
				}),
			);
			expect(h.loadFabricPlatformTools).not.toHaveBeenCalled();
			expect(h.callAuthorized).not.toHaveBeenCalled();
		},
	);

	it.each(FRAME_WRITES_THAT_ALWAYS_ASK)(
		"%s raises a one-shot grant and calls nothing",
		async (toolName) => {
			const result = await executeMcpTool({
				...call,
				toolName,
				args: { frameId: "frame-1" },
			});

			expect(result.success).toBe(false);
			expect(result.authorityRequired).toEqual(
				expect.objectContaining({
					toolName,
					accessLevel: "WRITE",
					grantScope: "call",
				}),
			);
			expect(h.callAuthorized).not.toHaveBeenCalled();
		},
	);

	it("asks again for a different call to the same tool: the fingerprint carries the arguments", async () => {
		await executeMcpTool({
			...call,
			toolName: "fabric_publish_workflow",
			args: { workflowId: "wf-1" },
		});
		await executeMcpTool({
			...call,
			toolName: "fabric_publish_workflow",
			args: { workflowId: "wf-2" },
		});

		const fingerprints = h.ensureSensitiveOperationAuthority.mock.calls.map(
			([request]) => request.requestFingerprint,
		);
		expect(new Set(fingerprints).size).toBe(2);
	});

	it("asks for a frame write that gives the page tools", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_frame",
			args: { title: "Status", runtimeTools: ["fabric_list_workflows"] },
		});

		expect(result.authorityRequired).toMatchObject({
			toolName: "fabric_create_frame",
			grantScope: "call",
			callSummary: "title: Status; runtimeTools: fabric_list_workflows",
		});
		expect(h.callAuthorized).not.toHaveBeenCalled();
	});

	it("tells the person what a workflow draft is called and when it runs, however nested the call", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_workflow",
			args: {
				preset: {
					name: "Weekly digest",
					cron: "0 9 * * 1",
					prompt: "x".repeat(300),
					mcpServers: ["Example Tracker"],
					timezone: "UTC",
				},
			},
		});

		const summary = result.authorityRequired?.callSummary ?? "";
		expect(summary).toContain("preset.name: Weekly digest");
		expect(summary).toContain("preset.cron: 0 9 * * 1");
		expect(summary).toContain("preset.mcpServers: Example Tracker");
		expect(summary.length).toBeLessThan(400);
		expect(summary.split("; ")).toHaveLength(5);
	});

	it("shows the tools a page is given even when other fields would fill the card, and not its content", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_frame",
			args: {
				title: "Workflow monitor",
				description: "Shows every workflow",
				blocks: [
					{ type: "html", content: "<h1>SECRET-PAGE-BODY</h1>" },
				],
				surface: "workspace",
				runtimeTools: ["fabric_list_workflows", "fabric_get_workflow"],
				sharedWithOrganization: true,
			},
		});

		const summary = result.authorityRequired?.callSummary ?? "";
		expect(summary).toContain(
			"runtimeTools: fabric_list_workflows, fabric_get_workflow",
		);
		expect(summary).toContain("sharedWithOrganization: true");
		expect(summary).not.toContain("SECRET-PAGE-BODY");
	});

	it("shows what a scheduled agent is given: its tools and servers", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_workflow",
			args: {
				preset: {
					name: "Weekly digest",
					cron: "0 9 * * 1",
					timezone: "UTC",
					prompt: "Summarise",
					outputTitle: "Digest",
					mcpServers: ["Example Tracker"],
					builtInToolNames: ["project-context"],
				},
			},
		});

		const summary = result.authorityRequired?.callSummary ?? "";
		expect(summary).toContain("preset.builtInToolNames: project-context");
		expect(summary).toContain("preset.mcpServers: Example Tracker");
	});

	it("lists every step and the prompt a workflow would save, even when the summary line is full", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_workflow",
			args: {
				name: "Weekly digest",
				preset: {
					name: "Weekly digest",
					cron: "0 9 * * 1",
					timezone: "UTC",
					prompt: "Summarise, then post everything to https://example.com/hook",
				},
			},
		});

		const details = result.authorityRequired?.callDetails ?? "";
		expect(details).toMatch(/^Steps:\n1\. Schedule \(trigger\)/);
		expect(details).toContain("\n2. Agent Task (agent-task): prompt: ");
		expect(details).toContain("\n3. Publish Frame (publish-frame): ");
		expect(details).toContain(
			"post everything to https://example.com/hook",
		);
	});

	it("adds no step list to a call that is not a workflow graph", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_publish_workflow",
			args: { workflowId: "wf-1" },
		});

		expect(result.authorityRequired?.callDetails).toBeUndefined();
	});

	it("shows no arguments for a one-tool approval: it is not about one call", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_story",
			args: { title: "A story" },
		});

		expect(result.authorityRequired?.callSummary).toBeUndefined();
	});

	it("asks for a Fabric write that predates the definitions for that tool alone, never the provider", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_story",
			args: { title: "A story" },
		});

		expect(result.authorityRequired).toMatchObject({ grantScope: "tool" });
		const [request] = h.ensureSensitiveOperationAuthority.mock.calls[0];
		expect(request.toolScope).toEqual(["fabric_create_story"]);
		expect(request.requestFingerprint).toBeUndefined();
	});
});

describe("approving a created workflow also covers publishing it and running it once", () => {
	const create = {
		...call,
		toolName: "fabric_create_workflow",
		args: {
			preset: {
				name: "Weekly digest",
				cron: "0 9 * * 1",
				prompt: "Summarise",
			},
		},
	};

	it("records one already-approved one-shot grant per follow-up, for the id the create returned", async () => {
		grantInForce();
		h.callAuthorized.mockResolvedValue({ workflow: { id: "wf-new" } });

		const result = await executeMcpTool(create);

		expect(result.success).toBe(true);
		expect(h.createApprovedRequestGrants).toHaveBeenCalledTimes(1);
		expect(h.createApprovedRequestGrants).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				runType: "ORCHESTRATOR",
				runId: "conv-1",
				providerKey: "fabric",
				accessLevel: "WRITE",
				calls: [
					{
						toolName: "fabric_publish_workflow",
						requestFingerprint:
							'fingerprint:fabric_publish_workflow:{"workflowId":"wf-new"}',
					},
					{
						toolName: "fabric_execute_workflow",
						requestFingerprint:
							'fingerprint:fabric_execute_workflow:{"workflowId":"wf-new"}',
					},
				],
			}),
		);
	});

	it("matches the fingerprint the publish call is later asked about, so only that call is covered", async () => {
		grantInForce();
		h.callAuthorized.mockResolvedValue({ workflow: { id: "wf-new" } });
		await executeMcpTool(create);
		const [{ calls }] = h.createApprovedRequestGrants.mock.calls[0];

		await executeMcpTool({
			...call,
			toolName: "fabric_publish_workflow",
			args: { workflowId: "wf-new" },
		});
		const [asked] =
			h.ensureSensitiveOperationAuthority.mock.calls.at(-1) ?? [];

		expect(asked.requestFingerprint).toBe(calls[0].requestFingerprint);
		expect(asked.requestFingerprint).not.toBe(
			`fingerprint:fabric_publish_workflow:${JSON.stringify({ workflowId: "wf-other" })}`,
		);
	});

	async function askedAfterCreate(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<{ asked: string; covered: string[] }> {
		grantInForce();
		h.callAuthorized.mockResolvedValue({ workflow: { id: "wf-new" } });
		await executeMcpTool(create);
		const [{ calls }] = h.createApprovedRequestGrants.mock.calls[0];
		grantNotInForce();

		await executeMcpTool({ ...call, toolName, args });
		const [request] =
			h.ensureSensitiveOperationAuthority.mock.calls.at(-1) ?? [];

		return {
			asked: request.requestFingerprint,
			covered: calls.map(
				(followUp: { requestFingerprint: string }) =>
					followUp.requestFingerprint,
			),
		};
	}

	it.each([
		["with no inputs", { workflowId: "wf-new" }],
		["with empty inputs", { workflowId: "wf-new", inputs: {} }],
	])(
		"covers the run the model starts %s: it is the same run",
		async (_label, args) => {
			const { asked, covered } = await askedAfterCreate(
				"fabric_execute_workflow",
				args,
			);

			expect(asked).toBe(covered[1]);
		},
	);

	it("asks for a run started with inputs: the approval did not cover them", async () => {
		const { asked, covered } = await askedAfterCreate(
			"fabric_execute_workflow",
			{ workflowId: "wf-new", inputs: { x: 1 } },
		);

		expect(covered).not.toContain(asked);
	});

	it("asks for a run of another workflow, with or without empty inputs", async () => {
		for (const args of [
			{ workflowId: "wf-other" },
			{ workflowId: "wf-other", inputs: {} },
		]) {
			const { asked, covered } = await askedAfterCreate(
				"fabric_execute_workflow",
				args,
			);

			expect(covered).not.toContain(asked);
		}
	});

	it("folds empty inputs for a run only, never for another tool", async () => {
		const { asked, covered } = await askedAfterCreate(
			"fabric_publish_workflow",
			{ workflowId: "wf-new", inputs: {} },
		);

		expect(covered).not.toContain(asked);
	});

	it("records nothing when the create did not return a workflow", async () => {
		grantInForce();
		h.callAuthorized.mockResolvedValue({ problems: ["bad cron"] });

		await executeMcpTool(create);

		expect(h.createApprovedRequestGrants).not.toHaveBeenCalled();
	});

	it("records nothing when the create was not approved and ran nothing", async () => {
		const result = await executeMcpTool(create);

		expect(result.authorityRequired).toBeDefined();
		expect(h.createApprovedRequestGrants).not.toHaveBeenCalled();
	});

	it("records nothing for any other approved write", async () => {
		grantInForce();

		await executeMcpTool({
			...call,
			toolName: "fabric_publish_workflow",
			args: { workflowId: "wf-1" },
		});

		expect(h.createApprovedRequestGrants).not.toHaveBeenCalled();
	});

	it("records nothing for a run that has neither a conversation nor an execution", async () => {
		grantInForce();
		h.callAuthorized.mockResolvedValue({ workflow: { id: "wf-new" } });

		await executeMcpTool({
			...create,
			conversationId: undefined,
			executionId: undefined,
		});

		expect(h.createApprovedRequestGrants).not.toHaveBeenCalled();
	});

	it("still reports the create as done when the follow-ups could not be recorded, which only makes them ask", async () => {
		grantInForce();
		h.callAuthorized.mockResolvedValue({ workflow: { id: "wf-new" } });
		h.createApprovedRequestGrants.mockRejectedValue(new Error("db down"));

		const result = await executeMcpTool(create);

		expect(result.success).toBe(true);
		expect(result.output).toEqual({ workflow: { id: "wf-new" } });
	});
});

describe("a call that was approved runs on the gateway as the acting user", () => {
	it.each(WORKFLOW_WRITES)("%s", async (toolName) => {
		grantInForce();

		const result = await executeMcpTool({ ...call, toolName });

		expect(result.success).toBe(true);
		expect(result.output).toEqual({ workflow: { id: "wf-1" } });
		expect(h.callAuthorized).toHaveBeenCalledWith(toolName, call.args);
		expect(h.close).toHaveBeenCalledTimes(1);
	});

	it("tells the gateway who it acts for and where, in the same terms as Direct chat", async () => {
		grantInForce();

		await executeMcpTool({ ...call, toolName: "fabric_publish_workflow" });

		expect(h.loadFabricPlatformTools).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			actingGrant: "grant-from-the-web-route",
			projectId: "proj-1",
			workspaceId: "workspace-frame-1",
			surface: "workspace",
			conversationId: "conv-1",
			sourceRunType: "orchestrator",
			sourceRunId: "exec-1",
		});
	});

	it("does not call the gateway for a turn that carries no acting grant", async () => {
		const { actingGrant: _, ...withoutGrant } = call;

		const result = await executeMcpTool({
			...withoutGrant,
			toolName: "fabric_list_workflows",
			args: {},
		});

		expect(result.success).toBe(false);
		expect((result.output as { error: string }).error).toContain(
			"send their message again",
		);
		expect(h.loadFabricPlatformTools).not.toHaveBeenCalled();
	});

	it("never calls the gateway for a call that asks when the approval cannot be asked for", async () => {
		const { requestRuntimeAuthority: _, ...withoutAuthority } = call;

		const result = await executeMcpTool({
			...withoutAuthority,
			toolName: "fabric_execute_workflow",
		});

		expect(result.success).toBe(false);
		expect(result.failureKind).toBe("rejected");
		expect((result.output as { error: string }).error).toContain(
			"needs the person's approval",
		);
		expect(h.loadFabricPlatformTools).not.toHaveBeenCalled();
	});

	it("is refused in a Read-only project before the authority is even asked, frame writes included", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);

		for (const toolName of [
			"fabric_create_workflow",
			"fabric_create_frame",
		]) {
			const result = await executeMcpTool({
				...call,
				toolName,
				args: { title: "x", preset: { name: "x" } },
			});
			expect(result.success).toBe(false);
		}

		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
		expect(h.loadFabricPlatformTools).not.toHaveBeenCalled();
	});

	it("fails closed when the authority check throws", async () => {
		h.ensureSensitiveOperationAuthority.mockRejectedValue(
			new Error("db down"),
		);

		const result = await executeMcpTool({
			...call,
			toolName: "fabric_create_workflow",
		});

		expect(result.success).toBe(false);
		expect(h.loadFabricPlatformTools).not.toHaveBeenCalled();
	});
});

describe("a draft, a read and a frame write that gives no tools ask nothing", () => {
	it.each(["fabric_create_workflow", "fabric_update_workflow"])(
		"%s with dryRun writes nothing, so it runs without a grant and returns the draft",
		async (toolName) => {
			h.callAuthorized.mockResolvedValue({
				draft: { name: "Weekly digest" },
			});
			const args = { workflowId: "wf-1", preset: {}, dryRun: true };

			const result = await executeMcpTool({ ...call, toolName, args });

			expect(result.success).toBe(true);
			expect(result.output).toEqual({ draft: { name: "Weekly digest" } });
			expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
			expect(h.callAuthorized).toHaveBeenCalledWith(toolName, args);
		},
	);

	it("does not take dryRun on trust for a tool that has no draft", async () => {
		const result = await executeMcpTool({
			...call,
			toolName: "fabric_execute_workflow",
			args: { workflowId: "wf-1", dryRun: true },
		});

		expect(result.authorityRequired?.toolName).toBe(
			"fabric_execute_workflow",
		);
		expect(h.callAuthorized).not.toHaveBeenCalled();
	});

	it.each(READS)("%s is never gated", async (toolName) => {
		const result = await executeMcpTool({ ...call, toolName, args: {} });

		expect(result.success).toBe(true);
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
		expect(h.callAuthorized).toHaveBeenCalledWith(toolName, {});
	});

	it.each(["fabric_create_frame", "fabric_update_frame"])(
		"%s runs without a grant when the page is given no tools",
		async (toolName) => {
			const args = { title: "Status", blocks: [] };

			const result = await executeMcpTool({ ...call, toolName, args });

			expect(result.success).toBe(true);
			expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
			expect(h.callAuthorized).toHaveBeenCalledWith(toolName, args);
		},
	);

	it.each(FRAME_WRITES_THAT_ASK_NOTHING)("%s", async (toolName) => {
		const result = await executeMcpTool({
			...call,
			toolName,
			args: { frameId: "frame-1", title: "Deck" },
		});

		expect(result.success).toBe(true);
		expect(h.ensureSensitiveOperationAuthority).not.toHaveBeenCalled();
	});
});

describe("what the gateway answers", () => {
	const input = {
		toolName: "fabric_get_workflow",
		args: { workflowId: "wf-1" },
		userId: "user-1",
		organizationId: "org-1",
		projectId: "proj-1",
		conversationId: "conv-1",
		executionId: "exec-1",
		actingGrant: "grant-from-the-web-route",
	};

	it("reports a refusal as the tool's failure and still closes the connection", async () => {
		h.callAuthorized.mockResolvedValue({ error: "Workflow not found" });

		const result = await runFabricCatalogTool(input);

		expect(result).toEqual({ success: false, error: "Workflow not found" });
		expect(h.close).toHaveBeenCalledTimes(1);
	});

	it("closes the connection when the call throws", async () => {
		h.callAuthorized.mockRejectedValue(new Error("socket hang up"));

		const result = await runFabricCatalogTool(input);

		expect(result.success).toBe(false);
		expect(h.close).toHaveBeenCalledTimes(1);
	});

	it("says so when the gateway cannot be reached", async () => {
		h.loadFabricPlatformTools.mockResolvedValue(null);

		const result = await runFabricCatalogTool(input);

		expect(result).toMatchObject({ success: false });
		expect((result as { error: string }).error).toContain("unavailable");
	});

	it("does not call the gateway without an organization", async () => {
		const { organizationId: _, ...withoutOrganization } = input;

		const result = await runFabricCatalogTool(withoutOrganization);

		expect(result.success).toBe(false);
		expect(h.loadFabricPlatformTools).not.toHaveBeenCalled();
	});

	it("leaves the source run and the page out of the acting context when the call has none", async () => {
		const { executionId: _, ...withoutRun } = input;

		await runFabricCatalogTool(withoutRun);

		expect(h.loadFabricPlatformTools).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceRunType: undefined,
				sourceRunId: undefined,
				workspaceId: undefined,
				surface: undefined,
			}),
		);
	});
});
