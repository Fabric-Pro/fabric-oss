import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@temporalio/workflow", () => ({ log: { info: vi.fn() } }));

import { createRequestFingerprint } from "@repo/ai/lib/request-observation";
import { log } from "@temporalio/workflow";
import {
	recordAdvisorFailureRequests,
	recordAdvisorHistoryChange,
	recordAdvisorMainRound,
	recordAdvisorRequests,
	recordAdvisorTurnSummary,
} from "../../advisor-request-log";
import { createInitialState } from "../../types";

const state = () =>
	createInitialState({
		executionId: "example",
		message: "example",
		history: [],
		userId: "example",
		executionMode: "balanced",
	});
beforeEach(() => vi.clearAllMocks());
it("logs each physical request and compares the previous shape across results", () => {
	const s = state();
	const fingerprint = createRequestFingerprint({
		modelId: "example",
		route: "example",
		prompt: [{ role: "user", content: "PRIVATE_SENTINEL" }],
	});
	const one = {
		iteration: 1,
		activityAttempt: 1,
		request: 1,
		estimatedInputTokens: 20,
		fingerprint,
		cacheReadTokens: 0,
	};
	s.advisorHistoryChanges = ["pruned"];
	recordAdvisorRequests(s, { requests: [one, { ...one, request: 2 }] });
	recordAdvisorRequests(s, {
		requests: [
			{
				...one,
				iteration: 2,
				fingerprint: {
					...fingerprint,
					messages: [{ role: "user", hash: "changed", bytes: 10 }],
				},
			},
		],
	});
	expect(log.info).toHaveBeenCalledTimes(3);
	expect(vi.mocked(log.info).mock.calls[0][1]).toMatchObject({
		firstChangedPosition: { section: "initial" },
		historyChanges: ["pruned"],
		cacheReadTokens: 0,
	});
	expect(vi.mocked(log.info).mock.calls[1][1]).toMatchObject({
		firstChangedPosition: null,
		historyChanges: ["none"],
	});
	expect(vi.mocked(log.info).mock.calls[2][1]).toMatchObject({
		firstChangedPosition: { section: "messages", index: 0 },
	});
	expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(
		"PRIVATE_SENTINEL",
	);
});
it("tolerates missing observations and keeps the previous request", () => {
	const s = state();
	recordAdvisorRequests(s, {});
	expect(log.info).not.toHaveBeenCalled();
	expect(s.advisorPreviousRequest).toBeUndefined();
});

it("reads diagnostics from a failed activity without changing its refusal details", () => {
	const s = state();
	const fingerprint = createRequestFingerprint({
		modelId: "example",
		route: "example",
		prompt: [],
	});
	const reading = { kind: "EXPLORATION", room: 0 };
	const error = {
		cause: {
			details: [
				reading,
				{
					advisorRequestDiagnosticsV1: {
						requests: [
							{
								iteration: 1,
								activityAttempt: 1,
								request: 1,
								estimatedInputTokens: 1,
								fingerprint,
								cacheReadTokens: 0,
							},
						],
					},
				},
			],
		},
	};
	recordAdvisorFailureRequests(s, error);
	expect(log.info).toHaveBeenCalledTimes(1);
	expect(error.cause.details[0]).toBe(reading);
	expect(s.advisorPreviousRequest).toEqual(fingerprint);
});

it("bounds and labels a long request log while retaining the full fingerprint", () => {
	const s = state();
	s.advisorBoundedHistoryEnabled = true;
	const fingerprint = createRequestFingerprint({
		modelId: "example",
		route: "example",
		prompt: Array.from({ length: 1000 }, () => ({
			role: "user",
			content: "PRIVATE_SENTINEL",
		})),
	});
	recordAdvisorRequests(s, {
		requests: [
			{
				iteration: 1,
				activityAttempt: 1,
				request: 1,
				estimatedInputTokens: 100,
				fingerprint,
				cacheReadTokens: 50,
			},
		],
	});
	const line = vi.mocked(log.info).mock.calls[0][1];
	expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThan(2048);
	expect(line).toMatchObject({
		historyRetention: "bounded-v1",
		messageCount: 1000,
		messagesHash: expect.any(String),
		toolsHash: expect.any(String),
		systemHash: expect.any(String),
		cacheReadTokens: 50,
	});
	expect(line).not.toHaveProperty("fingerprint");
	expect(s.advisorPreviousRequest?.messages).toHaveLength(1000);
});
it("summarizes a turn with known token totals and history mutation counts", () => {
	const s = state();
	s.advisorBoundedHistoryEnabled = true;
	const fingerprint = createRequestFingerprint({
		modelId: "example",
		route: "example",
		prompt: [],
	});
	recordAdvisorMainRound(s);
	recordAdvisorMainRound(s);
	recordAdvisorHistoryChange(s, "pruned");
	recordAdvisorHistoryChange(s, "compacted");
	recordAdvisorRequests(s, {
		requests: [
			{
				iteration: 1,
				activityAttempt: 1,
				request: 1,
				estimatedInputTokens: 100,
				fingerprint,
				cacheReadTokens: 10,
				cacheWriteTokens: 20,
				uncachedInputTokens: 30,
				outputTokens: 4,
			},
			{
				iteration: 2,
				activityAttempt: 1,
				request: 1,
				estimatedInputTokens: 100,
				fingerprint,
				cacheReadTokens: 11,
				cacheWriteTokens: 21,
				uncachedInputTokens: 31,
				outputTokens: 5,
			},
		],
	});
	s.status = "completed";
	recordAdvisorTurnSummary(s);
	recordAdvisorTurnSummary(s);
	const lines = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary");
	expect(lines).toHaveLength(1);
	expect(lines[0][1]).toMatchObject({
		historyRetention: "bounded-v1",
		mainRounds: 2,
		physicalRequests: 2,
		cacheReadTokens: 21,
		cacheWriteTokens: 41,
		uncachedInputTokens: 61,
		outputTokens: 9,
		compactions: 1,
		prunes: 1,
		answerFinished: true,
	});
});
it.each([
	"round_limit",
	"time_limit",
	"token_budget",
	"token_allowance",
] as const)(
	"labels an age-arm %s summary without inventing unknown token totals",
	(kind) => {
		const s = state();
		s.status = "completed";
		s.budgetStop = { kind } as never;
		recordAdvisorTurnSummary(s);
		const line = vi.mocked(log.info).mock.calls[0][1];
		expect(line).toMatchObject({
			historyRetention: "age",
			stopKind:
				kind === "round_limit"
					? "round"
					: kind === "time_limit"
						? "time"
						: kind === "token_budget"
							? "token"
							: "allowance",
			answerFinished: false,
		});
		expect(line).not.toHaveProperty("cacheReadTokens", 0);
		expect(JSON.stringify(line)).not.toContain("PRIVATE_SENTINEL");
	},
);

it.each([
	[50, 100, 0.5],
	[1, 100, 0.25],
	[300, 100, 2],
	[undefined, 100, 1],
	[100, 0, 1],
])(
	"calibrates from recorded counts %s/%s",
	(inputTokens, estimatedInputTokens, factor) => {
		const s = state();
		s.advisorBoundedHistoryV2Enabled = true;
		recordAdvisorRequests(s, {
			requests: [
				{
					iteration: 1,
					activityAttempt: 1,
					request: 1,
					estimatedInputTokens,
					inputTokens,
					cacheReadTokens: 40,
					outputTokens: 2,
					fingerprint: createRequestFingerprint({
						modelId: "example",
						route: "example",
						prompt: [],
					}),
				},
			],
		});
		expect(s.advisorCalibrationFactor).toBe(factor);
		expect(s.advisorPreviousInputTokens).toBe(inputTokens);
		expect(s.advisorPreviousCacheReadTokens).toBe(40);
		if (inputTokens !== undefined) {
			expect(vi.mocked(log.info).mock.calls.at(-1)?.[1]).toMatchObject({
				chargedInputTokens:
					inputTokens -
					Math.min(inputTokens, 40) +
					Math.ceil(Math.min(inputTokens, 40) * 0.1),
				calibrationFactor: factor,
				historyRetention: "bounded-v2",
			});
		}
	},
);

it("reports charged requests and a ledger-backed turn total while retaining raw cache metrics", () => {
	const s = state();
	s.advisorBoundedHistoryV2Enabled = true;
	const fingerprint = createRequestFingerprint({
		modelId: "example",
		route: "example",
		prompt: [],
	});
	recordAdvisorRequests(s, {
		requests: [
			{
				iteration: 1,
				activityAttempt: 1,
				request: 1,
				estimatedInputTokens: 1_000,
				inputTokens: 1_000,
				cacheReadTokens: 900,
				cacheWriteTokens: 10,
				outputTokens: 10,
				fingerprint,
			},
			{
				iteration: 1,
				activityAttempt: 1,
				request: 2,
				estimatedInputTokens: 100,
				inputTokens: 200,
				outputTokens: 2,
				fingerprint,
			},
		],
	});
	expect(vi.mocked(log.info).mock.calls[0][1]).toMatchObject({
		chargedInputTokens: 190,
		cacheReadTokens: 900,
		cacheWriteTokens: 10,
	});
	expect(vi.mocked(log.info).mock.calls[1][1]).toMatchObject({
		chargedInputTokens: 200,
	});
	s.turnLedger = {
		allowance: 500_000,
		finalizationReserve: 8_000,
		measured: 450,
		outstanding: 50,
		enforcement: "ENFORCED",
	};
	recordAdvisorTurnSummary(s);
	expect(vi.mocked(log.info).mock.calls.at(-1)?.[1]).toMatchObject({
		chargedInputTokens: 390,
		chargedTokens: 500,
		cacheReadTokens: 900,
		historyRetention: "bounded-v2",
		calibrationFactor: 2,
	});
});

it("attaches the chosen v2 decision and sizing to request and turn summaries", () => {
	const s = state();
	s.advisorBoundedHistoryV2Enabled = true;
	s.advisorHistoryDecision = {
		iteration: 4,
		action: "reset",
		reason: "allowance",
		beforeTokens: 60_000,
		afterTokens: 30_000,
		reservation: 101_024,
		afterReservation: 40_000,
		room: 60_000,
		tokensFreed: 30_000,
		bytesFreed: 100_000,
	};
	recordAdvisorRequests(s, {
		requests: [
			{
				iteration: 4,
				activityAttempt: 1,
				request: 1,
				estimatedInputTokens: 40_000,
				fingerprint: createRequestFingerprint({
					modelId: "example",
					route: "example",
					prompt: [],
				}),
			},
		],
	});
	recordAdvisorTurnSummary(s);
	for (const [, details] of vi.mocked(log.info).mock.calls) {
		expect(details).toMatchObject({
			historyDecision: s.advisorHistoryDecision,
		});
	}
});

import {
	beginAdvisorToolSearch,
	finishAdvisorToolSearch,
	recordAdvisorToolCatalog,
	recordAdvisorToolExecution,
	recordAdvisorToolSet,
} from "../../advisor-request-log";

const toolSummary = (s: ReturnType<typeof state>) => {
	recordAdvisorTurnSummary(s);
	return vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1]?.toolLoading;
};
it("counts later reuse per search and excludes earlier executions and repeated additions", () => {
	const s = state();
	recordAdvisorToolSet(s, { search_tools: {} }, 1);
	const search = beginAdvisorToolSearch(s, 1);
	search.agentSearch.ran = true;
	search.integrationSearch.ran = true;
	finishAdvisorToolSearch(
		s,
		search,
		{ search_tools: {} },
		{ search_tools: {}, delegate_to_example: {}, integration__EXAMPLE: {} },
		["delegate_to_example"],
		["integration__EXAMPLE"],
	);
	recordAdvisorToolExecution(s, "delegate_to_example");
	recordAdvisorToolExecution(s, "delegate_to_example");
	recordAdvisorToolExecution(s, "integration__EXAMPLE");
	const second = beginAdvisorToolSearch(s, 2);
	second.agentSearch.ran = true;
	second.integrationSearch.ran = true;
	const tools = {
		search_tools: {},
		delegate_to_example: {},
		integration__EXAMPLE: {},
	};
	finishAdvisorToolSearch(
		s,
		second,
		tools,
		tools,
		["delegate_to_example"],
		["integration__EXAMPLE"],
	);
	expect(toolSummary(s)).toMatchObject({
		searchToolsCalls: 2,
		agentSearchRuns: 2,
		agentSearchRunsUsed: 1,
		integrationSearchRuns: 2,
		integrationSearchRunsUsed: 1,
		searches: [
			{
				added: ["delegate_to_example", "integration__EXAMPLE"],
				executedAddedCount: 2,
			},
			{ added: [], executedAddedCount: 0 },
		],
		executions: [
			{ name: "delegate_to_example", count: 2, origin: "discovery" },
			{ name: "integration__EXAMPLE", count: 1, origin: "discovery" },
		],
	});
});
it("attributes skill changes, reordered lists, and old results from recorded evidence", () => {
	const s = state();
	const observe = (
		names: string[],
		skills?: string[],
		iteration = 1,
		withNames = true,
	) =>
		recordAdvisorRequests(s, {
			requests: [
				{
					iteration,
					activityAttempt: 1,
					request: 1,
					estimatedInputTokens: 1,
					toolNames: withNames ? names : undefined,
					skillToolNames: skills,
					fingerprint: createRequestFingerprint({
						modelId: "example",
						route: "example",
						tools: names.map((name) => ({ name })),
					}),
				},
			],
		});
	observe(["example"]);
	observe(["example", "load_skill"], ["load_skill"], 2);
	observe(["example"], [], 3);
	observe(["other", "example"], [], 4);
	observe(["example", "other"], [], 5);
	observe(["other"], undefined, 6, false);
	expect(toolSummary(s)).toMatchObject({
		distinctToolLists: 5,
		changes: [
			{ round: 2, causes: ["skill_tool_change"] },
			{ round: 3, causes: ["skill_tool_change"] },
			{ round: 4, causes: ["other"] },
			{ round: 5, causes: ["other"] },
			{ round: 6, causes: ["other"] },
		],
	});
});
it("keeps search and skill causes together and retains distinct-list counts across retries", () => {
	const s = state();
	recordAdvisorToolCatalog(s, ["example_discovered"]);
	recordAdvisorToolSet(s, { search_tools: {} }, 1);
	const observe = (names: string[], skills: string[], iteration: number) =>
		recordAdvisorRequests(s, {
			requests: [
				{
					iteration,
					activityAttempt: 1,
					request: 1,
					estimatedInputTokens: 1,
					toolNames: names,
					skillToolNames: skills,
					fingerprint: createRequestFingerprint({
						modelId: "example",
						route: "example",
						tools: names.map((name) => ({ name })),
					}),
				},
			],
		});
	observe(["search_tools"], [], 1);
	const search = beginAdvisorToolSearch(s, 1);
	finishAdvisorToolSearch(
		s,
		search,
		{ search_tools: {} },
		{ search_tools: {}, example_discovered: {} },
		[],
		[],
	);
	observe(
		["search_tools", "example_discovered", "load_skill"],
		["load_skill"],
		2,
	);
	observe(
		["search_tools", "example_discovered", "load_skill"],
		["load_skill"],
		2,
	);
	expect(toolSummary(s)).toMatchObject({
		distinctToolLists: 2,
		changes: [{ round: 2, causes: ["search_tools", "skill_tool_change"] }],
	});
});

it("distinguishes schema replacement from a name addition using physical tool fingerprints", () => {
	const s = state();
	const before = {
		example: {
			inputSchema: {
				type: "object",
				properties: { first: { type: "string" } },
			},
		},
	};
	const after = {
		example: {
			inputSchema: {
				type: "object",
				properties: { second: { type: "number" } },
			},
		},
	};
	recordAdvisorToolSet(s, before, 1);
	const observe = (tools: typeof before | typeof after, iteration: number) =>
		recordAdvisorRequests(s, {
			requests: [
				{
					iteration,
					activityAttempt: 1,
					request: 1,
					estimatedInputTokens: 1,
					toolNames: ["example"],
					fingerprint: createRequestFingerprint({
						modelId: "example",
						route: "example",
						tools: [{ name: "example", ...tools.example }],
					}),
				},
			],
		});
	observe(before, 1);
	const search = beginAdvisorToolSearch(s, 1);
	finishAdvisorToolSearch(s, search, before, after, [], []);
	observe(after, 2);
	expect(toolSummary(s)).toMatchObject({
		distinctToolLists: 2,
		toolListChanges: 1,
		changes: [{ round: 2, causes: ["search_tools"] }],
		searches: [{ added: [], executedAddedCount: 0 }],
	});
	expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(
		"inputSchema",
	);
});

it.each([0, 1, 10])(
	"keeps a 20-search summary below 16 KiB with capped name samples and %s executions per search",
	(executionsPerSearch) => {
		const s = state();
		const catalog = Array.from(
			{ length: 200 },
			(_, index) =>
				`example_catalog_tool_${String(index).padStart(3, "0")}_${"x".repeat(39)}`,
		);
		expect(catalog[0]).toHaveLength(64);
		recordAdvisorToolCatalog(s, catalog);
		let tools: Record<string, unknown> = { search_tools: {} };
		recordAdvisorToolSet(s, tools, 1);
		const observe = (sent: Record<string, unknown>, iteration: number) =>
			recordAdvisorRequests(s, {
				requests: [
					{
						iteration,
						activityAttempt: 1,
						request: 1,
						estimatedInputTokens: 1,
						toolNames: Object.keys(sent),
						fingerprint: createRequestFingerprint({
							modelId: "example",
							route: "example",
							tools: Object.keys(sent).map((name) => ({ name })),
						}),
					},
				],
			});
		observe(tools, 1);
		for (let index = 0; index < 20; index++) {
			const search = beginAdvisorToolSearch(s, index + 1);
			const added = catalog.slice(index * 10, (index + 1) * 10);
			const after = {
				...tools,
				...Object.fromEntries(added.map((name) => [name, {}])),
			};
			finishAdvisorToolSearch(s, search, tools, after, [], []);
			observe(after, index + 2);
			for (const name of added.slice(0, executionsPerSearch)) {
				recordAdvisorToolExecution(s, name);
			}
			tools = after;
		}
		const summary = toolSummary(s) as {
			toolListChanges: number;
			searches: Array<{
				added: string[];
				addedCount: number;
				addedMore: number;
				executedAdded: string[];
				executedAddedCount: number;
				executedAddedMore: number;
			}>;
			executions: unknown[];
			executionsMore: number;
			executedToolCalls: number;
			stubCatalogOverlap: Array<{ count: number; names?: string[] }>;
			finalStubCatalogOverlap: {
				count: number;
				names: string[];
				more: number;
			};
		};
		const line = vi
			.mocked(log.info)
			.mock.calls.filter(
				([event]) => event === "advisor.turn_cache_summary",
			)
			.at(-1);
		const bytes = Buffer.byteLength(JSON.stringify(line), "utf8");
		expect(bytes).toBeLessThan(16 * 1024);
		expect(summary.stubCatalogOverlap.map((entry) => entry.count)).toEqual(
			Array.from({ length: 21 }, (_, i) => i * 10),
		);
		expect(
			summary.stubCatalogOverlap.some(
				(entry) => entry.names !== undefined,
			),
		).toBe(false);
		expect(summary.finalStubCatalogOverlap).toEqual({
			count: 200,
			names: catalog.slice(0, 50),
			more: 150,
		});
		expect(summary.toolListChanges).toBe(20);
		expect(summary.executedToolCalls).toBe(20 * executionsPerSearch);
		expect(summary.executions).toHaveLength(
			Math.min(20 * executionsPerSearch, 50),
		);
		expect(summary.executionsMore).toBe(
			Math.max(0, 20 * executionsPerSearch - 50),
		);
		expect(summary.searches).toHaveLength(20);
		for (const search of summary.searches) {
			expect(search.addedCount).toBe(10);
			expect(search.executedAddedCount).toBe(executionsPerSearch);
			expect(search.added.length + search.addedMore).toBe(10);
			expect(search.executedAdded.length + search.executedAddedMore).toBe(
				executionsPerSearch,
			);
		}
		const sampledNames =
			summary.executions.length +
			summary.searches.reduce(
				(sum, search) =>
					sum + search.added.length + search.executedAdded.length,
				0,
			);
		expect(sampledNames).toBeLessThanOrEqual(50);
		// Collection remains complete so summary sampling cannot alter later attribution.
		expect(
			s.advisorToolLoading?.searches.flatMap((search) => search.added),
		).toHaveLength(200);
	},
);

it("filters suppressed names from both diagnostic maps without mutating either map", () => {
	const s = state();
	recordAdvisorToolCatalog(s, ["fabric_create_frame", "example_read"]);
	recordAdvisorToolSet(s, { search_tools: {} }, 1);
	const before = {
		search_tools: {},
		fabric_create_frame: { description: "Before" },
	};
	const after = {
		search_tools: {},
		fabric_create_frame: { description: "After" },
		example_read: {},
	};
	const beforeJson = JSON.stringify(before);
	const afterJson = JSON.stringify(after);
	const search = beginAdvisorToolSearch(s, 1);
	finishAdvisorToolSearch(
		s,
		search,
		before,
		after,
		[],
		[],
		new Set(["fabric_create_frame"]),
	);
	expect(search.added).toEqual(["example_read"]);
	expect(search.changed).toEqual(["example_read"]);
	expect(JSON.stringify(before)).toBe(beforeJson);
	expect(JSON.stringify(after)).toBe(afterJson);
	expect(toolSummary(s)).toMatchObject({
		stubCatalogOverlap: [{ count: 0 }, { count: 1 }],
		finalStubCatalogOverlap: { count: 1, names: ["example_read"], more: 0 },
	});
});

it("logs first-request tool/schema and reusable hashes in the turn summary", () => {
	const summaryFor = (tools: unknown[]) => {
		const s = state();
		recordAdvisorRequests(s, {
			reusableSystemHash: "0123456789abcdef",
			requests: [
				{
					iteration: 1,
					activityAttempt: 1,
					request: 1,
					estimatedInputTokens: 10,
					fingerprint: createRequestFingerprint({
						modelId: "example-model",
						route: "example-route",
						prompt: [],
						tools,
					}),
				},
			],
		});
		// Later synthesis has no reusable prompt and must not replace the main hash.
		recordAdvisorRequests(s, { requests: [] });
		recordAdvisorTurnSummary(s);
		return vi
			.mocked(log.info)
			.mock.calls.filter(
				([event]) => event === "advisor.turn_cache_summary",
			)
			.at(-1)?.[1] as Record<string, unknown>;
	};
	const tool = {
		name: "example_tool",
		inputSchema: {
			type: "object",
			properties: { value: { type: "string" } },
		},
	};
	const first = summaryFor([tool]);
	expect(first.reusableSystemHash).toBe("0123456789abcdef");
	expect(first.toolsHash).toMatch(/^[a-f0-9]{8}$/);
	expect(summaryFor([{ ...tool, name: "other_tool" }]).toolsHash).not.toBe(
		first.toolsHash,
	);
	expect(
		summaryFor([{ ...tool, inputSchema: { type: "object" } }]).toolsHash,
	).not.toBe(first.toolsHash);
	expect(
		summaryFor([tool, { ...tool, name: "other_tool" }]).toolsHash,
	).not.toBe(summaryFor([{ ...tool, name: "other_tool" }, tool]).toolsHash);
	expect(
		JSON.stringify(
			vi
				.mocked(log.info)
				.mock.calls.filter(
					([event]) => event === "advisor.turn_cache_summary",
				),
		),
	).not.toContain("example_tool");
});
