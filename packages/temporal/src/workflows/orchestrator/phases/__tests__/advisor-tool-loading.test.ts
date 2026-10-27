import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const observationMode = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../advisor-request-log", async (original) => {
	const module = await original<typeof import("../../advisor-request-log")>();
	return Object.fromEntries(
		Object.entries(module).map(([name, fn]) => [
			name,
			typeof fn !== "function"
				? fn
				: (...args: unknown[]) => {
						if (observationMode.enabled) {
							return (fn as (...args: unknown[]) => unknown)(
								...args,
							);
						}
						if (name === "beginAdvisorToolSearch") {
							return {
								agentSearch: { ran: false },
								integrationSearch: { ran: false },
							};
						}
					},
		]),
	);
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	PROJECT_FEATURE_GET_DESCRIPTION,
	PROJECT_FEATURE_GET_INPUT_SCHEMA,
} from "../../project-feature-tool-schemas";
import {
	installDefaultStubs,
	preloaded,
	runTurn,
	type Step,
} from "./advisor-scenario-harness";

beforeEach(() => {
	installDefaultStubs(mocks);
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());
const call = (name: string): Step => ({
	calls: [
		{ name, args: name === "search_tools" ? { query: "example" } : {} },
	],
});
const scenarios = [
	{
		name: "30 tools attached",
		names: Array.from({ length: 30 }, (_, i) => `example_tool_${i}`),
		steps: [call("example_tool_0"), { answer: "Done." }],
		discoveries: [],
	},
	{
		name: "31 tools with discovery",
		names: Array.from({ length: 31 }, (_, i) => `example_tool_${i}`),
		steps: [
			call("search_tools"),
			call("example_tool_0"),
			{ answer: "Done." },
		],
		discoveries: [["example_tool_0"]],
	},
	{
		name: "two discoveries",
		names: Array.from({ length: 31 }, (_, i) => `example_tool_${i}`),
		steps: [
			call("search_tools"),
			call("example_tool_0"),
			call("search_tools"),
			call("example_tool_1"),
			{ answer: "Done." },
		],
		discoveries: [["example_tool_0"], ["example_tool_1"]],
	},
	{
		name: "catalog overlaps project tool",
		names: [
			"fabric_get_project_document",
			...Array.from({ length: 30 }, (_, i) => `example_tool_${i}`),
		],
		steps: [
			call("search_tools"),
			call("example_tool_0"),
			{ answer: "Done." },
		],
		discoveries: [["example_tool_0"]],
	},
] satisfies Array<{
	name: string;
	names: string[];
	steps: Step[];
	discoveries: string[][];
}>;
async function scenario(
	fixture: (typeof scenarios)[number],
	legacy = false,
	paging = false,
) {
	installDefaultStubs(mocks);
	// These snapshots pin the earlier tool-loading contract. Keep the unrelated
	// detail-paging schema off; the model-boundary cases below cover both states.
	if (!paging) {
		mocks.off.add("orch-project-feature-detail-paging-v1");
	}
	if (legacy) {
		mocks.off.add("orch-final-initial-tool-catalog-v1");
		mocks.off.add("orch-relevant-tool-search-v1");
	}
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: { ok: true },
		success: true,
		durationMs: 1,
		cached: false,
	});
	const catalog = preloaded(fixture.names, "config-example", "Example");
	for (const names of fixture.discoveries) {
		mocks.stub("searchAvailableTools").mockResolvedValueOnce({
			results: catalog.filter((t) => names.includes(t.toolName)),
			totalToolsSearched: catalog.length,
			semanticSearchUsed: false,
			durationMs: 1,
		});
	}
	return runTurn(mocks, {
		message: "Read the example tools.",
		steps: fixture.steps,
		preload: catalog,
		enabledMcpConfigIds: ["config-example"],
		observeRequests: true,
	});
}
describe("tool loading baseline", () => {
	it.each(scenarios)(
		"pins requests before instrumentation: $name",
		async (fixture) => {
			observationMode.enabled = false;
			const before = await scenario(fixture);
			observationMode.enabled = true;
			const turn = await scenario(fixture);
			expect(turn.seen.map((s) => s.fingerprint)).toEqual(
				before.seen.map((s) => s.fingerprint),
			);
			expect(turn.result).toEqual(before.result);
			expect(
				turn.seen.map((s) =>
					createHash("sha256")
						.update(JSON.stringify(s.fingerprint))
						.digest("hex"),
				),
			).toMatchSnapshot();
		},
	);
});

import { log } from "@temporalio/workflow";
import { recordAdvisorTurnSummary } from "../../advisor-request-log";

it.each(scenarios)("measures tool loading: $name", async (fixture) => {
	const turn = await scenario(fixture);
	recordAdvisorTurnSummary(turn.state);
	const summary = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1] as Record<string, unknown>;
	expect(summary.toolLoading).toBeDefined();
	expect(summary.toolLoading).toMatchSnapshot();
});

it("counts agent and integration searches that produce later dispatched tools", async () => {
	mocks.stub("searchAvailableTools").mockResolvedValue({
		results: [],
		totalToolsSearched: 0,
		semanticSearchUsed: false,
		durationMs: 1,
	});
	mocks.stub("searchAvailableAgents").mockResolvedValue({
		results: [
			{
				agentId: "example",
				displayName: "Example",
				description: "Example agent",
				skills: [],
				confidence: 0.9,
			},
		],
		totalAgentsSearched: 1,
		durationMs: 1,
	});
	mocks.stub("searchAvailableIntegrations").mockResolvedValue({
		results: [
			{
				integrationId: "example",
				provider: "EXAMPLE",
				description: "Example integration",
				confidence: 0.9,
				operations: [
					{
						name: "read",
						description: "Read",
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
		],
		totalIntegrationsSearched: 1,
		durationMs: 1,
	});
	mocks.stub("executeAgentAsTool").mockResolvedValue({
		output: "Example answer",
		status: "completed",
		durationMs: 1,
	});
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: { ok: true },
		success: true,
		durationMs: 1,
		cached: false,
	});
	const turn = await runTurn(mocks, {
		message: "Read example resources",
		observeRequests: true,
		autonomyLevel: "AUTONOMOUS",
		steps: [
			{
				calls: [
					{
						name: "search_tools",
						args: { query: "Find agents and integrations" },
					},
				],
			},
			call("delegate_to_example"),
			call("integration__EXAMPLE__read"),
			{ answer: "Done." },
		],
	});
	recordAdvisorTurnSummary(turn.state);
	const summary = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1] as Record<string, unknown>;
	expect(summary.toolLoading).toMatchObject({
		searchToolsCalls: 1,
		agentSearchRuns: 1,
		agentSearchRunsUsed: 1,
		integrationSearchRuns: 1,
		integrationSearchRunsUsed: 1,
		searches: [
			{
				added: ["delegate_to_example", "integration__EXAMPLE__read"],
				executedAdded: [
					"delegate_to_example",
					"integration__EXAMPLE__read",
				],
				executedAddedCount: 2,
			},
		],
		executions: [
			{ name: "search_tools", count: 1, origin: "initial" },
			{ name: "delegate_to_example", count: 1, origin: "discovery" },
			{
				name: "integration__EXAMPLE__read",
				count: 1,
				origin: "discovery",
			},
		],
	});
	expect(mocks.stub("executeAgentAsTool")).toHaveBeenCalledTimes(1);
	expect(mocks.stub("executeMcpTool")).toHaveBeenCalledTimes(1);
});

it("excludes a suppressed frame tool reintroduced by search after default MCP eager routing", async () => {
	mocks.stub("listDefaultEnabledMcpServersActivity").mockResolvedValue([
		{
			id: "server-example",
			key: "example",
			name: "Example",
			eagerKeywords: ["diagram"],
			eagerToolName: "example_view",
			suppressOnEager: ["fabric_create_frame"],
		},
	]);
	mocks.stub("findDefaultMcpConfigActivity").mockResolvedValue({
		configId: "config-example",
		mcpServerKey: "example",
	});
	mocks
		.stub("fetchToolsFromServerIds")
		.mockResolvedValue(
			preloaded(["example_view"], "config-example", "Example"),
		);
	mocks.stub("searchAvailableTools").mockResolvedValue({
		results: preloaded(["example_read"], "config-example", "Example"),
		totalToolsSearched: 1,
		semanticSearchUsed: false,
		durationMs: 1,
	});
	const turn = await runTurn(mocks, {
		message: "Draw a diagram",
		input: { surface: "nexus" },
		preload: preloaded(
			["fabric_create_frame"],
			"config-example",
			"Example",
		),
		enabledMcpConfigIds: ["config-example"],
		observeRequests: true,
		steps: [call("search_tools"), { answer: "Done." }],
	});
	expect(mocks.stub("findDefaultMcpConfigActivity")).toHaveBeenCalledTimes(1);
	expect(turn.seen[0].tools).not.toContain("fabric_create_frame");
	// The workflow map retains the current rebuild behavior; the activity suppresses it.
	expect(turn.seen[1].tools).toContain("fabric_create_frame");
	expect(turn.state.advisorToolLoading?.previous?.names).not.toContain(
		"fabric_create_frame",
	);
	recordAdvisorTurnSummary(turn.state);
	const summary = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1] as Record<string, unknown>;
	expect(summary.toolLoading).toMatchObject({
		searches: [{ added: ["example_read"] }],
	});
});

function loadingSummary(turn: Awaited<ReturnType<typeof runTurn>>) {
	recordAdvisorTurnSummary(turn.state);
	return vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1]?.toolLoading;
}

it("removes initial project overlap and freezes the catalog through discovery", async () => {
	const turn = await scenario(scenarios[3]);
	expect(loadingSummary(turn)).toMatchObject({
		stubCatalogOverlap: [
			{ round: 1, afterSearch: 0, count: 0 },
			{ round: 1, afterSearch: 1, count: 1 },
		],
		finalStubCatalogOverlap: { count: 1, names: ["example_tool_0"] },
	});
	expect(turn.seen[0].systemPrompt).not.toContain(
		"  - fabric_get_project_document —",
	);
	expect(turn.seen[0].systemPrompt).toContain("  - example_tool_0 —");
	expect(new Set(turn.seen.map((s) => s.systemPrompt)).size).toBe(1);
});

// Activity doubles model connected chat-enabled providers and semantic agent results.
const recallCases = [
	{
		query: "decode VIN 1HGCM82633A004352",
		category: undefined,
		confidences: [0.8, 0.8],
		strategy: "focused_server_fallback",
		agents: true,
		integrations: true,
	},
	{
		query: "decode VIN 1HGCM82633A004352",
		category: undefined,
		confidences: [0.85],
		strategy: "mentioned_server_fallback",
		agents: true,
		integrations: true,
	},
	{
		query: "decode VIN 1HGCM82633A004352",
		category: undefined,
		confidences: [0.99],
		strategy: "semantic_fallback_keyword",
		agents: true,
		integrations: true,
	},
	{
		query: "decode VIN 1HGCM82633A004352",
		category: undefined,
		confidences: [0.8],
		strategy: "semantic",
		agents: false,
		integrations: false,
	},
	{
		query: "decode VIN 1HGCM82633A004352",
		category: undefined,
		confidences: [0.85],
		strategy: "semantic",
		agents: false,
		integrations: false,
	},
	{
		query: "decode VIN 1HGCM82633A004352",
		category: undefined,
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "decode VIN 1HGCM82633A004352",
		category: "data",
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "vehicle lookup make and model",
		category: undefined,
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "search databricks knowledge base for onboarding policy",
		category: undefined,
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "integration__NHTSA_VPIC__decode_vin",
		category: undefined,
		confidences: [1],
		agents: false,
		integrations: true,
		integrationIntent: true,
	},
	{
		query: "reload integration__NHTSA_VPIC__decode_vin for this VIN",
		category: undefined,
		confidences: [1],
		agents: false,
		integrations: true,
		integrationIntent: true,
	},
	{
		query: "review this NDA for risky clauses",
		category: undefined,
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "contract review",
		category: undefined,
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "search agents for contract review",
		category: "agents",
		confidences: [1],
		strategy: "exact_name",
		agents: true,
		integrations: false,
		agentIntent: true,
	},
	{
		query: "example_tool_0",
		category: "agents",
		confidences: [1],
		agents: true,
		integrations: false,
		agentIntent: true,
	},
	{
		query: "example_tool_0",
		category: "automation",
		confidences: [1],
		agents: false,
		integrations: true,
		integrationIntent: true,
	},
	{
		query: "reload delegate_to_legal_reviewer",
		category: undefined,
		confidences: [1],
		agents: true,
		integrations: false,
		agentIntent: true,
	},
	{
		query: "Find integrations for this task",
		category: undefined,
		confidences: [1],
		agents: false,
		integrations: true,
		integrationIntent: true,
	},
	{
		query: "Find an agent for this task",
		category: undefined,
		confidences: [1],
		agents: true,
		integrations: false,
		agentIntent: true,
	},
	{
		query: "example_tool_0 unknown",
		category: undefined,
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "fetch project records",
		category: undefined,
		confidences: [0.2],
		agents: true,
		integrations: true,
	},
	{
		query: "Read project records",
		category: undefined,
		confidences: [],
		agents: true,
		integrations: true,
	},
	{
		query: "Read project records",
		category: undefined,
		confidences: [0.7499],
		agents: true,
		integrations: true,
	},
	{
		query: "Read project records",
		category: undefined,
		confidences: [0.75],
		agents: false,
		integrations: false,
	},
	{
		query: "Read project records",
		category: undefined,
		confidences: [0.2, 0.9],
		agents: false,
		integrations: false,
	},
	{
		query: "search",
		category: undefined,
		confidences: [0.2],
		agents: false,
		integrations: false,
		exact: true,
	},
	{
		query: "  example_tool_0  ",
		category: undefined,
		confidences: [0.2],
		agents: false,
		integrations: false,
		exact: true,
	},
	{
		query: "example_tool_0 fetch",
		category: undefined,
		confidences: [0.2],
		agents: false,
		integrations: false,
		exact: true,
	},
	{
		query: "example_tool_0",
		category: undefined,
		confidences: [0.2],
		strategy: "exact_name",
		agents: false,
		integrations: false,
		exact: true,
	},
] satisfies Array<{
	query: string;
	category?: string;
	confidences: number[];
	strategy?: string;
	agents: boolean;
	integrations: boolean;
	exact?: boolean;
	agentIntent?: boolean;
	integrationIntent?: boolean;
}>;

it.each(recallCases)(
	"preserves secondary discovery for $query ($category, $confidences, $strategy)",
	async (fixture) => {
		const { query, category, confidences, agents, integrations } = fixture;
		mocks.stub("searchAvailableTools").mockResolvedValue({
			results: confidences.map((confidence, i) => ({
				...preloaded(
					[`example_result_${i}`],
					"config-example",
					"Example",
				)[0],
				toolId: `example-result-${i}`,
				confidence,
				matchReason: "Semantic match",
				riskLevel: "low",
				isReadOnly: true,
			})),
			totalToolsSearched: confidences.length,
			semanticSearchUsed: fixture.strategy
				? fixture.strategy === "semantic"
				: true,
			durationMs: 1,
			...(fixture.strategy
				? { telemetry: { strategy: fixture.strategy } }
				: {}),
		});
		mocks.stub("searchAvailableAgents").mockResolvedValue({
			results: [
				{
					agentId: "legal_reviewer",
					displayName: "Legal Reviewer",
					description: "Reviews contracts and NDAs for risky clauses",
					skills: [],
					confidence: 0.8,
				},
			],
			totalAgentsSearched: 1,
			durationMs: 1,
		});
		const databricks = query.includes("databricks");
		const provider = databricks ? "DATABRICKS_VECTOR_SEARCH" : "NHTSA_VPIC";
		const operation = databricks ? "query_index" : "decode_vin";
		mocks.stub("searchAvailableIntegrations").mockResolvedValue({
			results: [
				{
					integrationId: "integration-example",
					provider,
					description: databricks
						? "Search a knowledge base"
						: "Decode vehicle VINs",
					confidence: 0.9,
					operations: [
						{
							name: operation,
							description: "Read",
							inputSchema: { type: "object", properties: {} },
						},
					],
				},
			],
			totalIntegrationsSearched: 1,
			durationMs: 1,
		});
		const turn = await runTurn(mocks, {
			message: query,
			observeRequests: true,
			preload: preloaded(
				[
					"search",
					"fetch",
					"example_tool_0",
					"integration__NHTSA_VPIC__decode_vin",
				],
				"config-example",
				"Example",
			),
			enabledMcpConfigIds: ["config-example"],
			steps: [
				{
					calls: [
						{ name: "search_tools", args: { query, category } },
					],
				},
				{ answer: "Done." },
			],
		});
		expect(loadingSummary(turn)).toMatchObject({
			agentSearchRuns: Number(agents),
			integrationSearchRuns: Number(integrations),
		});
		expect(turn.seen[1].tools.includes("delegate_to_legal_reviewer")).toBe(
			agents,
		);
		// Inspect the tool result too: reload cases started with the integration schema attached.
		const discovery = JSON.parse(
			turn.seen[1].history.find((m) => m.role === "tool" && m.toolCallId)
				?.content ?? "{}",
		);
		expect(
			discovery.tools.some(
				(t: { name: string }) =>
					t.name === `integration__${provider}__${operation}`,
			),
		).toBe(integrations);
		const search = turn.state.advisorToolLoading?.searches[0];
		expect(search?.agentSearch).toMatchObject(
			agents
				? {
						ran: true,
						reason: fixture.agentIntent
							? "explicit_intent"
							: "weak_tool_result",
					}
				: {
						ran: false,
						skipped: fixture.exact
							? "exact_tool_name"
							: "unrelated",
					},
		);
		expect(search?.integrationSearch).toMatchObject(
			integrations
				? {
						ran: true,
						reason: fixture.integrationIntent
							? "explicit_intent"
							: "weak_tool_result",
					}
				: {
						ran: false,
						skipped: fixture.exact
							? "exact_tool_name"
							: "unrelated",
					},
		);
	},
);

// The marker-off path retains the baseline's activity schedule and prompt hashes.
it("retains baseline discovery and catalog bytes with both patches off", async () => {
	const turn = await scenario(scenarios[3], true);
	expect(loadingSummary(turn)).toMatchObject({
		agentSearchRuns: 1,
		integrationSearchRuns: 1,
		agentSearchSkips: 0,
		integrationSearchSkips: 0,
		stubCatalogOverlap: [
			{ round: 1, afterSearch: 0, count: 1 },
			{ round: 1, afterSearch: 1, count: 2 },
		],
	});
	expect(
		turn.seen.map((s) =>
			createHash("sha256")
				.update(JSON.stringify(s.fingerprint))
				.digest("hex"),
		),
	).toEqual([
		"275e44abdf4dd417f41aaebf555d8349f6af76ed80a0df2235301f0a9a29f2ba",
		"ff9453a7402113e81132f1e167372cde5c6734c19cb29ace24c34746c74adbf9",
		"fa922fff261dbf153ff0a0409b83aa6fba06324f471ca14524200ea13060fb1a",
	]);
});

it.each([false, true])(
	"sends the feature-detail paging contract to the model with marker=%s",
	async (paging) => {
		await scenario(scenarios[0], false, paging);
		const request = mocks.stub("runAgentIteration").mock.calls[0][0] as {
			availableTools: Record<string, unknown>;
		};
		const legacy = JSON.parse(
			readFileSync(
				join(__dirname, "fixtures/project-feature-detail-legacy.json"),
				"utf8",
			),
		);
		expect(request.availableTools.fabric_get_project_feature).toEqual(
			paging
				? {
						description: PROJECT_FEATURE_GET_DESCRIPTION,
						inputSchema: PROJECT_FEATURE_GET_INPUT_SCHEMA,
					}
				: legacy,
		);
	},
);
