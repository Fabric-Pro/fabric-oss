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
async function scenario(fixture: (typeof scenarios)[number]) {
	installDefaultStubs(mocks);
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
			call("search_tools"),
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
