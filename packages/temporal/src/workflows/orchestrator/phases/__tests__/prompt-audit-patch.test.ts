/**
 * Gate for the orchestrator prompt audit, `patched("orch-prompt-audit-v1")`.
 *
 * Three prompt edits ship behind the one marker, so a history recorded before
 * it replays with the prompt bytes it ran with:
 *   1. the `search_tools` description and its `query` description (the
 *      Excalidraw examples became neutral ones),
 *   2. the FOCUSED AGENT "Tools NOT in the catalog" list (the project tools
 *      are named only when a project is attached),
 *   3. the "Never call a tool with empty args" sentence (now scoped to tools
 *      whose schema lists required parameters).
 *
 * This runs the real `executeIterativePhase` for one iteration with the
 * workflow SDK and the activity proxy mocked, and captures what the
 * `runAgentIteration` activity is sent. Nothing is exported from workflow code
 * for the test. With the marker OFF the strings are compared to literals
 * copied from `iterative-execution.ts` as it was before the audit.
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
		promptAudit: { applied: false },
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	// Only the audit marker is on; every other marker stays off so the loop
	// takes its oldest paths and calls no extra activities.
	patched: vi.fn(
		(id: string) =>
			id === "orch-prompt-audit-v1" && mocks.promptAudit.applied,
	),
	// Every `proxyActivities()` call gets the same name-keyed stubs.
	proxyActivities: vi.fn(
		() =>
			new Proxy(
				{},
				{
					get: (_target, name) => mocks.stub(String(name)),
				},
			),
	),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { executeIterativePhase } from "../iterative-execution";

// ---------------------------------------------------------------------------
// Pre-audit bytes, copied literally from the commit before the change.
// ---------------------------------------------------------------------------

const PRE_AUDIT_SEARCH_TOOLS_DESCRIPTION = `Search for available MCP tools, capabilities, and AI agents that can help with your task.
Use this BEFORE attempting to call any tool you're not familiar with.
Returns matching tools with their inputSchema — always call tools exactly as their schema specifies.

Tips for effective queries:
- Include the service/server name when you know it (e.g., "Excalidraw create diagram", "GitHub create issue", "Jira create ticket")
- Describe the action you want to perform (e.g., "create a card", "send a message", "query data")
- Be specific — "create Excalidraw architecture diagram" finds better results than "create diagram"

IMPORTANT: Always call this when you need to interact with external systems,
databases, project management tools, or any capability you're uncertain about.`;

const PRE_AUDIT_SEARCH_TOOLS_QUERY_DESCRIPTION =
	"Natural language description of what you need to do. Include the service name when known (e.g., 'create Excalidraw diagram', 'GitHub create issue', 'send Slack message')";

const PRE_AUDIT_FOCUSED_AGENT_PREAMBLE = `FOCUSED AGENT — The catalog below lists the MCP tools exposed by Example Server. Their schemas are NOT pre-attached. Before invoking a tool from the catalog, call search_tools with the exact tool name (e.g., search_tools({ query: "<tool_name>" })) to load its inputSchema; the loaded schema persists for the rest of this conversation. Tools NOT in the catalog (search_tools, project_rag_query, fabric_list_meeting_transcripts, search_slack_messages, search_teams_messages, OAuth integrations such as Microsoft Teams or GitHub) are already attached and can be called directly without a search_tools roundtrip.`;

const PRE_AUDIT_EMPTY_ARGS_SENTENCE =
	"Never call a tool with empty args {}.\n\nCRITICAL: NEVER fill tool parameters";

const PROJECT_TOOL_NAMES = [
	"project_rag_query",
	"fabric_list_meeting_transcripts",
	"search_slack_messages",
	"search_teams_messages",
];

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/** More tools than `TOOLS.eagerLoadThreshold`, so the stub catalog is used. */
function preloadedTools(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		toolName: `example_tool_${index}`,
		description: `Example tool ${index}.`,
		inputSchema: { type: "object", properties: {} },
		serverName: "Example Server",
		configId: "cfg-example",
	}));
}

interface RunOptions {
	applied: boolean;
	projectId?: string;
	toolCount: number;
}

async function runFirstIteration({
	applied,
	projectId,
	toolCount,
}: RunOptions) {
	mocks.promptAudit.applied = applied;
	mocks
		.stub("preloadMcpToolsForConfigsActivity")
		.mockResolvedValue(preloadedTools(toolCount));
	mocks.stub("runAgentIteration").mockResolvedValue({
		type: "response",
		content: "done",
		usage: { inputTokens: 1, outputTokens: 1 },
	});

	const state = {
		executionId: "exec-test-1",
		enrichedMessage: "Hello",
		enrichedSystemPrompt: "BASE SYSTEM PROMPT",
		iterationCosts: [],
		toolCalls: [],
		limitSignals: [],
		mcpDefaultToolSignals: [],
		currentIteration: 0,
	};
	const input = {
		userId: "user-1",
		organizationId: "org-1",
		projectId,
		enabledMcpConfigIds: ["cfg-example"],
		history: [],
	};
	const result = await executeIterativePhase(
		state as never,
		input as never,
		{ maxIterations: 3 } as never,
		{} as never,
		vi.fn(),
		vi.fn(),
		() => false,
	);
	expect(result.success).toBe(true);

	const runAgentIteration = mocks.stub("runAgentIteration");
	expect(runAgentIteration).toHaveBeenCalledTimes(1);
	const request = runAgentIteration.mock.calls[0][0] as {
		systemPrompt: string;
		availableTools: {
			search_tools: {
				description: string;
				inputSchema: {
					properties: { query: { description: string } };
				};
			};
		};
	};
	return request;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("orch-prompt-audit-v1 OFF (histories recorded before the audit)", () => {
	it("keeps the Excalidraw search_tools description and query description byte for byte", async () => {
		const { availableTools } = await runFirstIteration({
			applied: false,
			toolCount: 31,
		});
		expect(availableTools.search_tools.description).toBe(
			PRE_AUDIT_SEARCH_TOOLS_DESCRIPTION,
		);
		expect(
			availableTools.search_tools.inputSchema.properties.query
				.description,
		).toBe(PRE_AUDIT_SEARCH_TOOLS_QUERY_DESCRIPTION);
	});

	it("lists the project tools as pre-attached even with no project", async () => {
		const { systemPrompt } = await runFirstIteration({
			applied: false,
			toolCount: 31,
		});
		expect(systemPrompt).toContain(PRE_AUDIT_FOCUSED_AGENT_PREAMBLE);
	});

	it("keeps the unconditional empty-args sentence", async () => {
		const { systemPrompt } = await runFirstIteration({
			applied: false,
			toolCount: 2,
		});
		expect(systemPrompt).toContain(PRE_AUDIT_EMPTY_ARGS_SENTENCE);
	});
});

describe("orch-prompt-audit-v1 ON", () => {
	it("replaces the Excalidraw examples in search_tools with neutral ones", async () => {
		const { availableTools } = await runFirstIteration({
			applied: true,
			toolCount: 31,
		});
		const { description } = availableTools.search_tools;
		const queryDescription =
			availableTools.search_tools.inputSchema.properties.query
				.description;
		expect(description).not.toContain("Excalidraw");
		expect(queryDescription).not.toContain("Excalidraw");
		expect(description).toContain(
			'(e.g., "GitHub create issue", "Jira create ticket", "Slack send message")',
		);
		expect(queryDescription).toContain(
			"(e.g., 'GitHub create issue', 'Jira create ticket', 'send Slack message')",
		);
	});

	it("omits the project tools from the focused-agent list when no project is attached", async () => {
		const { systemPrompt } = await runFirstIteration({
			applied: true,
			toolCount: 31,
		});
		expect(systemPrompt).toContain("FOCUSED AGENT");
		expect(systemPrompt).toContain(
			"Tools NOT in the catalog (search_tools, OAuth",
		);
		for (const name of PROJECT_TOOL_NAMES) {
			expect(systemPrompt).not.toContain(name);
		}
	});

	it("names the project tools in the focused-agent list when a project is attached", async () => {
		const { systemPrompt } = await runFirstIteration({
			applied: true,
			projectId: "project-1",
			toolCount: 31,
		});
		expect(systemPrompt).toContain(
			"Tools NOT in the catalog (search_tools, project_rag_query, fabric_list_meeting_transcripts, search_slack_messages, search_teams_messages, OAuth",
		);
	});

	it("scopes the empty-args rule to tools with required parameters", async () => {
		const { systemPrompt } = await runFirstIteration({
			applied: true,
			toolCount: 2,
		});
		expect(systemPrompt).toContain(
			"Never call a tool with empty args {} when its inputSchema lists required parameters.\n\nCRITICAL:",
		);
		expect(systemPrompt).not.toContain(PRE_AUDIT_EMPTY_ARGS_SENTENCE);
	});
});
