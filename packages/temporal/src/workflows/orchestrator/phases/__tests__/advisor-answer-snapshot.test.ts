import { createHash } from "node:crypto";
import { createRequestObservationMiddleware } from "@repo/ai/lib/request-observation";
import { log } from "@temporalio/workflow";
import { wrapLanguageModel } from "ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { snapshotAdvisorAnswerActivity } from "../../../../activities/orchestrator/execution/snapshot-advisor-answer";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	return {
		off: new Set<string>(),
		stub: (name: string) => {
			let fn = activities.get(name);
			if (!fn) {
				fn = vi.fn();
				activities.set(name, fn);
			}
			return fn;
		},
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		registry: vi.fn(),
		bundle: vi.fn(),
		streamText: vi.fn(),
		selection: vi.fn(),
	};
});
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: (id: string) => !mocks.off.has(id),
	proxyActivities: () =>
		new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	workflowInfo: () => ({
		startTime: new Date(Date.now()),
		runId: "example-run",
		unsafe: { isReplaying: false },
	}),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));
vi.mock("@repo/ai", () => ({
	streamText: mocks.streamText,
	tool: (v: unknown) => v,
	jsonSchema: (v: unknown) => v,
	isStepCount: (v: unknown) => v,
}));
vi.mock("@repo/ai/skills", async (original) => ({
	...(await original<typeof import("@repo/ai/skills")>()),
	listAvailableSkills: mocks.registry,
	loadSkillBundle: mocks.bundle,
}));
vi.mock("@temporalio/activity", async (original) => ({
	...(await original<Record<string, unknown>>()),
	heartbeat: vi.fn(),
}));
vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));
vi.mock("../../../../activities/orchestrator/utils", () => ({
	getAiModelWithSelection: mocks.selection,
}));

import { runAgentIteration } from "../../../../activities/orchestrator/execution/run-agent-iteration";
import { recordAdvisorTurnSummary } from "../../advisor-request-log";
import { installDefaultStubs, runTurn } from "./advisor-scenario-harness";

const skill = {
	slug: "example-skill",
	name: "Example",
	description: "Format reports.",
	version: 1,
	category: null,
	tags: [],
	files: [],
};
const modelSnapshot = {
	provider: "OPENAI_DIRECT",
	modelString: "example-model",
	canonicalName: "example-model",
	configId: "example-config",
	configSource: "organization",
	routeHash: "example-route",
};
let skillRounds = 1;
let unusedArguments = false;
let histories: unknown[];
let sent: Array<{ system: unknown; tools: string[] }>;
beforeEach(() => {
	installDefaultStubs(mocks);
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	sent = [];
	histories = [];
	skillRounds = 1;
	unusedArguments = false;
	mocks.registry.mockReset().mockResolvedValue([skill]);
	const physical = wrapLanguageModel({
		model: {
			specificationVersion: "v4",
			provider: "example",
			modelId: "example-model",
			supportedUrls: {},
			doGenerate: async () => ({
				content: [],
				warnings: [],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: {
						total: 10,
						noCache: 10,
						cacheRead: 0,
						cacheWrite: 0,
					},
					outputTokens: { total: 5, text: 5, reasoning: 0 },
				},
			}),
			doStream: async () => {
				throw new Error("unused");
			},
		},
		middleware: createRequestObservationMiddleware(),
	});
	mocks.selection.mockReset().mockImplementation(async () => ({
		model: physical,
		...modelSnapshot,
		answerSnapshot: () => modelSnapshot,
		planSpentApiBilling: () => undefined,
	}));
	mocks
		.stub("snapshotAdvisorAnswerActivity")
		.mockImplementation(snapshotAdvisorAnswerActivity);
	mocks.streamText.mockReset().mockImplementation((request) => {
		histories.push(request.messages);
		sent.push({
			system: request.instructions,
			tools: Object.keys(request.tools ?? {}),
		});
		const requestNumber = sent.length;
		const generated = request.model.doGenerate({
			prompt: [
				{ role: "system", content: request.instructions },
				...request.messages,
			],
			tools: Object.entries(request.tools ?? {}).map(([name, def]) => ({
				type: "function",
				name,
				...(def as object),
			})),
		});
		return {
			stream: (async function* () {
				await generated;
				if (requestNumber <= skillRounds) {
					yield {
						type: "tool-call",
						toolCallId: `example-call-${requestNumber}`,
						toolName: "load_skill",
						input: {
							slug: "example-skill",
							...(unusedArguments
								? { ignored: requestNumber }
								: {}),
						},
					};
				} else {
					yield { type: "text-delta", text: "The report is ready." };
				}
			})(),
			usage: generated.then(() => ({ inputTokens: 10, outputTokens: 5 })),
			finishReason: Promise.resolve(
				requestNumber <= skillRounds ? "tool-calls" : "stop",
			),
		};
	});
});
afterEach(() => vi.useRealTimers());
async function answer() {
	const turn = await runTurn(mocks, {
		message: "Format the report.",
		steps: [],
		runIteration: runAgentIteration,
	});
	recordAdvisorTurnSummary(turn.state);
	const summary = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.turn_cache_summary")
		.at(-1)?.[1] as {
		toolLoading: {
			distinctToolLists: number;
			changes: Array<{ causes: string[] }>;
		};
	};
	return { turn, metrics: summary.toolLoading };
}
it.each(["added", "removed", "edited"])(
	"keeps skill request bytes when the registry is %s between rounds",
	async (change) => {
		mocks.registry
			.mockResolvedValueOnce([skill])
			.mockResolvedValue(
				change === "removed"
					? []
					: change === "added"
						? [skill, { ...skill, slug: "example-second" }]
						: [{ ...skill, description: "New description." }],
			);
		const { metrics } = await answer();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual(sent[0]);
		expect(metrics.distinctToolLists).toBe(1);
		expect(metrics.changes.flatMap((c) => c.causes)).not.toContain(
			"skill_tool_change",
		);
	},
);
it("keeps the skills block when the next registry read would fail", async () => {
	mocks.registry
		.mockResolvedValueOnce([skill])
		.mockRejectedValue(new Error("registry unavailable"));
	const { metrics } = await answer();
	expect(sent[1]).toEqual(sent[0]);
	expect(metrics.distinctToolLists).toBe(1);
});
it("continues without skill bindings when the snapshot records registry failure", async () => {
	mocks.registry.mockRejectedValue(new Error("registry unavailable"));
	const { turn, metrics } = await answer();
	expect(sent.flatMap((r) => r.tools)).not.toContain("load_skill");
	expect(JSON.stringify(sent.map((r) => r.system))).not.toContain(
		"Available Skills",
	);
	expect(turn.result.success).toBe(true);
	expect(turn.state.advisorAnswerSnapshot?.skills).toMatchObject({
		status: "unavailable",
		failure: "load_failed",
	});
	expect(metrics.distinctToolLists).toBe(1);
});
it("passes one recorded model route to the rounds", async () => {
	await answer();
	const routes = mocks.selection.mock.calls.map((args) => args[6]);
	expect(routes).toEqual([undefined, modelSnapshot, modelSnapshot]);
	expect(mocks.stub("snapshotAdvisorAnswerActivity")).toHaveBeenCalledTimes(
		1,
	);
});
it("retains the legacy activity inputs when the answer-snapshot marker is absent", async () => {
	mocks.off.add("orch-advisor-answer-snapshot-v1");
	await answer();
	expect(mocks.stub("snapshotAdvisorAnswerActivity")).not.toHaveBeenCalled();
	expect(mocks.selection.mock.calls.map((args) => args[6])).toEqual([
		undefined,
		undefined,
	]);
});
it("records snapshot hashes without full skill bodies", async () => {
	const { turn } = await answer();
	const stored = (
		turn.state as unknown as { advisorAnswerSnapshot?: unknown }
	).advisorAnswerSnapshot;
	expect(stored).toMatchObject({
		version: 1,
		skills: {
			status: "loaded",
			descriptors: [
				{
					slug: "example-skill",
					version: 1,
					hash: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			],
		},
		model: modelSnapshot,
	});
	expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(12_000);
	expect(
		createHash("sha256").update(JSON.stringify(stored)).digest("hex"),
	).toHaveLength(64);
});

it.each(["model_unavailable", "plan_account_rotation"])(
	"records a forced %s cause in tool-loading metrics",
	async (cause) => {
		const original = mocks.selection.getMockImplementation();
		if (!original) {
			throw new Error("No selection fixture");
		}
		let resolutions = 0;
		mocks.selection.mockImplementation(async (...args) => {
			const selected = await original(...args);
			// Snapshot selection, round 1, round 2.
			if (++resolutions === 3) {
				return {
					...selected,
					answerSnapshot: () => ({
						...modelSnapshot,
						modelString: "example-replacement",
					}),
					answerRouteChanges: () => [
						{
							cause,
							reason:
								cause === "model_unavailable"
									? "provider_refused"
									: "account_ineligible",
							from: "0123456789ab",
							to: "abcdef012345",
						},
					],
				};
			}
			return selected;
		});
		const { turn, metrics } = await answer();
		expect(metrics).toMatchObject({
			distinctToolLists: 1,
			routeChanges: [{ cause, from: "0123456789ab", to: "abcdef012345" }],
		});
		expect(turn.state.advisorAnswerSnapshot?.model.modelString).toBe(
			"example-replacement",
		);
	},
);

it.each([false, true])(
	"keeps first-loaded skill instructions after edits (ignored arguments=%s)",
	async (extra) => {
		skillRounds = 2;
		unusedArguments = extra;
		const { executeSkillToolActivity } = await import(
			"../../../../activities/skill-tool-execution"
		);
		mocks
			.stub("executeSkillToolActivity")
			.mockImplementation(executeSkillToolActivity);
		mocks.bundle
			.mockReset()
			.mockResolvedValueOnce({
				...skill,
				skillMd: "First recorded instructions.",
			})
			.mockResolvedValue({
				...skill,
				version: 2,
				skillMd: "Edited instructions.",
			});
		const { turn, metrics } = await answer();
		expect(turn.result.success).toBe(true);
		expect(histories).toHaveLength(3);
		expect(JSON.stringify(histories[2])).toContain(
			"First recorded instructions.",
		);
		expect(JSON.stringify(histories[2])).not.toContain(
			"Edited instructions.",
		);
		expect(metrics.distinctToolLists).toBe(1);
	},
);

it("bounds the recorded registry payload when descriptors are too large", async () => {
	mocks.registry.mockResolvedValue([
		{ ...skill, description: "x".repeat(200_000) },
	]);
	const { turn } = await answer();
	expect(turn.state.advisorAnswerSnapshot?.skills).toMatchObject({
		status: "unavailable",
		failure: "too_large",
		descriptors: [],
		systemBlock: null,
		tools: {},
	});
	expect(
		Buffer.byteLength(JSON.stringify(turn.state.advisorAnswerSnapshot)),
	).toBeLessThan(12_000);
});

it("refuses a revoked skill at execution while retaining its offered schema", async () => {
	skillRounds = 2;
	const { executeSkillToolActivity } = await import(
		"../../../../activities/skill-tool-execution"
	);
	mocks
		.stub("executeSkillToolActivity")
		.mockImplementation(executeSkillToolActivity);
	let reads = 0;
	mocks.bundle
		.mockReset()
		.mockImplementation(async (_slug, _ctx, options) => {
			if (++reads > 1 && options?.fresh) {
				throw new Error("Skill not accessible");
			}
			return { ...skill, skillMd: "First recorded instructions." };
		});
	const { turn, metrics } = await answer();
	expect(turn.result.success).toBe(true);
	expect(histories).toHaveLength(3);
	expect(JSON.stringify(histories[2])).toContain("Skill not accessible");
	expect(sent.map((r) => r.tools.includes("load_skill"))).toEqual([
		true,
		true,
		true,
	]);
	expect(metrics.distinctToolLists).toBe(1);
});

it("retains the recorded route when an older round result omits snapshot updates", async () => {
	const turn = await runTurn(mocks, {
		message: "Format the report.",
		steps: [],
		runIteration: async (req) => {
			const { answerUpdate: _ignored, ...legacyResult } =
				await runAgentIteration(req);
			return legacyResult;
		},
	});
	expect(turn.result.success).toBe(true);
	expect(turn.state.advisorAnswerSnapshot?.model).toEqual(modelSnapshot);
});

it("records a forced route change when the next dispatch is refused by the budget", async () => {
	const { ApplicationFailure } = await import("@temporalio/common");
	const { createInitialState } = await import("../../types");
	const { recordAdvisorFailureRequests } = await import(
		"../../advisor-request-log"
	);
	const initial = (
		await snapshotAdvisorAnswerActivity({
			userId: "example-user",
			organizationId: "example-org",
			executionId: "example-execution",
		})
	).snapshot;
	const selected = await mocks.selection();
	const changed = { ...modelSnapshot, modelString: "example-replacement" };
	mocks.selection.mockResolvedValue({
		...selected,
		answerSnapshot: () => changed,
		answerRouteChanges: () => [
			{
				cause: "model_unavailable",
				reason: "configuration_unavailable",
				from: "0123456789ab",
				to: "abcdef012345",
			},
		],
	});
	const originalDetail = { kind: "EXPLORATION", room: 0, needed: 100 };
	const refusal = ApplicationFailure.create({
		type: "TurnBudgetExhausted",
		message: "No room",
		nonRetryable: true,
		details: [originalDetail],
	});
	mocks.streamText.mockImplementation(() => {
		throw refusal;
	});
	await expect(
		runAgentIteration({
			answerSnapshot: initial,
			conversationHistory: [
				{ role: "user", content: "Example", timestamp: "2026-01-01" },
			],
			systemPrompt: "Example",
			availableTools: {},
			userId: "example-user",
			organizationId: "example-org",
			executionId: "example-execution",
			iteration: 1,
		}),
	).rejects.toBe(refusal);
	const state = createInitialState({
		history: [],
		executionMode: "balanced",
		executionId: "example-execution",
		message: "Example",
		userId: "example-user",
		organizationId: "example-org",
	});
	state.advisorAnswerSnapshot = initial;
	recordAdvisorFailureRequests(state, refusal);
	expect(refusal.details?.[0]).toEqual(originalDetail);
	expect(state.advisorAnswerSnapshot?.model.modelString).toBe(
		"example-replacement",
	);
	expect(state.advisorToolLoading?.routeChanges).toMatchObject([
		{ cause: "model_unavailable" },
	]);
});

it.each(["cancel", "turn-stop", "budget-stop"])(
	"propagates a snapshot %s before starting model work",
	async (kind) => {
		const { CancelledFailure, ApplicationFailure } = await import(
			"@temporalio/common"
		);
		const failure =
			kind === "cancel"
				? new CancelledFailure("Example cancellation")
				: ApplicationFailure.create({
						type:
							kind === "turn-stop"
								? "TurnNotDispatchable"
								: "TurnBudgetExhausted",
						message: "Example stop",
						nonRetryable: true,
					});
		mocks.stub("snapshotAdvisorAnswerActivity").mockRejectedValue(failure);
		await expect(answer()).rejects.toBe(failure);
		expect(mocks.selection).not.toHaveBeenCalled();
		expect(mocks.streamText).not.toHaveBeenCalled();
	},
);
