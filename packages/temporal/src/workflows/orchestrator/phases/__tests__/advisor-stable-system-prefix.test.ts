import { beforeEach, expect, it, vi } from "vitest";

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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { RunAgentIterationInput } from "../../../../activities/orchestrator/execution/run-agent-iteration";
import {
	buildStepContext,
	formatContextForPrompt,
} from "../../context-manager";
import { executeStepWithContext } from "../../step-processing";
import { createInitialState } from "../../types";
import { executeInitializationPhase } from "../initialization";
import { executePlanningPhase } from "../planning";
import { installDefaultStubs, runTurn } from "./advisor-scenario-harness";

const PATCH = "advisor-stable-system-prefix-v1";
const MEMORY = "<orchestrator_memory>Example memory</orchestrator_memory>";
interface Options {
	project?: boolean;
	memory?: string;
	pattern?: string;
	instance?: boolean;
	company?: boolean;
	counts?: number;
}
async function initialize(o: Options = {}) {
	mocks.stub("preloadResourcesActivity").mockResolvedValue({
		userPreferences: null,
		mcpTools: [],
		toolMap: {},
		agents: [],
		workflowGuidance: "Integration guidance",
		...(o.company
			? { companyContext: { hint: "Company context hint" } }
			: {}),
	});
	mocks.stub("loadOrchestratorMemoryActivity").mockResolvedValue({
		preferences: {
			preferences: {},
			recentProjectIds: [],
			recentWorkspaceIds: [],
		},
		memoryContextPrompt: o.memory ?? "",
		relevantEpisodes: [],
		recentEpisodes: [],
	});
	mocks.stub("updateRecentActivityActivity").mockResolvedValue(undefined);
	mocks.stub("initializeLettaMemory").mockResolvedValue(null);
	mocks
		.stub("applyPolicyEnrichment")
		.mockResolvedValue({ systemPromptAdditions: "Policy instructions" });
	mocks
		.stub("applyFabricPatternEnrichment")
		.mockImplementation(async ({ basePrompt }: { basePrompt: string }) => ({
			fabricAvailable: !!o.pattern,
			components: { pattern: o.pattern ? "example-pattern" : null },
			composedPrompt: [basePrompt, o.pattern]
				.filter(Boolean)
				.join("\n\n"),
		}));
	mocks.stub("getProjectMetadataActivity").mockResolvedValue({
		name: "Example project",
		description: "Example description",
		contextCount: o.counts ?? 2,
		documentCount: o.counts ?? 2,
	});
	mocks.stub("loadInstanceMemoryActivity").mockResolvedValue({
		fileCount: 1,
		memoryPrompt: "\n\nInstance skills",
	});
	const input = {
		executionId: "example-exec",
		message: "Example question",
		userId: "example-user",
		organizationId: "example-org",
		executionMode: "balanced",
		companyContextAdvisor: true,
		systemPrompt: "Example persona",
		policyContext: {},
		...(o.project ? { projectId: "example-project" } : {}),
		...(o.instance ? { instanceId: "example-instance" } : {}),
	};
	const result = await executeInitializationPhase(
		createInitialState(input as never),
		input as never,
		vi.fn(),
	);
	expect(result.success).toBe(true);
	if (!result.data) {
		throw new Error("Expected initialization data");
	}
	return result.data;
}
beforeEach(() => {
	installDefaultStubs(mocks);
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it.each([
	{},
	{ project: true },
	{ memory: MEMORY },
	{ pattern: "Pattern text" },
	{ instance: true },
	{ company: true },
	{
		project: true,
		memory: MEMORY,
		pattern: "Pattern text",
		instance: true,
		company: true,
	},
])("preserves the pre-change combined prompt %j", async (options) => {
	expect((await initialize(options)).enrichedSystemPrompt).toMatchSnapshot();
});

it("creates parts only under the marker, preserving legacy bytes", async () => {
	const options = {
		project: true,
		memory: MEMORY,
		pattern: "Pattern text",
		instance: true,
		company: true,
	};
	mocks.off.add(PATCH);
	const legacy = await initialize(options);
	expect(legacy).not.toHaveProperty("systemPromptParts");
	mocks.off.delete(PATCH);
	const current = await initialize(options);
	expect(current.enrichedSystemPrompt).toBe(legacy.enrichedSystemPrompt);
	expect(current.systemPromptParts).toEqual({
		reusable:
			'Example persona\n\nPolicy instructions\n\n<project_context>\nProject: Example project\nThis conversation is attached to the project "Example project". "This project", "the project" or "our project" means it — use it without asking which project.\nDescription: Example description\nUse the project_rag_query tool to search for detailed project context when needed.\n</project_context>\n\nInstance skills\n\nIntegration guidance\n\nCompany context hint',
		variable: `Available contexts: 2, Generated documents: 2\n\nPattern text\n\n${MEMORY}\n\nToday is Tuesday, October 20, 2026.`,
	});
});
it.each(["memory", "date", "pattern", "counts"])(
	"keeps reusable bytes when only %s changes",
	async (change) => {
		const options = {
			project: true,
			memory: MEMORY,
			pattern: "Pattern text",
			instance: true,
			company: true,
		};
		const first = await initialize(options);
		if (change === "date") {
			vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
		}
		const second = await initialize({
			...options,
			...(change === "memory" ? { memory: "Different memory" } : {}),
			...(change === "pattern" ? { pattern: "Different pattern" } : {}),
			...(change === "counts" ? { counts: 9 } : {}),
		});
		expect(first.systemPromptParts).toBeDefined();
		expect(second.systemPromptParts?.reusable).toBe(
			first.systemPromptParts?.reusable,
		);
		expect(second.systemPromptParts?.variable).not.toBe(
			first.systemPromptParts?.variable,
		);
		expect(first.systemPromptParts?.reusable).not.toContain(MEMORY);
		expect(first.systemPromptParts?.variable).toContain(MEMORY);
	},
);

it("moves images after the reusable loop tail and retains the complete legacy activity input", async () => {
	const data = await initialize({ memory: MEMORY });
	let first: RunAgentIterationInput | undefined;
	for (const image of [false, true]) {
		const runScenario = async (
			systemPromptParts?: typeof data.systemPromptParts,
		) => {
			const requests: RunAgentIterationInput[] = [];
			await runTurn(mocks, {
				message: "Example question",
				projectId: null,
				attachedImageUrls: image
					? ["https://example.com/image.png"]
					: [],
				state: {
					enrichedSystemPrompt: data.enrichedSystemPrompt,
					...(systemPromptParts ? { systemPromptParts } : {}),
				},
				steps: [
					{
						calls: [
							{
								name: "search_tools",
								args: { query: "example" },
							},
						],
					},
					{ answer: "Example answer" },
				],
				onIterationInput: (req) => requests.push(structuredClone(req)),
			});
			return requests;
		};
		const legacyRequests = await runScenario();
		const requests = await runScenario(data.systemPromptParts);
		expect(requests.map((req) => req.systemPrompt)).toEqual(
			legacyRequests.map((req) => req.systemPrompt),
		);
		expect(requests).toHaveLength(2);
		for (const req of requests) {
			expect(req.systemPromptParts).toBeDefined();
			expect(req.systemPromptParts?.reusable).toContain("mermaid");
			expect(req.systemPromptParts?.reusable).not.toContain(MEMORY);
			expect(req.systemPromptParts?.reusable).not.toContain(
				"attached image",
			);
			expect(req.systemPromptParts?.variable).toContain(MEMORY);
			expect(
				req.systemPromptParts?.variable.includes("attached image"),
			).toBe(image);
		}
		expect(requests[1].systemPromptParts).toEqual(
			requests[0].systemPromptParts,
		);
		if (first) {
			expect(requests[0].systemPromptParts?.reusable).toBe(
				first.systemPromptParts?.reusable,
			);
		}
		first = requests[0];
	}
});
it.each(["resume", "continue-as-new"])(
	"uses the legacy path for %s state without parts",
	async (kind) => {
		const requests: RunAgentIterationInput[] = [];
		await runTurn(mocks, {
			message: "Example question",
			// The workflow restores these fields with Object.assign; older state
			// has the combined prompt but no separately collected parts.
			state: {
				enrichedSystemPrompt:
					"Example restored persona\n\nExample restored memory",
				currentIteration: kind === "resume" ? 1 : 2,
			},
			steps: [{ answer: "Example answer" }],
			onIterationInput: (req) => requests.push(req),
		});
		expect(requests[0]).not.toHaveProperty("systemPromptParts");
		expect(requests[0].systemPrompt).toContain(
			"Example restored persona\n\nExample restored memory",
		);
	},
);

it("keeps Planner routing, step prompts and the context manager on the full legacy string", async () => {
	const data = await initialize({
		project: true,
		memory: MEMORY,
		pattern: "Pattern text",
		instance: true,
		company: true,
	});
	const input = {
		executionId: "example-exec",
		message: "Example question",
		userId: "example-user",
		organizationId: "example-org",
		executionMode: "save",
		history: [],
	} as never;
	const state = createInitialState(input);
	Object.assign(state, data);
	mocks
		.stub("analyzeAndRoute")
		.mockRejectedValue(new Error("Example routing stop after capture"));
	await executePlanningPhase(state, input, {} as never, vi.fn(), vi.fn());
	expect(mocks.stub("analyzeAndRoute").mock.calls[0][0].memoryContext).toBe(
		data.enrichedSystemPrompt,
	);
	const step = {
		id: "example-step",
		description: "Example step",
		executor: "example-agent",
	} as never;
	state.taskPlan = { steps: [step] } as never;
	const context = buildStepContext(state, 0, { message: "Example question" });
	expect(context.systemPrompt).toBe(data.enrichedSystemPrompt);
	mocks
		.stub("executeStep")
		.mockResolvedValue({ status: "complete", response: "Example answer" });
	expect(
		(
			await executeStepWithContext(
				state,
				input,
				step,
				0,
				{} as never,
				{} as never,
			)
		).success,
	).toBe(true);
	expect(mocks.stub("executeStep").mock.calls[0][0].systemPrompt).toBe(
		`${data.enrichedSystemPrompt}\n\n${formatContextForPrompt(context)}`,
	);
	expect(state.enrichedSystemPrompt).toBe(data.enrichedSystemPrompt);
});

it("omits split parts on synthesis even when the main loop has them", async () => {
	const requests: RunAgentIterationInput[] = [];
	await runTurn(mocks, {
		message: "Example question",
		state: {
			systemPromptParts: {
				reusable: "Example reusable",
				variable: MEMORY,
			},
		},
		modeConfig: { maxIterations: 2 },
		steps: [
			{ calls: [{ name: "search_tools", args: { query: "example" } }] },
			{ answer: "Example complete answer with details." },
		],
		onIterationInput: (req) => requests.push(structuredClone(req)),
	});
	expect(requests[0].systemPromptParts).toBeDefined();
	expect(requests.length).toBeGreaterThan(1);
	for (const req of requests.slice(1)) {
		expect(req).not.toHaveProperty("systemPromptParts");
		expect(req.systemPrompt).not.toContain("Example reusable");
	}
});

it("carries only existing parts through continuation and restores old state without reconstruction", () => {
	const execution = readFileSync(join(__dirname, "../execution.ts"), "utf8");
	const workflow = readFileSync(join(__dirname, "../../index.ts"), "utf8");
	expect(execution).toMatch(
		/\.\.\.\(state.systemPromptParts\s*\?\s*{ systemPromptParts: state.systemPromptParts }\s*:\s*{}\)/,
	);
	expect(workflow).toContain("Object.assign(state, input.resumeState)");
	expect(workflow).toContain(
		"state.systemPromptParts = initResult.data?.systemPromptParts",
	);
});

it("keeps transient service-down guidance in variable state and returns before a model call", async () => {
	mocks.stub("listDefaultEnabledMcpServersActivity").mockResolvedValue([
		{
			key: "example-renderer",
			name: "Example renderer",
			eagerKeywords: ["example-renderer"],
			eagerToolName: "example_render",
			suppressOnEager: ["fabric_create_frame"],
		},
	]);
	mocks.stub("findDefaultMcpConfigActivity").mockResolvedValue(null);
	const parts = {
		reusable: "Example reusable",
		variable: "Example variable",
	};
	const { state, result } = await runTurn(mocks, {
		message: "Draw with example-renderer",
		input: { surface: "nexus" },
		state: { systemPromptParts: { ...parts } },
		steps: [],
	});
	expect(result.success).toBe(true);
	expect(mocks.stub("runAgentIteration")).not.toHaveBeenCalled();
	expect(state.systemPromptParts?.reusable).toBe(parts.reusable);
	expect(state.systemPromptParts?.variable).toContain(
		"DEFAULT MCP SERVICE DOWN",
	);
	expect(state.enrichedSystemPrompt).toBe(
		`You are the project Advisor.\n\n${state.systemPromptParts?.variable.slice(parts.variable.length + 2)}`,
	);
});
