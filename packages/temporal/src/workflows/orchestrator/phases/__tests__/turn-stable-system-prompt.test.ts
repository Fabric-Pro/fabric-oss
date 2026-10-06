/**
 * One system prompt per turn, `patched("orch-turn-stable-system-prompt-v1")`.
 *
 * Every model call of one Advisor turn must send the same system prompt
 * bytes, or the provider's prompt cache misses on the next call. Before the
 * marker the prompt changed inside a turn in two ways:
 *   - notes sent on the first call only (attached images, the pre-loaded tool
 *     list, the MCP integrations hint), so the prompt shrank on call 2;
 *   - notes that switch on mid-turn (the budget warning, the generated-image
 *     rule, the "Tool usage" block once a tool is discovered).
 * With the marker the fixed notes go on every call and the changing ones go
 * to `turnNotice`, which the activity sends as a trailing host note.
 *
 * Same harness as `advisor-baseline-turns.test.ts`: the real
 * `executeIterativePhase`, the workflow SDK and activity proxy mocked, every
 * marker ON unless a test switches it off, and the model scripted turn by
 * turn. With the marker OFF the prompts are compared with literals copied
 * from `iterative-execution.ts` as it was before the marker.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { DIAGRAM_RENDERING_GUIDANCE } from "../../diagram-rendering";
import {
	fabricDiscovery,
	installDefaultStubs,
	preloaded,
	runTurn,
	type Seen,
	type Step,
} from "./advisor-scenario-harness";

const PATCH = "orch-turn-stable-system-prompt-v1";

const BASE = "You are the project Advisor.";

/** The "Tool usage" block, copied from the pre-marker code (audit marker ON). */
const TOOL_USAGE = `\n\nTool usage: call every tool exactly as its inputSchema specifies. If a parameter is typed as "string" but its description says it expects JSON or an array, JSON.stringify() the value before passing it. Never call a tool with empty args {} when its inputSchema lists required parameters.

CRITICAL: NEVER fill tool parameters with placeholder or example values (e.g. "your-repo-owner", "example-org", "my-repo", "YOUR_VALUE", "<owner>"). When required information like a repository owner, repo name, channel ID, or similar identifier is not explicitly stated by the user:
1. FIRST try to discover it using available tools (e.g. use "search_commits" with the commit SHA to find owner/repo, use "get_authenticated_user" to find the current user's GitHub login, use "list_repositories" to list available repos).
2. Only ask the user if the information cannot be discovered through tool calls.
Never guess or use example values — always use real data from API responses.`;

/** The budget warning, copied from `getBudgetWarning` before the marker. */
function budgetWarning(pct: number): string {
	return `\n\nIMPORTANT - BUDGET WARNING: You are approaching the resource limit (~${pct}% used).
- If you have enough information, provide your final response NOW.
- If you need one more critical tool call, make it, but avoid exploratory calls.
- Do NOT start new lines of investigation.`;
}

const DIAGRAM = `\n\n${DIAGRAM_RENDERING_GUIDANCE}`;

const VISION_IMAGES_NOTE =
	"The user has attached image(s). If the image content is included in the message, look at it and describe, read or analyse it directly to answer";

const IMAGE_URL = "https://example.com/generated/logo.png";

/**
 * 8,200 tokens leaves 200 after the 8,000-token synthesis reserve. The
 * harness bills 15 tokens per call, so calls 13 (180, 90%) and 14 (195, 98%)
 * carry the 85% budget warning and call 15 would go to synthesis.
 */
const BUDGET_MODE = { maxIterations: 30, maxTotalTokens: 8_200 };

/** `count` Slack searches, then an answer. */
function slackSearches(count: number): Step[] {
	return [
		...Array.from({ length: count }, (_, i) => ({
			calls: [
				{
					name: "search_slack_messages",
					args: { query: `launch topic ${i + 1}` },
				},
			],
		})),
		{ answer: "The launch is on the 12th." },
	];
}

function promptsOf(seen: Seen[]): string[] {
	return seen.map((s) => s.systemPrompt);
}

function runAgentIterationRequests(): Array<Record<string, unknown>> {
	return mocks
		.stub("runAgentIteration")
		.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

/** A turn that discovers a tool, then generates two images. */
async function imageTurn() {
	mocks
		.stub("searchAvailableTools")
		.mockResolvedValue(fabricDiscovery(["fabric_generate_image"]));
	mocks.stub("executeMcpTool").mockImplementation(async () => ({
		output: `![Generated Image](${IMAGE_URL})`,
		success: true,
		durationMs: 1,
		cached: false,
	}));
	return runTurn(mocks, {
		message: "Design two logo options.",
		projectId: null,
		steps: [
			{
				calls: [
					{ name: "search_tools", args: { query: "generate image" } },
				],
			},
			{
				calls: [
					{
						name: "fabric_generate_image",
						args: { prompt: "A round logo" },
					},
				],
			},
			{
				calls: [
					{
						name: "fabric_generate_image",
						args: { prompt: "A square logo" },
					},
				],
			},
			{ answer: "## Design 1\nRound.\n\n## Design 2\nSquare." },
		],
	});
}

/** Images attached, one MCP server preloaded at initialization. */
const ATTACHED_AND_MCP = {
	attachedImageUrls: ["uploads/example-org/sketch.png"],
	preloadedResources: {
		userPreferences: null,
		mcpTools: [
			{
				configId: "cfg-tracker",
				serverId: "srv-tracker",
				serverName: "Example Tracker",
				tools: [],
			},
		],
		toolMap: {},
	},
};

beforeEach(() => {
	installDefaultStubs(mocks);
});

describe("orch-turn-stable-system-prompt-v1 ON", () => {
	it("sends one system prompt for every call of the turn, before and after the budget warning", async () => {
		const { seen } = await runTurn(mocks, {
			message: "When is the launch?",
			steps: slackSearches(13),
			modeConfig: BUDGET_MODE,
		});
		expect(seen).toHaveLength(14);
		// Calls 12-14 straddle the warning switching on at call 13.
		const prompts = promptsOf(seen);
		expect(new Set(prompts).size).toBe(1);
		// The base prompt plus the fixed notes; the warning is not in it.
		expect(prompts[0]).toBe(`${BASE}${DIAGRAM}${TOOL_USAGE}`);
		expect(prompts[0]).not.toContain("BUDGET WARNING");

		// The warning arrives as the per-call host note instead.
		expect(seen.slice(0, 12).map((s) => s.turnNotice)).toEqual(
			Array(12).fill(undefined),
		);
		expect(seen[12].turnNotice).toBe(
			`[Host note: this note is from the host for this step of the turn only; it is not part of the user's message.]${budgetWarning(90)}`,
		);
		expect(seen[13].turnNotice).toContain("(~98% used)");

		// The step reduction still follows the warning.
		const steps = runAgentIterationRequests().map(
			(r) => r.maxStepsPerIteration,
		);
		expect(steps.slice(0, 12)).toEqual(Array(12).fill(3));
		expect(steps.slice(12)).toEqual([1, 1]);
	});

	it("keeps the prompt identical once a tool is discovered and images are generated, and sends the image rule as the host note", async () => {
		const { seen, result } = await imageTurn();
		expect(result.success).toBe(true);
		expect(seen).toHaveLength(4);
		const prompts = promptsOf(seen);
		expect(new Set(prompts).size).toBe(1);
		// No project, nothing preloaded: the Tool usage block is decided at
		// turn start because search_tools is attached.
		expect(prompts[0]).toBe(`${BASE}${DIAGRAM}${TOOL_USAGE}`);
		expect(prompts[0]).not.toContain("CRITICAL IMAGE DISPLAY RULE");

		expect(seen[0].turnNotice).toBeUndefined();
		expect(seen[1].turnNotice).toBeUndefined();
		expect(seen[2].turnNotice).toContain(
			"CRITICAL IMAGE DISPLAY RULE: You have generated 1 image(s)",
		);
		expect(seen[3].turnNotice).toContain(
			"CRITICAL IMAGE DISPLAY RULE: You have generated 2 image(s)",
		);
	});

	it("sends the attached-images note and the MCP integrations hint on every call", async () => {
		const { seen } = await runTurn(mocks, {
			message: "What is in the sketch?",
			...ATTACHED_AND_MCP,
			steps: slackSearches(2),
		});
		expect(seen).toHaveLength(3);
		const prompts = promptsOf(seen);
		expect(new Set(prompts).size).toBe(1);
		expect(prompts[0]).toContain(VISION_IMAGES_NOTE);
		expect(prompts[0]).toContain(
			"Available MCP integrations: Example Tracker.",
		);
	});

	it("keeps the pre-loaded tool list of the first call after search_tools discovers more tools", async () => {
		mocks
			.stub("searchAvailableTools")
			.mockResolvedValue(fabricDiscovery(["fabric_generate_image"]));
		const { seen } = await runTurn(mocks, {
			message: "List the open records.",
			preload: preloaded(
				["example_list_records"],
				"cfg-1",
				"Example Server",
			),
			enabledMcpConfigIds: ["cfg-1"],
			steps: [
				{
					calls: [
						{
							name: "search_tools",
							args: { query: "generate image" },
						},
					],
				},
				{
					calls: [
						{ name: "search_slack_messages", args: { query: "x" } },
					],
				},
				{ answer: "Three records are open." },
			],
		});
		expect(seen).toHaveLength(3);
		// search_tools added tools to the request from call 2 on.
		expect(seen[1].tools.length).toBeGreaterThan(seen[0].tools.length);
		const prompts = promptsOf(seen);
		expect(new Set(prompts).size).toBe(1);
		expect(prompts[0]).toContain(
			"FOCUSED AGENT — Pre-loaded tools from Example Server: ",
		);
	});
});

describe("orch-turn-stable-system-prompt-v1 OFF (histories recorded before it)", () => {
	beforeEach(() => {
		mocks.off.add(PATCH);
	});

	it("appends the budget warning to the system prompt with the bytes it sent before", async () => {
		const { seen } = await runTurn(mocks, {
			message: "When is the launch?",
			steps: slackSearches(13),
			modeConfig: BUDGET_MODE,
		});
		expect(seen).toHaveLength(14);
		const plain = `${BASE}${DIAGRAM}${TOOL_USAGE}`;
		const prompts = promptsOf(seen);
		expect(prompts.slice(0, 12)).toEqual(Array(12).fill(plain));
		expect(prompts[12]).toBe(
			`${BASE}${budgetWarning(90)}${DIAGRAM}${TOOL_USAGE}`,
		);
		expect(prompts[13]).toBe(
			`${BASE}${budgetWarning(98)}${DIAGRAM}${TOOL_USAGE}`,
		);
		// The recorded activity input has no turnNotice key at all.
		for (const request of runAgentIterationRequests()) {
			expect(request).not.toHaveProperty("turnNotice");
		}
	});

	it("adds the image rule and the Tool usage block mid-turn, as before", async () => {
		const { seen } = await imageTurn();
		expect(seen).toHaveLength(4);
		const prompts = promptsOf(seen);
		expect(prompts[0]).toBe(`${BASE}${DIAGRAM}`);
		expect(prompts[1]).toBe(`${BASE}${DIAGRAM}${TOOL_USAGE}`);
		const imageRule = (count: number) =>
			`\n\nCRITICAL IMAGE DISPLAY RULE: You have generated ${count} image(s) using fabric_generate_image. For EACH design/variation in your response, use this exact order:
1. Section heading (e.g., "## Design 1: Name")
2. Full text description of the design
3. The image markdown: ![Generated Image](url)

Place each ![Generated Image](url) AFTER the text description, NOT before it. Copy the exact URL from each tool result. Do NOT omit any image URLs.`;
		expect(prompts[2]).toBe(
			`${BASE}${imageRule(1)}${DIAGRAM}${TOOL_USAGE}`,
		);
		expect(prompts[3]).toBe(
			`${BASE}${imageRule(2)}${DIAGRAM}${TOOL_USAGE}`,
		);
		for (const request of runAgentIterationRequests()) {
			expect(request).not.toHaveProperty("turnNotice");
		}
	});

	it("sends the attached-images note and the MCP integrations hint on the first call only", async () => {
		const { seen } = await runTurn(mocks, {
			message: "What is in the sketch?",
			...ATTACHED_AND_MCP,
			steps: slackSearches(2),
		});
		expect(seen).toHaveLength(3);
		const prompts = promptsOf(seen);
		const visionNote =
			"\n\nThe user has attached image(s). If the image content is included in the message, look at it and describe, read or analyse it directly to answer — you do not need a tool to see it. If it is not included, work from the attached description. Use image generation or editing tools (find them with search_tools) only when the user asks you to create a new image or modify the attached one.";
		const mcpHint =
			'\n\nAvailable MCP integrations: Example Tracker. Use search_tools with a query that includes the server name and action (e.g., "Example Tracker create …") to reliably discover the right tools.';
		expect(prompts[0]).toBe(
			`${BASE}${visionNote}${DIAGRAM}${mcpHint}${TOOL_USAGE}`,
		);
		expect(prompts[1]).toBe(`${BASE}${DIAGRAM}${TOOL_USAGE}`);
		expect(prompts[2]).toBe(prompts[1]);
	});
});
