import {
	BOUNDED_HISTORY_PATCH,
	BOUNDED_HISTORY_V2_PATCH,
	boundedHistoryEnabled,
	WEIGHTED_ALLOWANCE_PATCH,
} from "../../advisor-history-retention";
import type { WorkflowState } from "../../types";

/**
 * Shared harness for the Advisor scenario tests: synthetic fixtures, a fake
 * activity layer, and a scripted model turn run through the real
 * `executeIterativePhase`. Each test file mocks `@temporalio/workflow` and the
 * activity proxy itself (vi.mock is per file) and passes its mocks in.
 */

import { createRequestFingerprint } from "@repo/ai/lib/request-observation";
import type { ModelRequestObservation } from "@repo/ai/lib/request-shape";
import { ApplicationFailure } from "@temporalio/common";
import { vi } from "vitest";
import { getFabricAiTools } from "../../../../activities/orchestrator/tools/fabric-ai-tools";
import { normalizeAdvisorToolDefinition } from "../../advisor-tool-definition";
import type { IterativeTurnOptions } from "../../turn-contract";
import { createInitialState, type IterativeMessage } from "../../types";
import { executeIterativePhase } from "../iterative-execution";

export interface ScenarioMocks {
	stub: (name: string) => ReturnType<typeof vi.fn>;
	resetAll: () => void;
	/** Markers a test switches off to replay an older history. */
	off: Set<string>;
}

// ---------------------------------------------------------------------------
// Fixtures — synthetic only.
// ---------------------------------------------------------------------------

/** A 30,000-character requirements document, one numbered line per 30 chars. */
export const LONG_DOC_BODY = Array.from(
	{ length: 1000 },
	(_, i) => `Line ${String(i + 1).padStart(5, "0")}: requirement.\n`,
).join("");
export const SHORT_DOC_BODY = "The launch checklist has three steps.";

/**
 * The shape `getProjectDocument` returns (activities/shared/
 * project-document-reads.ts), with its defaults: 15,000 characters per page,
 * at most 40,000.
 */
function documentPage(args: Record<string, unknown>) {
	const body = args.document === "doc-long" ? LONG_DOC_BODY : SHORT_DOC_BODY;
	const offset = typeof args.offset === "number" ? args.offset : 0;
	const maxLength = Math.min(
		typeof args.maxLength === "number" ? args.maxLength : 15_000,
		40_000,
	);
	const content = body.slice(offset, offset + maxLength);
	const truncated = offset + content.length < body.length;
	return {
		id: String(args.document),
		title: "Example PRD",
		type: "PRD",
		status: "COMPLETED",
		version: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		contentAvailable: true,
		content,
		contentLength: body.length,
		offset,
		returnedLength: content.length,
		truncated,
		...(truncated ? { nextOffset: offset + content.length } : {}),
	};
}

export const FILE_TEXT =
	"### src/flags.ts (42 bytes)\n```\nexport const launchFlag = true;\n```";

/**
 * `searchProjectSlackMessages`' result (`SearchProjectSlackMessagesResult`),
 * large enough to be prunable.
 */
export function slackResult(text: string) {
	return {
		messages: Array.from({ length: 6 }, (_, i) => ({
			id: `msg-${i}`,
			content: `${text} — message ${i} from the launch channel about the release plan.`,
			from: `user-${i}`,
			channelId: "C-launch",
			channelName: "launch",
			permalink: `https://example.com/slack/launch/${i}`,
		})),
		totalCount: 6,
		query: "launch",
		searchedChannels: ["launch"],
		errors: [],
	};
}

export const SKILL_BODY = `Example skill. ${"Render every report section with a numbered heading. ".repeat(40)}`;

/**
 * A user MCP tool's page whose continuation fields serialize last, as an MCP
 * client returns it: a `CallToolResult` with the page as JSON text.
 */
const RECORDS_PAGE = {
	content: [
		{
			type: "text",
			text: JSON.stringify({
				records: Array.from({ length: 400 }, (_, i) => ({
					id: `rec-${i}`,
					name: `Example record ${i}`,
				})),
				hasMore: true,
				nextCursor: "cursor-page-2",
			}),
		},
	],
	isError: false,
};

export function preloaded(
	names: string[],
	configId: string,
	serverName: string,
) {
	return names.map((toolName) => ({
		toolName,
		description: `${toolName} tool.`,
		inputSchema: { type: "object", properties: {} },
		serverName,
		configId,
	}));
}

/**
 * `searchAvailableTools`' answer (`SearchAvailableToolsOutput`) when the
 * Fabric catalog's keyword step matches: the real definitions, under the
 * virtual `fabric-ai-server` config the loop routes to the catalog adapter.
 */
export function fabricDiscovery(names: string[]) {
	const catalog = new Map(getFabricAiTools().map((t) => [t.name, t]));
	return {
		results: names.map((name) => ({
			toolId: name,
			serverName: "Fabric AI",
			toolName: name,
			description: catalog.get(name)?.description ?? "",
			confidence: 0.9,
			matchReason: "keyword match",
			riskLevel: "low",
			isReadOnly: true,
			configId: "fabric-ai-server",
			inputSchema: catalog.get(name)?.inputSchema,
		})),
		totalToolsSearched: catalog.size,
		semanticSearchUsed: false,
		durationMs: 2,
	};
}

/** The model's discovery step before any repository read. */
export const DISCOVER_REPO_TOOLS: Step = {
	calls: [
		{
			name: "search_tools",
			args: { query: "read repository files and tree" },
		},
	],
};

function ok(output: unknown) {
	return { output, success: true, durationMs: 1, cached: false };
}

async function fakeMcp(req: {
	toolName: string;
	args: Record<string, unknown>;
}) {
	switch (req.toolName) {
		case "fabric_get_project_document":
			return ok(documentPage(req.args));
		case "code_file_get":
			return ok(FILE_TEXT);
		case "example_list_records":
			return ok(RECORDS_PAGE);
		default:
			return {
				output: { error: `unexpected tool ${req.toolName}` },
				success: false,
				durationMs: 1,
				cached: false,
			};
	}
}

// ---------------------------------------------------------------------------
// Scripted turn.
// ---------------------------------------------------------------------------

export type Call = { name: string; args: Record<string, unknown> };
export type Step =
	| {
			calls: Call[];
			ledger?: Record<string, unknown>;
			requests?: import("@repo/ai/lib/request-shape").ModelRequestObservation[];
			usage?: { inputTokens: number; outputTokens: number };
	  }
	| {
			answer: string;
			/** The token-ledger reading the round returns (ledgered turns). */
			ledger?: Record<string, unknown>;
			requests?: import("@repo/ai/lib/request-shape").ModelRequestObservation[];
			usage?: { inputTokens: number; outputTokens: number };
	  }
	/**
	 * The turn's token ledger refuses this round's request: the activity
	 * fails with `TurnBudgetExhausted` carrying the attempt kind and `ledger`
	 * as the reading.
	 */
	| {
			refuse: "EXPLORATION" | "FINALIZATION";
			ledger: Record<string, unknown>;
	  }
	| ((history: IterativeMessage[]) => Step);

export interface Seen {
	fingerprint?: ModelRequestObservation["fingerprint"];
	history: IterativeMessage[];
	systemPrompt: string;
	/** The per-call host note sent beside the system prompt, if any. */
	turnNotice?: string;
	tools: string[];
	/** The ledger attempt kind the round was sent with, if any. */
	budgetAttemptKind?: string;
	/** The user's request a finalization round was sent with, if any. */
	finalizationQuestion?: string;
}

export interface TurnOptions {
	state?: Partial<WorkflowState>;
	/** Report the scripted provider set separately from the workflow's proposed set; null models an older worker. */
	offeredToolNames?: string[] | null;
	onIterationInput?: (
		input: import("../../../../activities/orchestrator/execution/run-agent-iteration").RunAgentIterationInput,
	) => void;
	runIteration?: (
		input: import("../../../../activities/orchestrator/execution/run-agent-iteration").RunAgentIterationInput,
	) => Promise<
		import("../../../../activities/orchestrator/execution/run-agent-iteration").AgentIterationResult
	>;
	/** Capture the scripted activity boundary without calling a provider. */
	observeRequests?: boolean;
	message: string;
	steps: Step[];
	history?: Array<{ role: "user" | "assistant"; content: string }>;
	preload?: ReturnType<typeof preloaded>;
	enabledMcpConfigIds?: string[];
	enabledFabricToolIds?: string[];
	/** Execution-mode limits; defaults to `{ maxIterations: 20 }`. */
	modeConfig?: Record<string, unknown>;
	advisorBudgetEnabled?: boolean;
	/** The loop's cancellation check; defaults to never cancelled. */
	isCancelled?: () => boolean;
	/** The attached project; defaults to "project-1", null for none. */
	projectId?: string | null;
	/** Attached workspaces (the workspace_rag tools need one). */
	workspaceIds?: string[];
	/** Images the user attached to the message. */
	attachedImageUrls?: string[];
	/** `state.preloadedResources`, as initialization would have set it. */
	preloadedResources?: Record<string, unknown>;
	/** Extra workflow input fields, such as the Advisor's opt-in. */
	input?: Record<string, unknown>;
	/** Autonomy level for the risk gate; defaults to the loop's own. */
	approval?: { approved: boolean };
	autonomyLevel?: "CONSERVATIVE" | "BALANCED" | "AUTONOMOUS";
	/** The turn contract options the workflow passes (absent = legacy run). */
	turn?: IterativeTurnOptions;
}

export async function runTurn(mocks: ScenarioMocks, options: TurnOptions) {
	const seen: Seen[] = [];
	const queue = [...options.steps];
	mocks.stub("runAgentIteration").mockImplementation(async (req) => {
		options.onIterationInput?.(req);
		if (options.runIteration) {
			return options.runIteration(req);
		}
		// Snapshot: the loop keeps mutating the array it passed.
		const history = structuredClone(
			req.conversationHistory,
		) as IterativeMessage[];
		seen.push({
			history,
			systemPrompt: req.systemPrompt,
			turnNotice: req.turnNotice,
			tools: Object.keys(req.availableTools),
			...(req.budgetAttemptKind
				? { budgetAttemptKind: req.budgetAttemptKind }
				: {}),
			...("finalizationQuestion" in req
				? { finalizationQuestion: req.finalizationQuestion }
				: {}),
		});
		// Mirror the activity's suppression when observing the scripted model request.
		const sentTools = Object.entries(req.availableTools).filter(
			([name]) => !(req.suppressedToolNames ?? []).includes(name),
		);
		const requests: ModelRequestObservation[] | undefined =
			options.observeRequests
				? [
						{
							iteration: seen.length,
							activityAttempt: 1,
							request: 1,
							estimatedInputTokens: 10,
							toolNames: sentTools.map(([name]) => name),
							fingerprint: createRequestFingerprint({
								modelId: "example-model",
								route: "scripted",
								prompt: [
									{
										role: "system",
										content: req.systemPrompt,
									},
									...history,
								],
								tools: sentTools.map(([name, definition]) => ({
									name,
									...(definition as object),
								})),
							}),
						} satisfies ModelRequestObservation,
					]
				: undefined;
		if (requests) {
			seen[seen.length - 1].fingerprint = requests[0].fingerprint;
		}
		let step = queue.shift();
		while (typeof step === "function") {
			step = step(history);
		}
		const defaultUsage = { inputTokens: 10, outputTokens: 5 };
		if (!step) {
			throw new Error("model script exhausted");
		}
		const usage =
			("usage" in step ? step.usage : undefined) ?? defaultUsage;
		if ("refuse" in step) {
			throw ApplicationFailure.create({
				type: "TurnBudgetExhausted",
				message: "Turn has used its token allowance",
				nonRetryable: true,
				details: [
					{
						kind: step.refuse,
						room: 0,
						needed: 9_000,
						snapshot: step.ledger,
					},
				],
			});
		}
		if ("answer" in step) {
			return {
				type: "response",
				content: step.answer,
				usage,
				...(step.ledger ? { ledger: step.ledger } : {}),
				...("requests" in step
					? { requests: step.requests }
					: requests
						? { requests }
						: {}),
			};
		}
		return {
			...("ledger" in step ? { ledger: step.ledger } : {}),
			...("requests" in step
				? { requests: step.requests }
				: requests
					? { requests }
					: {}),
			...(req.callToolMode && options.offeredToolNames !== null
				? {
						offeredToolDefinitions: Object.fromEntries(
							sentTools
								.filter(
									([name]) =>
										options.offeredToolNames ===
											undefined ||
										options.offeredToolNames?.includes(
											name,
										),
								)
								.map(([name, definition]) => [
									name,
									normalizeAdvisorToolDefinition(
										name,
										definition as never,
									),
								]),
						),
					}
				: {}),
			type: "tool_calls",
			toolCalls: step.calls.map((c, i) => ({
				id: `call-${seen.length}-${i}`,
				name: c.name,
				args: c.args,
			})),
			usage,
		};
	});
	mocks
		.stub("preloadMcpToolsForConfigsActivity")
		// Nothing by default: the activity lists MCPConfig rows, and the
		// Fabric catalog is not one, so it never preloads code_* tools.
		.mockResolvedValue(options.preload ?? []);

	const input = {
		executionId: "exec-advisor-1",
		message: options.message,
		userId: "user-1",
		organizationId: "org-1",
		projectId:
			options.projectId === undefined
				? "project-1"
				: (options.projectId ?? undefined),
		attachedImageUrls: options.attachedImageUrls,
		workspaceIds: options.workspaceIds,
		enabledMcpConfigIds: options.enabledMcpConfigIds,
		enabledFabricToolIds: options.enabledFabricToolIds,
		history: options.history ?? [],
		...(options.autonomyLevel
			? { autonomyLevel: options.autonomyLevel }
			: {}),
		...options.input,
	};
	const state = createInitialState(input as never);
	if (
		options.input?.toolLoadingMode === "call_tool" &&
		!mocks.off.has("orch-call-tool-v1")
	) {
		state.advisorCallToolMode = true;
	}
	state.advisorBudgetEnabled = options.advisorBudgetEnabled ?? false;
	state.advisorBoundedHistoryEnabled = boundedHistoryEnabled(
		input as never,
		!mocks.off.has(BOUNDED_HISTORY_PATCH),
	);
	state.advisorBoundedHistoryV2Enabled =
		state.advisorBoundedHistoryEnabled &&
		!mocks.off.has(BOUNDED_HISTORY_V2_PATCH);
	state.advisorWeightedAllowanceEnabled =
		state.advisorBudgetEnabled && !mocks.off.has(WEIGHTED_ALLOWANCE_PATCH);
	state.enrichedMessage = options.message;
	state.enrichedSystemPrompt = "You are the project Advisor.";
	if (options.preloadedResources) {
		state.preloadedResources = options.preloadedResources as never;
	}

	Object.assign(state, options.state);
	const result = await executeIterativePhase(
		state,
		input as never,
		(options.modeConfig ?? { maxIterations: 20 }) as never,
		{} as never,
		vi.fn(),
		vi.fn().mockResolvedValue(options.approval),
		options.isCancelled ?? (() => false),
		options.turn,
	);
	return { result, state, seen };
}

/** The tool message the model was shown for `callId`, as of model call `at`. */
export function toolMessage(seen: Seen[], at: number, callId: string): string {
	const msg = seen[at].history.find(
		(m) => m.role === "tool" && m.toolCallId === callId,
	);
	if (!msg) {
		throw new Error(`no tool message for ${callId} in model call ${at}`);
	}
	return msg.content;
}

export function finalResponse(result: unknown): string | undefined {
	return (result as { data?: { finalResponse?: string } }).data
		?.finalResponse;
}

/** The activity stubs every scenario starts from. */
export function installDefaultStubs(mocks: ScenarioMocks): void {
	mocks.resetAll();
	mocks.off.clear();
	mocks.stub("executeMcpTool").mockImplementation(fakeMcp);
	mocks
		.stub("searchProjectSlackMessages")
		.mockResolvedValue(slackResult("Launch is on the 12th"));
	mocks
		.stub("searchAvailableTools")
		.mockResolvedValue(fabricDiscovery(["code_file_get", "code_tree"]));
	mocks.stub("searchAvailableAgents").mockResolvedValue({
		results: [],
		totalAgentsSearched: 0,
		durationMs: 1,
	});
	mocks.stub("searchAvailableIntegrations").mockResolvedValue({
		results: [],
		totalIntegrationsSearched: 0,
		durationMs: 1,
	});
	mocks
		.stub("summarizeLargeToolResult")
		.mockResolvedValue("Condensed summary of the tool output.");
	// A reply with no tool call behind it is checked for a completion claim;
	// by default it makes none.
	mocks.stub("checkCompletionClaimActivity").mockResolvedValue({
		unbackedClaim: false,
		judgedBy: "decision",
		usage: { inputTokens: 0, outputTokens: 0 },
	});
	// `ExecuteSkillToolOutput` for load_skill: a `SkillBundle`.
	mocks.stub("executeSkillToolActivity").mockResolvedValue({
		kind: "bundle",
		bundle: {
			slug: "example-skill",
			name: "Example skill",
			description: "Formats launch reports.",
			version: 1,
			category: null,
			tags: [],
			files: [],
			skillMd: SKILL_BODY,
		},
	});
}
