import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	admitCallable,
	normalizedEntry,
	toolBinding,
} from "../../advisor-call-tool";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const stub = (name: string) => {
		let fn = activities.get(name);
		if (!fn) {
			fn = vi.fn();
			activities.set(name, fn);
		}
		return fn;
	};
	return {
		stub,
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		/** Markers a test switches off to replay an older history. */
		off: new Set<string>(),
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		startTime: new Date(Date.now()),
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import {
	installDefaultStubs,
	preloaded,
	runTurn,
	toolMessage,
} from "./advisor-scenario-harness";

beforeEach(() => {
	installDefaultStubs(mocks);
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const wrap = (name: string, args: unknown = {}) => ({
	calls: [{ name: "call_tool", args: { name, arguments: args } }],
});
const search = {
	calls: [{ name: "search_tools", args: { query: "example" } }],
};
const done = { answer: "Done." };
const mode = { toolLoadingMode: "call_tool" };
function discover(names = ["example_read"], configId = "config-example") {
	mocks.stub("searchAvailableTools").mockResolvedValue({
		results: preloaded(names, configId, "Example"),
		totalToolsSearched: names.length,
		semanticSearchUsed: false,
		durationMs: 1,
	});
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: { ok: true },
		success: true,
		durationMs: 1,
		cached: false,
	});
}
it("keeps the main native list fixed after discovery and feeds the result back", async () => {
	discover();
	const turn = await runTurn(mocks, {
		message: "Read examples",
		input: mode,
		observeRequests: true,
		steps: [search, wrap("example_read", { limit: "100" }), done],
	});
	expect(turn.seen.map((s) => s.tools)).toEqual([
		turn.seen[0].tools,
		turn.seen[0].tools,
		turn.seen[0].tools,
	]);
	expect(turn.seen[0].tools).toEqual(
		expect.arrayContaining([
			"call_tool",
			"get_tool_schema",
			"search_tools",
		]),
	);
	expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
		expect.objectContaining({
			toolName: "example_read",
			args: { limit: "100" },
			mcpConfigId: "config-example",
		}),
	);
	expect(toolMessage(turn.seen, 2, "call-2-0")).toContain('"ok":true');
	expect(turn.state.toolCalls.find((c) => c.id === "call-2-0")).toMatchObject(
		{ name: "example_read", args: { limit: "100" } },
	);
	expect(
		turn.seen[2].history.find((m) =>
			m.toolCalls?.some((c) => c.id === "call-2-0"),
		)?.toolCalls?.[0],
	).toMatchObject({
		name: "call_tool",
		args: { name: "example_read", arguments: { limit: "100" } },
	});
});
it.each([
	"example_unfound",
	"example_config_only",
	"delegate_to_unknown",
	"workspace_rag_arbitrary",
	"call_tool",
	"search_tools",
	"get_tool_schema",
])("refuses unadmitted or meta target %s", async (name) => {
	discover();
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [wrap(name), done],
	});
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
	expect(mocks.stub("executeAgentAsTool")).not.toHaveBeenCalled();
	expect(toolMessage(turn.seen, 1, "call-1-0")).toMatch(
		/not_admitted|meta_tool/,
	);
});
it("requires search for a hidden catalog name", async () => {
	const names = Array.from({ length: 31 }, (_, i) => `example_${i}`);
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		preload: preloaded(names, "config-example", "Example"),
		enabledMcpConfigIds: ["config-example"],
		steps: [wrap(names[0]), done],
	});
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
	expect(toolMessage(turn.seen, 1, "call-1-0")).toContain("not_admitted");
});
it("freezes admission across search and call in one response", async () => {
	discover();
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [
			{ calls: [...search.calls, ...wrap("example_read").calls] },
			done,
		],
	});
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
	expect(toolMessage(turn.seen, 1, "call-1-1")).toContain("not_admitted");
});
it.each(["{broken", "[]", 3, null])(
	"refuses malformed inner arguments %j",
	async (arguments_) => {
		discover();
		const turn = await runTurn(mocks, {
			message: "Read",
			input: mode,
			steps: [search, wrap("example_read", arguments_), done],
		});
		expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
		expect(toolMessage(turn.seen, 2, "call-2-0")).toContain(
			"malformed_arguments",
		);
	},
);
it("returns the normalized create_view schema without another search", async () => {
	discover(["create_view"]);
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [
			search,
			{
				calls: [
					{ name: "get_tool_schema", args: { name: "create_view" } },
				],
			},
			done,
		],
	});
	const schema = JSON.parse(toolMessage(turn.seen, 2, "call-2-0"));
	expect(schema.inputSchema.properties.elements.type).toBe("array");
	expect(schema.inputSchema.required).toContain("elements");
	expect(schema.description).toContain("CRITICAL QUALITY RULES");
	expect(mocks.stub("searchAvailableTools")).toHaveBeenCalledTimes(1);
});
it("keeps the first binding and reports a rediscovery conflict", async () => {
	discover();
	mocks.stub("searchAvailableTools").mockResolvedValueOnce({
		results: preloaded(["example_read"], "config-first", "Example"),
		totalToolsSearched: 1,
		semanticSearchUsed: false,
		durationMs: 1,
	});
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [search, search, wrap("example_read"), done],
	});
	expect(toolMessage(turn.seen, 2, "call-2-0")).toContain("binding_conflict");
	expect(turn.state.advisorToolLoading?.bindingConflicts).toBe(1);
	expect(turn.state.advisorToolLoading?.refusals?.binding_conflict).toBe(1);
	expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
		expect.objectContaining({ mcpConfigId: "config-first" }),
	);
});
it("leaves legacy request shapes unchanged when its patch is off", async () => {
	mocks.off.add("orch-call-tool-v1");
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [done],
	});
	expect(turn.seen[0].tools).not.toContain("call_tool");
});

import { log } from "@temporalio/workflow";
import { planFinalizationRequest } from "../../../../activities/orchestrator/execution/finalization-fit";
import { boundedHistoryV2Decision } from "../../advisor-history-retention";
import { recordAdvisorTurnSummary } from "../../advisor-request-log";
import { maybeCompactConversationHistory } from "../iterative-execution";
import { buildSynthesisHistory } from "../synthesis-history";

it("returns the delegation message schema and exact agent binding", async () => {
	discover([]);
	mocks.stub("searchAvailableAgents").mockResolvedValue({
		results: [
			{
				agentId: "example",
				displayName: "Example",
				description: "Read examples",
				skills: [],
				confidence: 0.9,
			},
		],
		totalAgentsSearched: 1,
		durationMs: 1,
	});
	mocks.stub("executeAgentAsTool").mockResolvedValue({
		output: "Read complete",
		status: "completed",
		durationMs: 1,
	});
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		autonomyLevel: "AUTONOMOUS",
		steps: [
			search,
			{
				calls: [
					{
						name: "get_tool_schema",
						args: { name: "delegate_to_example" },
					},
				],
			},
			wrap("delegate_to_example", { message: "Read example" }),
			wrap("delegate_to_other", { message: "Read example" }),
			done,
		],
	});
	expect(JSON.parse(toolMessage(turn.seen, 2, "call-2-0"))).toMatchObject({
		inputSchema: {
			properties: { message: { type: "string" } },
			required: ["message"],
		},
	});
	expect(mocks.stub("executeAgentAsTool")).toHaveBeenCalledTimes(1);
	expect(mocks.stub("executeAgentAsTool")).toHaveBeenCalledWith(
		expect.objectContaining({ agentId: "example" }),
	);
});
it("blocks a suppressed frame at search, wrapper admission and schema lookup", async () => {
	mocks.stub("listDefaultEnabledMcpServersActivity").mockResolvedValue([
		{
			id: "server-example",
			key: "excalidraw",
			name: "Excalidraw",
			eagerKeywords: ["excalidraw"],
			eagerToolName: "create_view",
			suppressOnEager: ["fabric_create_frame"],
		},
	]);
	mocks.stub("findDefaultMcpConfigActivity").mockResolvedValue({
		configId: "config-example",
		mcpServerKey: "excalidraw",
	});
	mocks
		.stub("fetchToolsFromServerIds")
		.mockResolvedValue(
			preloaded(["create_view"], "config-example", "Excalidraw"),
		);
	discover(["fabric_create_frame"]);
	const turn = await runTurn(mocks, {
		message: "Draw using excalidraw",
		input: { ...mode, surface: "nexus" },
		enabledMcpConfigIds: ["config-example"],
		steps: [
			search,
			wrap("fabric_create_frame", {
				title: "Example",
				blocks: [{ content: "Example frame body".repeat(200) }],
			}),
			{
				calls: [
					{
						name: "get_tool_schema",
						args: { name: "fabric_create_frame" },
					},
				],
			},
			done,
		],
	});
	expect(toolMessage(turn.seen, 1, "call-1-0")).toContain("suppressed");
	expect(toolMessage(turn.seen, 2, "call-2-0")).toContain("suppressed");
	expect(toolMessage(turn.seen, 3, "call-3-0")).toContain("not_admitted");
	expect(
		turn.seen[2].history
			.flatMap((m) => m.toolCalls ?? [])
			.find((c) => c.id === "call-2-0"),
	).toMatchObject({
		name: "call_tool",
		args: {
			arguments: {
				blocks: [
					{ content: expect.stringContaining("content omitted") },
				],
			},
		},
	});
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
});
it("uses the real tool for the approval gate and text", async () => {
	discover(["example_delete_records"]);
	mocks
		.stub("createOrchestratorApprovalRequest")
		.mockResolvedValue({ approvalId: "approval-example" });
	const turn = await runTurn(mocks, {
		message: "Delete records",
		input: mode,
		steps: [search, wrap("example_delete_records", { all: true }), done],
		approval: { approved: true },
	});
	expect(
		mocks.stub("createOrchestratorApprovalRequest"),
	).toHaveBeenCalledWith(
		expect.objectContaining({
			stepDescription: expect.stringContaining(
				"Tool: example_delete_records",
			),
		}),
	);
	expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
		expect.objectContaining({ toolName: "example_delete_records" }),
	);
	expect(
		turn.state.advisorEffectiveCalls?.["call-2-0"]?.riskOptions,
	).toBeDefined();
});
it("scrubs frame blocks inside the retained wrapper and persisted effective call", async () => {
	discover(["fabric_create_frame"], "fabric-ai-server");
	const blocks = [{ content: "<p>Example</p>".repeat(400) }];
	const turn = await runTurn(mocks, {
		message: "Create frame",
		input: mode,
		steps: [
			search,
			wrap("fabric_create_frame", { title: "Example", blocks }),
			done,
		],
	});
	expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
		expect.objectContaining({ args: expect.objectContaining({ blocks }) }),
	);
	const call = turn.seen[2].history
		.flatMap((m) => m.toolCalls ?? [])
		.find((c) => c.id === "call-2-0");
	expect(call).toMatchObject({
		name: "call_tool",
		args: {
			name: "fabric_create_frame",
			arguments: {
				blocks: [
					{ content: expect.stringContaining("content omitted") },
				],
			},
		},
	});
	expect(turn.state.toolCalls.find((c) => c.id === "call-2-0")).toMatchObject(
		{
			name: "fabric_create_frame",
			args: {
				blocks: [
					{ content: expect.stringContaining("content omitted") },
				],
			},
		},
	);
});
it("persists the effective identity on OAuth failure", async () => {
	discover(["GitHub__read"]);
	mocks.stub("executeMcpTool").mockResolvedValue({
		success: false,
		output: { error: "Authorization required" },
		authRequired: true,
		authRequiredConfigId: "config-example",
		authRequiredServerName: "Example",
		durationMs: 1,
	});
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [search, wrap("GitHub__read")],
	});
	expect(turn.state.toolCalls.find((c) => c.id === "call-2-0")).toMatchObject(
		{ name: "GitHub__read", status: "error" },
	);
});
it("persists the real call if execution is interrupted", async () => {
	discover();
	mocks
		.stub("executeMcpTool")
		.mockRejectedValue(new Error("example interrupted"));
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [search, wrap("example_read"), done],
	});
	expect(turn.state.toolCalls.find((c) => c.id === "call-2-0")).toMatchObject(
		{ name: "example_read", status: "error" },
	);
});
it("counts failures by the real tool and excludes empty synthesis lists", async () => {
	discover();
	mocks.stub("executeMcpTool").mockResolvedValue({
		success: false,
		output: { error: "Example failure" },
		durationMs: 1,
	});
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		observeRequests: true,
		steps: [
			search,
			wrap("example_read"),
			wrap("example_read"),
			wrap("example_read"),
			{ answer: "Example findings. ".repeat(40) },
		],
	});
	expect(
		turn.state.toolCalls.filter((c) => c.name === "example_read"),
	).toHaveLength(3);
	expect(turn.seen.at(-1)?.systemPrompt).toContain("example_read");
	recordAdvisorTurnSummary(turn.state);
	const summary = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1] as any;
	expect(summary.toolLoading).toMatchObject({
		callToolCalls: 3,
		toolListChanges: 0,
		executions: expect.arrayContaining([
			{ name: "example_read", count: 3, origin: "discovery" },
		]),
	});
});
it("prunes read results under the effective name and passes identities to compaction", async () => {
	discover();
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: "Example observation. ".repeat(200),
		success: true,
		durationMs: 1,
		readOnly: true,
	});
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [
			search,
			...Array.from({ length: 8 }, () => wrap("example_read")),
			done,
		],
	});
	expect(
		turn.seen.at(-1)?.history.find((m) => m.toolCallId === "call-2-0")
			?.content,
	).toContain("Tool: example_read");
	mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
		summaryText: "Example summary",
		usage: { inputTokens: 1, outputTokens: 1 },
	});
	await maybeCompactConversationHistory(
		turn.state,
		turn.state.iterativeConversationHistory,
		12,
		80,
		100,
		"user-1",
		"org-1",
	);
	expect(
		mocks.stub("compactConversationHistoryActivity"),
	).toHaveBeenCalledWith(
		expect.objectContaining({
			effectiveToolCallPreviews: expect.objectContaining({
				"call-2-0": { name: "example_read", argumentPreview: "{}" },
			}),
		}),
	);
});
it("bounded retention and finalization resolve the recorded identity", async () => {
	discover();
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [search, wrap("example_read", { limit: "100" }), done],
	});
	const history = structuredClone(turn.state.iterativeConversationHistory);
	const output = history.find((m) => m.toolCallId === "call-2-0");
	if (!output) {
		throw new Error("Missing example result");
	}
	output.content = "Example observation. ".repeat(35_000);
	output.toolResultReadOnly = true;
	for (let i = 0; i < 3; i++) {
		history.push(
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{ id: `later-${i}`, name: "example_read", args: {} },
				],
				timestamp: "2026-01-01",
				iteration: 2,
			},
			{
				role: "tool",
				content: "Recent",
				toolCallId: `later-${i}`,
				timestamp: "2026-01-01",
				iteration: 2,
			},
		);
	}
	const decision = boundedHistoryV2Decision({
		request: {
			conversationHistory: history,
			systemPrompt: "Read",
			availableTools: {},
		},
		allowance: 1_000_000,
		spent: 0,
		finalizationReserve: 8000,
		iteration: 10,
		effectiveToolCalls: turn.state.advisorEffectiveCalls,
	});
	expect(
		decision.history.find((m) => m.toolCallId === "call-2-0")?.content,
	).toContain("Tool: example_read");
	const synthesis = buildSynthesisHistory(
		turn.state.iterativeConversationHistory,
		true,
		turn.state.advisorEffectiveCalls,
	);
	expect(
		synthesis
			.flatMap((m) => m.toolCalls ?? [])
			.find((c) => c.id === "call-2-0"),
	).toMatchObject({
		name: "call_tool",
		args: { name: "example_read", arguments: { limit: "100" } },
	});
	const fit = await planFinalizationRequest({
		room: 4000,
		instructions: "Summarize",
		fullMessages: [{ role: "user", content: "Example ".repeat(10_000) }],
		fullMaxOutputTokens: 16384,
		history: turn.state.iterativeConversationHistory,
		effectiveToolCalls: turn.state.advisorEffectiveCalls,
	});
	expect(fit.kind).toBe("bounded");
	expect(JSON.stringify(fit)).toContain("Result of example_read");
	expect(JSON.stringify(fit)).not.toContain("Result of call_tool");
});

it("does not save an unstarted wrapper when cancellation arrives after the model response", async () => {
	let cancelled = false;
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [],
		isCancelled: () => cancelled,
		runIteration: async (req) => {
			cancelled = true;
			return {
				type: "tool_calls",
				toolCalls: [
					{
						id: "example-interrupted",
						name: "call_tool",
						args: {
							name: "fabric_list_project_documents",
							arguments: {},
						},
					},
				],
				offeredToolDefinitions: req.availableTools as never,
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		},
	});
	expect(turn.state.toolCalls).toEqual([]);
	expect(
		turn.state.advisorEffectiveCalls?.["example-interrupted"]?.outcome,
	).toBeUndefined();
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
});
it("bounds search definitions and retains full omitted schemas for lookup", async () => {
	discover();
	mocks.stub("searchAvailableTools").mockResolvedValue({
		results: preloaded(["example_large"], "config-example", "Example").map(
			(t) => ({
				...t,
				inputSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "Example schema description. ".repeat(
								1000,
							),
						},
					},
				},
			}),
		),
		totalToolsSearched: 1,
		semanticSearchUsed: false,
		durationMs: 1,
	});
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [
			search,
			{
				calls: [
					{
						name: "get_tool_schema",
						args: { name: "example_large" },
					},
				],
			},
			done,
		],
	});
	const result = toolMessage(turn.seen, 1, "call-1-0");
	expect(result.length).toBeLessThan(12_000);
	expect(JSON.parse(result).tools[0]).toMatchObject({
		name: "example_large",
		schemaNote: expect.stringContaining("get_tool_schema"),
	});
	expect(
		JSON.parse(toolMessage(turn.seen, 2, "call-2-0")).inputSchema.properties
			.query.description.length,
	).toBeGreaterThan(12_000);
	expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
});
it("refuses duplicate wrapper ids as ambiguous", async () => {
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [],
		runIteration: async (req) =>
			req.iteration === 1
				? {
						type: "tool_calls",
						toolCalls: [0, 1].map(() => ({
							id: "duplicate-example",
							name: "call_tool",
							args: {
								name: "fabric_list_project_documents",
								arguments: {},
							},
						})),
						offeredToolDefinitions: req.availableTools as never,
						usage: { inputTokens: 1, outputTokens: 1 },
					}
				: {
						type: "response",
						content: "Done",
						usage: { inputTokens: 1, outputTokens: 1 },
					},
	});
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
	expect(turn.state.advisorEffectiveCalls?.["duplicate-example"]).toBeNull();
	expect(
		turn.state.iterativeConversationHistory
			.filter((m) => m.role === "tool")
			.map((m) => m.content)
			.join(""),
	).toContain("binding_conflict");
});

it("keeps wrapped skill bodies while pruning ordinary read observations", async () => {
	discover(["load_skill", "example_read"]);
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [
			search,
			{
				calls: [
					...wrap("load_skill", { slug: "example-skill" }).calls,
					...wrap("example_read").calls,
				],
			},
			wrap("example_read"),
			wrap("example_read"),
			wrap("example_read"),
			done,
		],
	});
	expect(toolMessage(turn.seen, 5, "call-2-0")).toContain("numbered heading");
});
it("retains OAuth prefix and Databricks metadata bindings from the offered native set", async () => {
	const binding = {
		integrationId: "integration-example",
		indexNames: ["example.catalog.index"],
	};
	mocks
		.stub("executeMcpTool")
		.mockResolvedValue({ success: true, output: "Read", durationMs: 1 });
	mocks.stub("executeDatabricksKnowledgeSearchActivity").mockResolvedValue({
		summary: "Example knowledge",
		chunks: [],
		failures: [],
		skippedIndexes: [],
	});
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		preloadedResources: {
			mcpTools: [],
			agents: [],
			toolMap: {
				GitHub__read: {
					definition: {
						description: "Read",
						inputSchema: { type: "object", properties: {} },
					},
					configId: "github-connected:example",
					serverName: "GitHub",
				},
				search_databricks_indexes: {
					definition: {
						description: "Search",
						inputSchema: { type: "object", properties: {} },
					},
					configId: "databricks-vector-search:example",
					serverName: "databricks-vector-search",
					dispatchMetadata: binding,
				},
			},
		},
		steps: [
			wrap("GitHub__read"),
			wrap("search_databricks_indexes", { query: "Example" }),
			done,
		],
	});
	expect(turn.state.advisorEffectiveCalls?.["call-1-0"]?.binding).toEqual({
		kind: "oauth",
		prefix: "github__",
	});
	expect(
		mocks.stub("executeDatabricksKnowledgeSearchActivity"),
	).toHaveBeenCalledWith(
		expect.objectContaining({ binding, args: { query: "Example" } }),
	);
	expect(turn.state.advisorEffectiveCalls?.["call-2-0"]?.binding).toEqual({
		kind: "databricks",
		metadata: binding,
	});
});

it("does not admit a prototype setter that the native map would omit", async () => {
	discover(["__proto__"]);
	const turn = await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [search, wrap("__proto__"), done],
	});
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
	expect(toolMessage(turn.seen, 2, "call-2-0")).toContain("not_admitted");
});
it("keeps risk scanning an external get_tool_schema tool with the mode off", async () => {
	discover(["get_tool_schema"]);
	mocks
		.stub("createOrchestratorApprovalRequest")
		.mockResolvedValue({ approvalId: "approval-example" });
	await runTurn(mocks, {
		message: "Read",
		steps: [
			search,
			{
				calls: [
					{
						name: "get_tool_schema",
						args: { name: "delete all records" },
					},
				],
			},
			done,
		],
	});
	expect(mocks.stub("createOrchestratorApprovalRequest")).toHaveBeenCalled();
});
it("keeps reserved meta-tool definitions when an initial MCP name collides", async () => {
	let offered: Record<string, unknown> = {};
	await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [],
		preloadedResources: {
			mcpTools: [],
			agents: [],
			toolMap: {
				call_tool: {
					configId: "config-example",
					serverName: "Example",
					definition: {
						description: "Remote collision",
						inputSchema: { type: "object", properties: {} },
					},
				},
			},
		},
		runIteration: async (req) => {
			offered = req.availableTools;
			return {
				type: "response",
				content: "Done",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		},
	});
	expect(offered.call_tool).toMatchObject({
		description: expect.stringContaining("Run an admitted tool"),
		inputSchema: { required: ["name"] },
	});
});
it("matches a direct risky call's approval assessment", async () => {
	discover(["example_delete_records"]);
	mocks
		.stub("createOrchestratorApprovalRequest")
		.mockResolvedValue({ approvalId: "approval-example" });
	await runTurn(mocks, {
		message: "Delete records",
		input: mode,
		approval: { approved: true },
		steps: [search, wrap("example_delete_records", { all: true }), done],
	});
	const wrapped = mocks
		.stub("createOrchestratorApprovalRequest")
		.mock.calls.at(-1)?.[0];
	mocks.stub("createOrchestratorApprovalRequest").mockClear();
	await runTurn(mocks, {
		message: "Delete records",
		approval: { approved: true },
		steps: [
			search,
			{
				calls: [
					{ name: "example_delete_records", args: { all: true } },
				],
			},
			done,
		],
	});
	expect(
		mocks.stub("createOrchestratorApprovalRequest").mock.calls.at(-1)?.[0],
	).toEqual(wrapped);
});

import { encodeIntegrationToolRef } from "@repo/utils/integration-tool-ref";

it("keeps the integration projection binding and reports search provenance for integration and agent calls", async () => {
	discover([]);
	mocks.stub("searchAvailableAgents").mockResolvedValue({
		results: [
			{
				agentId: "example",
				displayName: "Example",
				description: "Read",
				skills: [],
				confidence: 0.9,
			},
		],
		totalAgentsSearched: 1,
		durationMs: 1,
	});
	const integration = (id: string) => ({
		integrationId: id,
		provider: "EXAMPLE",
		description: "Read examples",
		confidence: 0.9,
		operations: [
			{
				name: "read",
				description: "Read",
				inputSchema: {
					type: "object",
					properties: { limit: { type: "number" } },
				},
			},
		],
	});
	mocks.stub("searchAvailableIntegrations").mockResolvedValue({
		results: [
			integration("integration-first"),
			integration("integration-second"),
		],
		totalIntegrationsSearched: 2,
		durationMs: 1,
	});
	mocks.stub("executeAgentAsTool").mockResolvedValue({
		output: "Read complete",
		status: "completed",
		durationMs: 1,
	});
	const turn = await runTurn(mocks, {
		message: "Find agents and integrations",
		input: {
			...mode,
			enabledAgentIds: ["example"],
			enabledIntegrationIds: ["integration-first", "integration-second"],
		},
		autonomyLevel: "AUTONOMOUS",
		observeRequests: true,
		steps: [
			{
				calls: [
					{
						name: "search_tools",
						args: { query: "Find agents and integrations" },
					},
				],
			},
			{
				calls: [
					{
						name: "get_tool_schema",
						args: { name: "integration__EXAMPLE__read" },
					},
				],
			},
			wrap("integration__EXAMPLE__read", { limit: "100" }),
			wrap("delegate_to_example", { message: "Read" }),
			done,
		],
	});
	expect(mocks.stub("searchAvailableAgents")).toHaveBeenCalledWith(
		expect.objectContaining({ enabledAgentIds: ["example"] }),
	);
	expect(mocks.stub("searchAvailableIntegrations")).toHaveBeenCalledWith(
		expect.objectContaining({
			enabledIntegrationIds: ["integration-first", "integration-second"],
		}),
	);
	expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
		expect.objectContaining({
			toolName: "integration__EXAMPLE__read",
			mcpConfigId: encodeIntegrationToolRef(
				"EXAMPLE",
				"integration-first",
			),
			args: { limit: "100" },
		}),
	);
	expect(JSON.parse(toolMessage(turn.seen, 2, "call-2-0"))).toMatchObject({
		inputSchema: { properties: { limit: { type: "number" } } },
	});
	recordAdvisorTurnSummary(turn.state);
	const summary = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1] as { toolLoading: Record<string, unknown> };
	expect(summary.toolLoading).toMatchObject({
		callToolCalls: 2,
		getToolSchemaCalls: 1,
		toolListChanges: 0,
		executions: expect.arrayContaining([
			{
				name: "integration__EXAMPLE__read",
				count: 1,
				origin: "discovery",
			},
			{ name: "delegate_to_example", count: 1, origin: "discovery" },
		]),
	});
});

it.each(["GitHub__read", "Microsoft_Teams__read", "Slack__read"])(
	"rediscovery of initial OAuth tool %s describes the existing dispatch without a conflict",
	async (name) => {
		discover([name], "oauth:integration:integration-example");
		const turn = await runTurn(mocks, {
			message: "Read",
			input: mode,
			preloadedResources: {
				mcpTools: [],
				agents: [],
				toolMap: {
					[name]: {
						configId: "connected-example",
						serverName: "Example OAuth",
						definition: {
							description: "Read examples",
							inputSchema: { type: "object", properties: {} },
						},
					},
				},
			},
			steps: [search, wrap(name), done],
		});
		const result = JSON.parse(toolMessage(turn.seen, 1, "call-1-0"));
		expect(
			result.tools.map((tool: { name: string }) => tool.name),
		).toContain(name);
		expect(result.refusals).toEqual([]);
		expect(turn.state.advisorToolLoading?.bindingConflicts ?? 0).toBe(0);
		expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: name }),
		);
	},
);
it.each([
	"project_rag_query",
	"fabric_list_meeting_transcripts",
	"search_slack_messages",
	"search_teams_messages",
])(
	"rediscovery of pre-registered loop tool %s has the same binding",
	async (name) => {
		discover([name], "fabric-ai-server");
		const turn = await runTurn(mocks, {
			message: "Read",
			input: mode,
			steps: [search, done],
		});
		const result = JSON.parse(toolMessage(turn.seen, 1, "call-1-0"));
		expect(
			result.tools.map((tool: { name: string }) => tool.name),
		).toContain(name);
		expect(result.refusals).toEqual([]);
		expect(turn.state.advisorToolLoading?.bindingConflicts ?? 0).toBe(0);
	},
);
it("omits the effective-call map from main rounds and retains it on synthesis", async () => {
	discover();
	mocks.stub("executeMcpTool").mockResolvedValue({
		success: false,
		output: { error: "Example failure" },
		durationMs: 1,
	});
	const inputs: Array<{ main: boolean; hasMap: boolean; map: unknown }> = [];
	await runTurn(mocks, {
		message: "Read",
		input: mode,
		onIterationInput: (req) =>
			inputs.push({
				main: Object.keys(req.availableTools).length > 0,
				hasMap: Object.hasOwn(req, "effectiveToolCalls"),
				map: structuredClone(req.effectiveToolCalls),
			}),
		steps: [
			search,
			wrap("example_read", { query: "Example" }),
			wrap("example_read"),
			wrap("example_read"),
			{ answer: "Example findings. ".repeat(40) },
		],
	});
	expect(
		inputs.filter((input) => input.main).map((input) => input.hasMap),
	).toEqual([false, false, false, false]);
	expect(inputs.filter((input) => !input.main)).toEqual([
		expect.objectContaining({
			hasMap: true,
			map: expect.objectContaining({
				"call-2-0": expect.objectContaining({
					name: "example_read",
					args: { query: "Example" },
				}),
			}),
		}),
	]);
});
it("matches native persisted rows when OAuth prevents a later call from starting", async () => {
	const run = async (wrapper: boolean) => {
		mocks.stub("executeMcpTool").mockResolvedValue({
			success: false,
			output: { error: "Authorization required" },
			authRequired: true,
			authRequiredConfigId: "config-example",
			authRequiredServerName: "Example",
			durationMs: 1,
		});
		return runTurn(mocks, {
			message: "Read",
			input: mode,
			enabledMcpConfigIds: ["config-example"],
			preload: preloaded(
				["GitHub__read", "example_pending"],
				"config-example",
				"Example",
			),
			steps: [
				{
					calls: [
						{ name: "GitHub__read", args: {} },
						...(wrapper
							? wrap("example_pending").calls
							: [{ name: "example_pending", args: {} }]),
					],
				},
			],
		});
	};
	const native = await run(false);
	const wrapper = await run(true);
	expect(native.state.toolCalls).toHaveLength(1);
	expect(wrapper.state.toolCalls).toEqual(native.state.toolCalls);
});
it("matches native persisted rows when the per-call breaker stops before a queued call", async () => {
	mocks.off.add("orch-tool-failure-breaker-per-round-v1");
	const run = async (wrapper: boolean) => {
		mocks.stub("executeMcpTool").mockResolvedValue({
			success: false,
			output: { error: "Example failure" },
			durationMs: 1,
		});
		const bad = wrapper
			? wrap("example_read").calls
			: [{ name: "example_read", args: {} }];
		const pending = wrapper
			? wrap("example_pending").calls
			: [{ name: "example_pending", args: {} }];
		return runTurn(mocks, {
			message: "Read",
			input: mode,
			enabledMcpConfigIds: ["config-example"],
			preload: preloaded(
				["example_read", "example_pending"],
				"config-example",
				"Example",
			),
			steps: [
				{ calls: bad },
				{ calls: bad },
				{ calls: [...bad, ...pending] },
			],
		});
	};
	const native = await run(false);
	const wrapper = await run(true);
	expect(native.state.toolCalls).toHaveLength(3);
	expect(wrapper.state.toolCalls).toEqual(native.state.toolCalls);
});
it.each(["omitted", "older_worker"])(
	"admits no initial target when the activity's offered definitions are %s",
	async (metadata) => {
		const turn = await runTurn(mocks, {
			message: "Read",
			input: mode,
			enabledMcpConfigIds: ["config-example"],
			preload: preloaded(
				["example_unoffered"],
				"config-example",
				"Example",
			),
			offeredToolNames:
				metadata === "older_worker"
					? null
					: ["search_tools", "call_tool", "get_tool_schema"],
			steps: [wrap("example_unoffered"), done],
		});
		expect(turn.seen[0].tools).toContain("example_unoffered");
		expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
		expect(toolMessage(turn.seen, 1, "call-1-0")).toContain("not_admitted");
	},
);
const promptCases = [
	{
		name: "focused",
		preload: preloaded(["example_read"], "config-example", "Example"),
		enabledMcpConfigIds: ["config-example"],
	},
	{
		name: "general",
		projectId: null,
		preloadedResources: {
			mcpTools: [
				{
					serverName: "Example MCP",
					configId: "config-example",
					serverId: "server-example",
					tools: [],
				},
			],
			agents: [],
			toolMap: {},
		},
	},
	{
		name: "hidden_catalog",
		preload: preloaded(
			Array.from({ length: 31 }, (_, i) => `example_tool_${i}`),
			"config-example",
			"Example",
		),
		enabledMcpConfigIds: ["config-example"],
	},
];
function sharedPromptText(prompt: string) {
	return prompt
		.split("\n\n")
		.filter((paragraph) => !paragraph.startsWith("Tool loading:"))
		.map((paragraph) =>
			paragraph.startsWith("FOCUSED AGENT — The catalog")
				? paragraph.replace(
						/Before invoking a tool from the catalog,[\s\S]*?(?=Tools NOT in the catalog)/,
						"[Schema loading guidance] ",
					)
				: paragraph,
		)
		.join("\n\n");
}
it.each(promptCases)(
	"preserves unrelated system guidance for a $name agent",
	async (fixture) => {
		const off = await runTurn(mocks, {
			...fixture,
			message: "Read examples",
			steps: [done],
		});
		const on = await runTurn(mocks, {
			...fixture,
			message: "Read examples",
			input: mode,
			steps: [done],
		});
		const before = off.seen[0].systemPrompt;
		const after = on.seen[0].systemPrompt;
		expect(sharedPromptText(after)).toBe(sharedPromptText(before));
		expect(after).toContain("JSON.stringify() the value before passing it");
		expect(after).toContain(
			"When required information like a repository owner",
		);
		expect(after).toContain("call_tool(name, arguments)");
		expect(after).toContain("get_tool_schema(name)");
		if (fixture.name === "focused") {
			expect(after).toContain(
				"These tools are ALREADY available — call them directly.",
			);
		}
		if (fixture.name === "general") {
			expect(after).toContain("Available MCP integrations: Example MCP.");
		}
		if (fixture.name === "hidden_catalog") {
			expect(after).toContain("example_tool_30");
		}
	},
);

it.each([
	"workspace_rag_query",
	"workspace_rag_summarize",
	"list_skills",
	"load_skill",
	"read_skill_file",
])("ignores config labels for the workflow-owned route %s", (name) => {
	const registry = new Map();
	const initial = normalizedEntry(
		name,
		{ description: "Read" },
		toolBinding(name, "config-initial"),
		"initial",
		1,
	);
	expect(admitCallable(registry, name, initial, new Set())).toBeUndefined();
	expect(
		admitCallable(
			registry,
			name,
			normalizedEntry(
				name,
				{ description: "Read" },
				toolBinding(name, "fabric-ai-server"),
				"search",
				1,
			),
			new Set(),
		),
	).toBeUndefined();
	expect(registry.get(name)).toBe(initial);
});
it.each([
	{
		name: "GitHub__read",
		configId: "microsoft-teams-connected:example",
		prefix: "microsoft_teams__",
	},
	{
		name: "Slack__read",
		configId: "github-connected:example",
		prefix: "github__",
	},
	{
		name: "Microsoft_Teams__read",
		configId: "github-connected:example",
		prefix: "microsoft_teams__",
	},
])(
	"normalizes the executor's OAuth route precedence for $name with $configId",
	({ name, configId, prefix }) => {
		expect(toolBinding(name, configId)).toMatchObject({
			kind: "oauth",
			prefix,
		});
	},
);
it("retains a routing config when a discovered OAuth tool has no provider prefix", async () => {
	discover(["example_oauth_read"], "github-connected:example");
	await runTurn(mocks, {
		message: "Read",
		input: mode,
		steps: [search, wrap("example_oauth_read"), done],
	});
	expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
		expect.objectContaining({
			toolName: "example_oauth_read",
			mcpConfigId: "github-connected:example",
		}),
	);
});
it("keeps a different resolved OAuth route as a binding conflict", () => {
	const name = "GitHub__read";
	const registry = new Map();
	admitCallable(
		registry,
		name,
		normalizedEntry(
			name,
			{ description: "Read" },
			toolBinding(name, undefined),
			"initial",
			1,
		),
		new Set(),
	);
	expect(
		admitCallable(
			registry,
			name,
			normalizedEntry(
				name,
				{ description: "Read" },
				toolBinding(name, "microsoft-teams-connected:example"),
				"search",
				1,
			),
			new Set(),
		),
	).toBe("binding_conflict");
});
it("keeps the preloaded Databricks metadata binding when search supplies a config label", () => {
	const name = "search_databricks_indexes";
	const preloadedTool = {
		serverName: "databricks-vector-search",
		configId: "databricks-vector-search:integration-example",
		definition: { name, description: "Search", inputSchema: {} },
		dispatchMetadata: {
			integrationId: "integration-example",
			indexNames: ["example.catalog.index"],
		},
	};
	expect(toolBinding(name, undefined, preloadedTool)).toEqual(
		toolBinding(name, "config-search", preloadedTool),
	);
});
