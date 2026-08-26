/**
 * Iterative Execution Phase
 *
 * Implements an iterative agent loop where the LLM decides what to do at each
 * step based on previous results. This replaces upfront planning for the
 * "iterative" execution mode.
 *
 * Key differences from upfront execution:
 * - No pre-generated plan - LLM decides each step
 * - Tool results feed directly back to the LLM
 * - Safety layer applied before each tool execution
 * - Natural error recovery (LLM sees errors and adapts)
 *
 * Flow:
 * 1. LLM sees user message + conversation history
 * 2. LLM decides: call tool(s) or return final response
 * 3. If tool calls: apply safety layer, execute, add results to history
 * 4. Loop until final response or limit reached
 */

// Pure helper — string regex with no IO/clock/env access, so safe to call
// from inside the workflow. Imported via the deep `./utils/sanitize-error`
// subpath so the workflow sandbox does not pull in the full `@repo/
// agent-core` entry (which would transitively load HTTP clients, langchain
// SDKs, etc.).
import { sanitizeMcpErrorMessage } from "@repo/agent-core/utils/sanitize-error";
import type { LimitSignal, TokenBudgetStatus } from "@repo/ai/limits";
// Pure string formatting shared with the execution activity that decodes it —
// no IO, clock or env access, so it is safe inside the workflow sandbox.
import { encodeIntegrationToolRef } from "@repo/utils/integration-tool-ref";
import { log, patched, proxyActivities } from "@temporalio/workflow";
import type * as orchestratorActivities from "../../../activities/orchestrator";
import type { ToolCategory } from "../../../activities/orchestrator";
// Value import, not the activities barrel: this module has no imports of its
// own, so it carries nothing into the workflow sandbox. Same shape as
// `safeEvaluateExpression` in template-execution.ts.
import { DEFAULT_MCP_TOOL_TIMEOUT_MS } from "../../../activities/orchestrator/execution/mcp-call-timeout";
import { projectIntegrationTools } from "../integration-tool-projection";
import {
	BUDGET,
	COMPACTION,
	TOOL_RESULTS,
	TOOLS,
} from "../orchestrator-config";
import { assessToolCallRisk } from "../risk-assessment";
import type {
	ALTKConfig,
	ApprovalSignalData,
	ExecutionModeConfig,
	IterationCost,
	IterativeMessage,
	McpDefaultToolFailureKind,
	McpDefaultToolSurface,
	OrchestratorWorkflowInput,
	PhaseResult,
	WorkflowState,
} from "../types";

/**
 * Build a `TokenBudgetStatus` snapshot from the current `iterationCosts`.
 * Used when we emit an `internal_budget` LimitSignal so the UI's
 * TokenBudgetCard can render the exact numbers that tripped the budget.
 */
function buildBudgetStatus(
	iterationCosts: IterationCost[],
	modeConfig: ExecutionModeConfig,
	warning?: string,
): TokenBudgetStatus {
	const maxTokens = modeConfig.maxTotalTokens || BUDGET.defaultMaxTotalTokens;
	const used = iterationCosts.reduce(
		(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
		0,
	);
	// usagePercentage is a decimal in [0, 1] to match the existing
	// TokenBudgetCard convention (which multiplies by 100 for display).
	const usagePercentage = maxTokens > 0 ? Math.min(used / maxTokens, 1) : 0;
	const status: TokenBudgetStatus = {
		used,
		total: maxTokens,
		usagePercentage,
	};
	if (warning) {
		status.warning = warning;
	}
	return status;
}

// Proxy activities for the iterative phase — LLM calls can take 40-60+ seconds.
// `runAgentIteration` runs a 15s background heartbeat ticker, so a 1-minute
// heartbeatTimeout fails fast on a wedged worker without false positives.
const {
	runAgentIteration,
	searchAvailableTools,
	searchAvailableAgents,
	searchAvailableIntegrations,
	createOrchestratorApprovalRequest,
	updateApprovalTaskStatus,
	summarizeLargeToolResult,
	preloadMcpToolsForConfigsActivity,
	compactConversationHistoryActivity,
	// Default-MCP surface routing — see `applyDefaultMcpEagerRouting`.
	// `findExcalidrawConfigActivity` is the legacy-name alias kept proxied
	// for replay-compat against pre-rename workflow histories.
	findDefaultMcpConfigActivity,
	findExcalidrawConfigActivity,
	fetchToolsFromServerIds,
} = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Registry list is a single indexed read against the global `MCPServer`
// table (no tenant filter; only system-provided rows). 30s proxy timeout.
const { listDefaultEnabledMcpServersActivity } = proxyActivities<
	typeof orchestratorActivities
>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "10s",
		maximumAttempts: 3,
	},
});

// Issue #4: Separate proxy with shorter timeout for tool execution. Heartbeat
// is the real liveness check — long-running tools must call it.
const {
	executeMcpTool,
	executeAgentAsTool,
	executeDatabricksKnowledgeSearchActivity,
	retrieveWorkspaceDocumentsActivity,
	retrieveProjectContextsActivity,
	searchProjectSlackMessages,
	searchProjectTeamsMessages,
	executeSkillToolActivity,
} = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 2, // Fewer retries for tools — LLM can adapt to failure
	},
});

// Telemetry forwarder. Wraps the fire-and-forget Redis publish
// (`publishExecutionEvent`) so the workflow can drain
// `state.mcpDefaultToolSignals` into the SSE pipeline.
// No retries — Redis outages MUST NOT block orchestrator execution; the
// underlying publisher already swallows transport errors. Short timeout
// keeps a stuck activity from holding up the iteration loop.
const { publishMcpDefaultToolSignalActivity } = proxyActivities<
	typeof orchestratorActivities
>({
	startToCloseTimeout: "10 seconds",
	retry: {
		initialInterval: "500ms",
		backoffCoefficient: 2,
		maximumInterval: "2s",
		maximumAttempts: 1,
	},
});

// Risk assessment is now imported from ../risk-assessment.ts (Issue #3)
// Both upfront and iterative execution use the same shared pure function.

/**
 * Drain accumulated `mcpDefaultToolSignals` entries to the SSE pipeline.
 *
 * The success path and the two failure paths all push onto
 * `state.mcpDefaultToolSignals` while keeping the activity-side publish
 * out of band. This helper does the bridge: for each entry whose index
 * is >= `state.mcpDefaultToolSignalFlushIndex`, it fires
 * `publishMcpDefaultToolSignalActivity` (one event per entry, in order),
 * then advances the cursor past the last published entry. Idempotent
 * across repeated calls — already-flushed entries are skipped via the
 * cursor.
 *
 * `Promise.allSettled` is used because telemetry MUST NOT propagate
 * failure into the orchestration loop. Workflow determinism is preserved:
 * the activity wraps a fire-and-forget Redis publish that swallows
 * transport errors internally, so the activity itself only rejects when
 * Temporal infrastructure (worker shutdown, queue saturation) fails — at
 * which point we log and move on; analytics is best-effort.
 */
async function flushMcpDefaultToolSignals(state: WorkflowState): Promise<void> {
	// Replay-compat: `publishMcpDefaultToolSignalActivity` is a new activity
	// introduced by this feature. Pre-rename workflow histories never
	// scheduled it, so calling it under those replays would raise a
	// TMPRL1100 non-determinism error. The same `patched()` gate that
	// governs `applyDefaultMcpEagerRouting` also guards the flush path —
	// when false (old replay) the flush is a no-op; live runs always see
	// `true` and publish telemetry as expected.
	if (!patched("default-mcp-eager-routing-v1")) {
		return;
	}

	const total = state.mcpDefaultToolSignals.length;
	const startIdx = state.mcpDefaultToolSignalFlushIndex;
	if (startIdx >= total) {
		return;
	}

	const pending = state.mcpDefaultToolSignals.slice(startIdx, total);
	// Snapshot the cursor BEFORE awaiting so an in-flight push from a
	// later activity call doesn't get accidentally double-published when
	// a subsequent flush sees it but reads the old (smaller) cursor.
	state.mcpDefaultToolSignalFlushIndex = total;

	const results = await Promise.allSettled(
		pending.map((signal) =>
			publishMcpDefaultToolSignalActivity(state.executionId, signal),
		),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (result.status === "rejected") {
			log.warn(
				"[McpDefaultToolTelemetry] Failed to publish signal — analytics is best-effort, continuing",
				{
					executionId: state.executionId,
					signalIndex: startIdx + i,
					signalKind: pending[i].kind,
					serverKey: pending[i].serverKey,
					reason: String(result.reason),
				},
			);
		}
	}
}

/**
 * Format tools for the LLM
 *
 * In iterative mode with meta-tools enabled, this starts with just meta-tools
 * and dynamically adds discovered tools as the agent searches for capabilities.
 */
function formatToolsForLLM(
	preloadedResources: WorkflowState["preloadedResources"],
	discoveredTools?: Record<string, unknown>,
): Record<string, unknown> {
	const tools: Record<string, unknown> = {};

	// Add preloaded OAuth tools (if any)
	if (preloadedResources?.toolMap) {
		for (const [toolName, toolInfo] of Object.entries(
			preloadedResources.toolMap,
		)) {
			tools[toolName] = {
				description: toolInfo.definition.description,
				inputSchema: toolInfo.definition.inputSchema,
			};
		}
	}

	// Add dynamically discovered tools (from search_tools calls)
	if (discoveredTools) {
		for (const [toolName, toolDef] of Object.entries(discoveredTools)) {
			tools[toolName] = toolDef;
		}
	}

	return tools;
}

/**
 * Create meta-tool definitions for iterative execution
 * These enable dynamic capability discovery without loading all tools upfront
 */
function getMetaTools(): Record<string, unknown> {
	return {
		search_tools: {
			description: `Search for available MCP tools, capabilities, and AI agents that can help with your task.
Use this BEFORE attempting to call any tool you're not familiar with.
Returns matching tools with their inputSchema — always call tools exactly as their schema specifies.

Tips for effective queries:
- Include the service/server name when you know it (e.g., "Excalidraw create diagram", "GitHub create issue", "Jira create ticket")
- Describe the action you want to perform (e.g., "create a card", "send a message", "query data")
- Be specific — "create Excalidraw architecture diagram" finds better results than "create diagram"

IMPORTANT: Always call this when you need to interact with external systems,
databases, project management tools, or any capability you're uncertain about.`,
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Natural language description of what you need to do. Include the service name when known (e.g., 'create Excalidraw diagram', 'GitHub create issue', 'send Slack message')",
					},
					category: {
						type: "string",
						enum: [
							"project_management",
							"communication",
							"development",
							"documentation",
							"data",
							"automation",
							"agents",
						],
						description:
							"Optional: narrow search to a specific category. Use 'agents' to find AI agents for task delegation.",
					},
					limit: {
						type: "number",
						minimum: 1,
						maximum: 20,
						default: 10,
						description:
							"Maximum number of tools to return (default: 10)",
					},
				},
				required: ["query"],
			},
		},
	};
}

// =============================================================================
// TEXT HELPERS
// =============================================================================

/**
 * Workflow files run in Temporal's V8 sandbox and cannot import from sibling
 * packages, so this is duplicated here rather than reused.
 */
function truncateWithEllipsis(s: string, max: number): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max - 1).trimEnd()}…`;
}

// =============================================================================
// PRELOADED TOOL CATALOG (stub-catalog mode)
// =============================================================================

/**
 * Build a compact one-line-per-tool catalog from the preloaded MCP tool list.
 * Used when the preloaded count exceeds `TOOLS.eagerLoadThreshold`: instead
 * of attaching ~440 tokens of inputSchema per tool to every iteration, we
 * inject this catalog into the system prompt (~50–60 chars per tool) and let
 * the model fetch full schemas on demand via `search_tools`. The model loses
 * no information — it knows every tool exists by name and one-line
 * description — and pays nothing per iteration for tools it never uses.
 *
 * Groups by server in first-seen order, with within-server tools in
 * registration order. Deterministic.
 */
const MAX_CATALOG_DESCRIPTION_CHARS = 80;
export function buildPreloadedToolCatalog(
	tools: Array<{
		toolName: string;
		description: string;
		serverName: string;
	}>,
): string {
	if (tools.length === 0) {
		return "";
	}
	const order: string[] = [];
	const byServer = new Map<string, typeof tools>();
	for (const t of tools) {
		let bucket = byServer.get(t.serverName);
		if (!bucket) {
			bucket = [];
			byServer.set(t.serverName, bucket);
			order.push(t.serverName);
		}
		bucket.push(t);
	}
	const lines: string[] = [];
	for (const server of order) {
		const bucket = byServer.get(server);
		if (!bucket) {
			continue;
		}
		lines.push(`Server: ${server}`);
		for (const t of bucket) {
			const desc = (t.description || "").trim();
			const firstLine = desc.split(/\r?\n/, 1)[0] ?? "";
			lines.push(
				`  - ${t.toolName} — ${truncateWithEllipsis(firstLine, MAX_CATALOG_DESCRIPTION_CHARS)}`,
			);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// PROGRESSIVE TOOL RESULT PRUNING
// =============================================================================
// As iterations accumulate, old tool results bloat the conversation history.
// Each iteration sends the full history as input tokens, causing cumulative growth.
// After ~5-8 iterations with large tool results, this can exceed token budgets.
//
// Solution: Replace old tool result contents with short summaries, keeping only
// the most recent iterations' results in full for the LLM to reference.
// =============================================================================
// All constants are now centralized in orchestrator-config.ts (Issue #7)

const SYNTHESIS_SYSTEM_PROMPT = `You are writing the FINAL response for a multi-step task that has reached its resource limit. The user is waiting — your reply is what they will see.

Required output (no preamble, no boilerplate):

## Summary
2–4 sentences directly answering the user's original request, grounded in what was actually done.

## What I did
Bullet list of concrete actions and findings. Include:
- File paths, IDs, names, URLs verbatim
- Data points and numbers verbatim
- Decisions made and why
Be specific. "Examined the auth module" is bad. "Examined packages/auth/src/sessions.ts; session token TTL is 30 days" is good.

## What's still needed
Bullet list of work that wasn't completed, with concrete next steps the user (or a fresh session) could take to finish the task. If the task was fully completed, write "Nothing — the task is complete."

Hard rules:
- This is the user's only output. Do NOT respond with "Task completed.", "Done.", or anything under one paragraph.
- Do NOT mention budget limits, token constraints, or that you ran out of context. The user does not care about implementation details.
- Use the headers above verbatim. Markdown formatting is required.
- If you genuinely have nothing concrete to report, say so explicitly: state that no actionable information was gathered and what the user should try instead.`;

/**
 * Prune old tool results from conversation history to prevent context bloat.
 *
 * Keeps user/assistant messages intact. For tool-role messages, replaces content
 * of older iterations with a short summary placeholder.
 *
 * Tool results are attributed to iterations by their position in the history:
 * we walk the messages and track which iteration each tool result belongs to
 * based on the preceding assistant message's toolCalls.
 */
function pruneConversationHistory(
	conversationHistory: IterativeMessage[],
	currentIteration: number,
): void {
	const pruneBeforeIteration =
		currentIteration - TOOL_RESULTS.recentIterationsToKeep;
	if (pruneBeforeIteration <= 0) {
		return;
	}

	// Build a map of toolCallId -> toolName from assistant messages
	const toolCallNames = new Map<string, string>();
	for (const msg of conversationHistory) {
		if (msg.role === "assistant" && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				toolCallNames.set(tc.id, tc.name);
			}
		}
	}

	// Prune tool results from old iterations using the iteration tag on each message.
	// A single workflow iteration can produce multiple tool calls (and therefore
	// multiple assistant+tool message pairs), so we use the explicit tag rather
	// than counting assistant messages.
	let totalPruned = 0;
	let totalSaved = 0;

	for (const msg of conversationHistory) {
		// Only prune tool-role messages from old iterations
		if (msg.role !== "tool") {
			continue;
		}
		// Use the iteration tag; messages without a tag are from prior history and kept
		if (
			msg.iteration === undefined ||
			msg.iteration >= pruneBeforeIteration
		) {
			continue;
		}
		if (msg.content.length < TOOL_RESULTS.pruneMinChars) {
			continue;
		}
		// Skip already-pruned messages
		if (msg.content.startsWith("[Previous tool result pruned")) {
			continue;
		}

		const toolName = msg.toolCallId
			? toolCallNames.get(msg.toolCallId) || "unknown"
			: "unknown";
		const originalLength = msg.content.length;
		const summary = msg.content
			.substring(0, TOOL_RESULTS.prunedPlaceholderMax)
			.replace(/\n/g, " ");

		msg.content = `[Previous tool result pruned to save context. Tool: ${toolName} returned ${originalLength} chars. Summary: ${summary}...]`;

		totalPruned++;
		totalSaved += originalLength - msg.content.length;
	}

	if (totalPruned > 0) {
		log.info("[IterativeExecution] Pruned old tool results", {
			prunedCount: totalPruned,
			charsSaved: totalSaved,
			currentIteration,
			pruneBeforeIteration,
		});
	}
}

/**
 * Check if we're within token budget.
 *
 * Reserves tokens and iterations for the final synthesis call so that
 * when the budget is exceeded, we still have room for one LLM call to
 * produce a proper summary instead of a static tool-name list.
 */
function checkIterationBudget(
	iterationCosts: IterationCost[],
	modeConfig: ExecutionModeConfig,
): { withinBudget: boolean; reason?: string } {
	const maxTokens = modeConfig.maxTotalTokens || BUDGET.defaultMaxTotalTokens;
	const maxIterations =
		modeConfig.maxIterations || BUDGET.defaultMaxIterations;
	const effectiveBudget = maxTokens - BUDGET.synthesisReserveTokens;
	const effectiveMaxIterations =
		maxIterations - BUDGET.synthesisIterationReserve;

	const totalTokens = iterationCosts.reduce(
		(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
		0,
	);

	if (totalTokens > effectiveBudget) {
		return {
			withinBudget: false,
			reason: `Token budget exceeded: ${totalTokens}/${maxTokens}`,
		};
	}

	if (iterationCosts.length >= effectiveMaxIterations) {
		return {
			withinBudget: false,
			reason: `Iteration limit reached: ${iterationCosts.length}/${maxIterations}`,
		};
	}

	return { withinBudget: true };
}

/**
 * Returns a warning string when token/iteration usage exceeds the warning threshold.
 * Appended to the system prompt to nudge the LLM to wrap up naturally.
 */
function getBudgetWarning(
	iterationCosts: IterationCost[],
	modeConfig: ExecutionModeConfig,
): string | null {
	const maxTokens = modeConfig.maxTotalTokens || BUDGET.defaultMaxTotalTokens;
	const maxIterations =
		modeConfig.maxIterations || BUDGET.defaultMaxIterations;
	const effectiveBudget = maxTokens - BUDGET.synthesisReserveTokens;
	const effectiveMaxIterations =
		maxIterations - BUDGET.synthesisIterationReserve;

	const totalTokens = iterationCosts.reduce(
		(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
		0,
	);

	const tokenRatio = effectiveBudget > 0 ? totalTokens / effectiveBudget : 0;
	const iterationRatio =
		effectiveMaxIterations > 0
			? iterationCosts.length / effectiveMaxIterations
			: 0;
	const usageRatio = Math.max(tokenRatio, iterationRatio);

	if (usageRatio < BUDGET.warningThreshold) {
		return null;
	}

	const pct = Math.round(usageRatio * 100);

	return `\n\nIMPORTANT - BUDGET WARNING: You are approaching the resource limit (~${pct}% used).
- If you have enough information, provide your final response NOW.
- If you need one more critical tool call, make it, but avoid exploratory calls.
- Do NOT start new lines of investigation.`;
}

const ARGS_BLOCKS_TOOLS = new Set([
	"fabric_create_frame",
	"fabric_create_slideshow",
	"fabric_update_frame",
]);

/**
 * Strip rendered block content from frame-tool args before persisting them
 * to workflow state or replaying them in conversationHistory. The activity
 * dispatch above this call still receives the raw args so the frame is
 * persisted with full content; this scrubber only protects the workflow
 * archive and the LLM's view on subsequent iterations from re-carrying
 * 7KB+ of HTML per block.
 */
function scrubArgsForRetention(
	name: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!ARGS_BLOCKS_TOOLS.has(name)) {
		return args;
	}
	if (!Array.isArray(args.blocks)) {
		return args;
	}
	const scrubbedBlocks = args.blocks.map((entry) => {
		if (!entry || typeof entry !== "object") {
			return entry;
		}
		const block = entry as Record<string, unknown>;
		if (typeof block.content !== "string") {
			return entry;
		}
		const length = block.content.length;
		return {
			...block,
			content: `[content omitted: ${length} chars - rendered to frame]`,
		};
	});
	return { ...args, blocks: scrubbedBlocks };
}

// ---------------------------------------------------------------------------
// Default-MCP eager routing helper
// ---------------------------------------------------------------------------

/**
 * Surfaces whose orchestrator runs ARE routed through the default-MCP
 * eager-routing helper. Today this is every literal in
 * `OrchestratorWorkflowInput["surface"]` except `"copilot"` — the
 * CopilotSidebar path does not load MCP tools (apps/web/app/api/copilotkit
 * /route.ts) so eager-loading would have no downstream tool execution
 * to flow into, and we don't want to emit `mcp_default_tool_failed`
 * telemetry on every "draw using Excalidraw" prompt in the doc editor
 * sidebar.
 *
 * The tuple is declared `as const` so the literal element type survives
 * inference, which lets the {@link AssertSurfaceCoverage} guard below
 * detect when a new surface literal is added to `workflow-io.types.ts`
 * without being classified.
 */
const TEMPORAL_ROUTED_SURFACES_LIST = [
	"nexus",
	"document-editor",
	"agent-template",
	"weave",
] as const satisfies readonly NonNullable<
	OrchestratorWorkflowInput["surface"]
>[];

type TemporalRoutedSurface = (typeof TEMPORAL_ROUTED_SURFACES_LIST)[number];

// Typed as `ReadonlySet<string>` (not `ReadonlySet<TemporalRoutedSurface>`)
// so the helper's `.has(args.surface)` call accepts the full
// `OrchestratorWorkflowInput["surface"]` union (including `"copilot"`)
// without a cast. The compile-time guarantee that every literal is
// classified lives in {@link AssertSurfaceCoverage} above.
const TEMPORAL_ROUTED_SURFACES: ReadonlySet<string> = new Set(
	TEMPORAL_ROUTED_SURFACES_LIST,
);

/**
 * Compile-time guard: every literal in
 * `OrchestratorWorkflowInput["surface"]` must be classified as either
 * a member of `TEMPORAL_ROUTED_SURFACES` or `"copilot"` (the single
 * explicit exclusion). If a new surface literal is added to
 * `workflow-io.types.ts` and not added to the tuple above OR to the
 * exclusion union below, this fails compilation.
 */
type AssertSurfaceCoverage = NonNullable<
	OrchestratorWorkflowInput["surface"]
> extends
	| TemporalRoutedSurface
	// Excluded from MCP eager routing. "copilot" and the standalone Loom
	// Orchestrator chat ("loom-orchestrator") intentionally fall through —
	// they did before this literal was added to the type, so excluding them
	// preserves runtime behavior (no eager-routing change for Loom).
	| "copilot"
	| "loom-orchestrator"
	? true
	: never;
const _surfaceCoverage: AssertSurfaceCoverage = true;
// Reference the binding so unused-variable lints don't strip the guard.
void _surfaceCoverage;

/**
 * Arguments for {@link applyDefaultMcpEagerRouting}. The helper mutates
 * `discoveredTools`, `discoveredToolConfigIds`, and `suppressedFrameTools`
 * in place so the caller's existing `availableTools` / suppression set
 * pipeline picks up the new state without rewiring.
 */
export interface ApplyDefaultMcpEagerRoutingArgs {
	/**
	 * UI surface that initiated the run — gate is membership in
	 * {@link TEMPORAL_ROUTED_SURFACES}.
	 */
	surface: OrchestratorWorkflowInput["surface"];
	/** The user's most recent message — case-insensitive substring match. */
	userMessage: string;
	/**
	 * Caller-restricted MCP config set. `null` / `undefined` means "any of
	 * the tenant's enabled configs are eligible". Forwarded as-is to
	 * `findDefaultMcpConfigActivity`.
	 */
	enabledMcpConfigIds: string[] | null | undefined;
	/** Tenant — required. */
	userId: string;
	/** Tenant — undefined means personal context. */
	organizationId: string | undefined;
	/**
	 * Mutable map of tools the model can call without a `search_tools`
	 * round-trip. On a successful eager-load, the matched server's
	 * `eagerToolName` is added with its description + inputSchema.
	 */
	discoveredTools: Record<string, unknown>;
	/**
	 * Mutable map of `toolName → mcpConfigId` for direct MCP execution.
	 * The eager tool is registered against the resolved managed-default
	 * config id so `executeMcpTool` doesn't have to scan every config.
	 */
	discoveredToolConfigIds: Record<string, string>;
	/**
	 * Mutable set of tool names the caller must drop from `availableTools`
	 * before invoking `runAgentIteration`. On the eager-load path the
	 * helper adds every name listed in the matched server's
	 * `suppressOnEager` so the model can't fall back to generic frame
	 * tools when a real renderer is available.
	 */
	suppressedFrameTools: Set<string>;
	/** For log correlation. */
	executionId: string;
}

/**
 * Discriminated-union result of {@link applyDefaultMcpEagerRouting}.
 *
 * Per `fabric/standards/global/coding-style.md` Pattern 3
 * ("Discriminated Unions for State"), the union forces every caller to
 * handle every case at compile time. Replaces the legacy
 * `true | false | "not-connected"` shape.
 *
 *   - `"skipped"` — surface gate failed, keyword gate failed, or eager
 *     load otherwise gracefully degraded. No mutations applied.
 *   - `"eager-loaded"` — the matched server's `eagerToolName` was added
 *     to `discoveredTools` and `discoveredToolConfigIds`; entries in
 *     `suppressOnEager` were added to `suppressedFrameTools`. The
 *     `configId` is included so the executeMcpTool wrapper site can
 *     map a tool-call failure back to the managed-default
 *     `MCPConfig` row that owns it.
 *   - `"service-down"` — the registry rows resolved but tenant-level
 *     config lookup OR upstream tool fetch failed. The caller emits a
 *     status card and short-circuits the iteration. The
 *     `failureKind` field disambiguates the three sub-cases
 *     (`no-config`, `server-unreachable`, `schema-mismatch`) so the
 *     analytics emission carries the right bucket. `errorMessage` is
 *     the sanitized representation of the underlying error suitable
 *     for analytics (no API keys, no PII, ≤ 500 chars).
 *
 * The `failureKind` + `errorMessage` fields on the `service-down`
 * variant wire the `mcp_default_tool_failed` analytics emission. The
 * existing `serverKey` / `serverName` fields are preserved unchanged so
 * the caller's status-card emission keeps working without rewiring.
 */
export type DefaultMcpEagerRoutingResult =
	| { kind: "skipped" }
	| {
			kind: "eager-loaded";
			serverKey: string;
			toolName: string;
			configId: string;
	  }
	| {
			kind: "service-down";
			serverKey: string;
			serverName: string;
			failureKind: McpDefaultToolFailureKind;
			errorMessage: string;
	  };

/**
 * Surface-aware managed-default MCP eager-routing helper.
 *
 * Behavior (locked by `default-mcp-eager-routing.test.ts`):
 *   - `args.surface` not in `TEMPORAL_ROUTED_SURFACES` → `{kind:"skipped"}` (no I/O).
 *   - No registry row's `eagerKeywords` substring-matches the user
 *     message (case-insensitive) → `{kind:"skipped"}`.
 *   - Registry row matches but tenant has no enabled config →
 *     `{kind:"service-down", serverKey, serverName, failureKind:
 *     "no-config", errorMessage: ""}` (the caller emits the status card
 *     and short-circuits).
 *   - Config exists → eager-load `eagerToolName` into `discoveredTools`,
 *     register `suppressOnEager` for suppression, return
 *     `{kind:"eager-loaded", serverKey, toolName, configId}`.
 *   - Eager-load fetch throws OR the eager tool name is missing from
 *     the fetched tool list → `{kind:"service-down", serverKey,
 *     serverName, failureKind: "server-unreachable" | "schema-mismatch",
 *     errorMessage}` (graceful degradation; the caller emits the
 *     status card).
 *
 * The `failureKind` branch labels are passed through to the
 * `mcp_default_tool_failed` analytics emission so the dashboards can
 * distinguish "tenant has no config" from "service unreachable" from
 * "registry drift". The `errorMessage` is the sanitized representation
 * of the underlying exception (or the empty string for the no-config
 * path which has no exception).
 *
 * Iteration order is `MCPServer.name` ASC — first keyword match wins;
 * subsequent rows are not consulted on the
 * same turn (avoids combinatorial behavior when keywords overlap).
 */
export async function applyDefaultMcpEagerRouting(
	args: ApplyDefaultMcpEagerRoutingArgs,
): Promise<DefaultMcpEagerRoutingResult> {
	const {
		surface,
		userMessage,
		enabledMcpConfigIds,
		userId,
		organizationId,
		discoveredTools,
		discoveredToolConfigIds,
		suppressedFrameTools,
		executionId,
	} = args;

	// Surface gate. No I/O when the surface didn't opt in — protects the
	// CopilotSidebar path from inheriting orchestrator-side routing.
	if (!surface || !TEMPORAL_ROUTED_SURFACES.has(surface)) {
		return { kind: "skipped" };
	}

	// Registry source. `listDefaultEnabledMcpServersActivity` is a new
	// activity introduced by this feature — pre-rename workflow histories
	// never scheduled it, so calling it unconditionally would raise a
	// TMPRL1100 non-determinism error on replay. The `patched()` gate
	// returns `false` for those legacy histories; we synthesize the same
	// implicit registry the old code carried (Excalidraw was the only
	// eager-routing server) so downstream activity scheduling stays
	// identical to what the history recorded. Live runs always hit the
	// `true` branch and read from the DB-backed activity.
	const registry = patched("default-mcp-eager-routing-v1")
		? await listDefaultEnabledMcpServersActivity()
		: [
				{
					key: "excalidraw",
					name: "Excalidraw",
					eagerKeywords: ["excalidraw"],
					eagerToolName: "create_view",
					suppressOnEager: [
						"fabric_create_frame",
						"fabric_create_slideshow",
					],
				},
			];
	if (registry.length === 0) {
		return { kind: "skipped" };
	}

	// Keyword gate. Case-insensitive substring match against the user's
	// most recent message. First-match wins (registry is sorted by name
	// ASC by the activity so the order is deterministic).
	const lowered = userMessage.toLowerCase();
	const matched = registry.find((row) =>
		row.eagerKeywords.some((kw) => lowered.includes(kw.toLowerCase())),
	);

	if (!matched) {
		return { kind: "skipped" };
	}

	// A registry row without an `eagerToolName` is a misconfiguration —
	// skip without I/O so we don't silently no-op past the resolve step.
	if (!matched.eagerToolName) {
		log.warn(
			"[DefaultMcpEagerRouting] Matched server has no eagerToolName configured — skipping",
			{
				executionId,
				serverKey: matched.key,
				serverName: matched.name,
			},
		);
		return { kind: "skipped" };
	}

	// The `try` block wraps the resolve, the fetch, and the
	// tool-name lookup so each sub-failure maps to a distinct
	// `failureKind` on the discriminated union. The mapping is:
	//
	//   - resolved === null              → "no-config"
	//   - fetch / resolve throws          → "server-unreachable"
	//   - eager tool absent from result  → "schema-mismatch"
	//
	// The caller (`executeIterativePhase` switch) consumes the result
	// and pushes a `mcp_default_tool_failed` payload onto
	// `state.mcpDefaultToolSignals` for analytics forwarding.
	try {
		// Schedule the activity under the name recorded in history. New
		// runs go through `findDefaultMcpConfigActivity`; pre-rename
		// replays match the legacy `findExcalidrawConfigActivity` name
		// (both aliases call the same parameterized handler).
		const findArgs = {
			serverKey: matched.key,
			enabledMcpConfigIds: enabledMcpConfigIds ?? null,
			userId,
			organizationId,
		};
		const resolved = patched("default-mcp-eager-routing-v1")
			? await findDefaultMcpConfigActivity(findArgs)
			: await findExcalidrawConfigActivity(findArgs);

		if (!resolved) {
			log.info(
				"[DefaultMcpEagerRouting] No tenant MCPConfig for matched default server — returning service-down (no-config)",
				{
					executionId,
					serverKey: matched.key,
					userId,
					organizationId: organizationId ?? null,
				},
			);
			return {
				kind: "service-down",
				serverKey: matched.key,
				serverName: matched.name,
				failureKind: "no-config",
				// No underlying exception — the resolve returned null
				// cleanly. Empty string keeps the analytics payload
				// non-null without inventing a fake error message.
				errorMessage: "",
			};
		}

		const tools = await fetchToolsFromServerIds(
			[resolved.configId],
			userId,
			organizationId,
		);
		const eagerTool = tools.find(
			(t) => t.toolName === matched.eagerToolName,
		);

		if (!eagerTool) {
			log.warn(
				"[DefaultMcpEagerRouting] Config resolved but eager tool not found in fetched tool list — returning service-down (schema-mismatch)",
				{
					executionId,
					serverKey: matched.key,
					configId: resolved.configId,
					eagerToolName: matched.eagerToolName,
					fetchedToolNames: tools.map((t) => t.toolName),
				},
			);
			return {
				kind: "service-down",
				serverKey: matched.key,
				serverName: matched.name,
				failureKind: "schema-mismatch",
				errorMessage: sanitizeMcpErrorMessage(
					`eager tool "${matched.eagerToolName}" not present in fetched tool list (received ${tools.length} tools)`,
				),
			};
		}

		discoveredTools[matched.eagerToolName] = {
			description: eagerTool.description,
			inputSchema: eagerTool.inputSchema,
		};
		discoveredToolConfigIds[matched.eagerToolName] = resolved.configId;
		for (const suppressed of matched.suppressOnEager) {
			suppressedFrameTools.add(suppressed);
		}

		log.info(
			"[DefaultMcpEagerRouting] Eager-loaded tool; suppressing frame tools for this turn",
			{
				executionId,
				serverKey: matched.key,
				toolName: matched.eagerToolName,
				configId: resolved.configId,
				suppressed: matched.suppressOnEager,
			},
		);
		return {
			kind: "eager-loaded",
			serverKey: matched.key,
			toolName: matched.eagerToolName,
			configId: resolved.configId,
		};
	} catch (error) {
		log.warn(
			"[DefaultMcpEagerRouting] Resolve/fetch threw — returning service-down (server-unreachable)",
			{
				executionId,
				serverKey: matched.key,
				error: String(error),
			},
		);
		return {
			kind: "service-down",
			serverKey: matched.key,
			serverName: matched.name,
			failureKind: "server-unreachable",
			errorMessage: sanitizeMcpErrorMessage(error),
		};
	}
}

/**
 * @deprecated The inline-CTA frame has been generalized to the
 *   `DefaultMcpStatusCard`. The caller now emits
 *   {@link FABRIC_DEFAULT_MCP_STATUS_CTA} for both the connection-needed
 *   and service-down paths under the new tool name
 *   `fabric_default_mcp_status` (see {@link FABRIC_DEFAULT_MCP_STATUS}).
 *
 *   Retained because:
 *     - The Playwright scenario `nexus-excalidraw-routing.spec.ts`
 *       (scenario 2) asserts `data-testid="connect-excalidraw-card"`,
 *       and the frontend dispatcher continues to accept the legacy tool
 *       name as a soft-deprecated alias (see
 *       `apps/web/modules/saas/ai/components/CopilotPage.tsx`).
 *     - Replay determinism: pre-rename workflow histories that already
 *       stamped this exact object onto a `state.toolCalls` entry must
 *       continue to deserialize identically on worker restart.
 *
 *   No new code path stamps this constant onto a tool-call. Remove
 *   once the Playwright scenario is migrated to the new testid and the
 *   deprecation window for in-flight histories closes.
 *
 * CTA payload for the legacy connection-needed branch — emitted as a
 * synthetic tool result so the frontend's status card renders inline
 * in the assistant turn. Copy is part of the contract — both the unit
 * + E2E specs assert exact strings.
 */
export const FABRIC_CONNECT_EXCALIDRAW_CTA = {
	title: "Connect Excalidraw to render diagrams in chat",
	body: "Your prompt mentioned Excalidraw, but the Excalidraw MCP server isn't connected for this account. Connect it once and Nexus will render editable diagrams inline.",
	primaryAction: {
		label: "Connect Excalidraw",
		href: "/app/mcp-servers?focus=excalidraw",
	},
} as const;

/**
 * Synthetic tool-call name emitted by the iterative-execution phase
 * when the eager-routing helper short-circuits to a status card. The
 * frontend dispatcher in `CopilotPage.tsx` matches this name (alongside
 * the legacy `"fabric_connect_excalidraw_cta"`) and routes the call
 * result to `<DefaultMcpStatusCard>`.
 *
 * Defined as a single source-of-truth string constant so:
 *   - Refactors can trace the name back to its emission site without
 *     grep guesses against a 4000-line workflow file.
 *   - The E2E specs can import the constant rather than re-typing
 *     the magic string.
 *
 * @see FABRIC_DEFAULT_MCP_STATUS_CTA — the locked copy for the
 *   connection-needed variant of the structured-CTA payload.
 */
export const FABRIC_DEFAULT_MCP_STATUS = "fabric_default_mcp_status" as const;

/**
 * Locked copy + action for the `connection-needed` variant of the
 * `fabric_default_mcp_status` payload — the structured CTA the
 * frontend's `<DefaultMcpStatusCard>` renders when a default-enabled
 * MCP server has no `MCPConfig` row for the current tenant. For
 * Excalidraw post-backfill this branch is effectively unreachable, but
 * the emission lives on so a future default-enabled server (Mermaid,
 * etc.) — or a user who manually disables a default server — sees the
 * connect-card affordance.
 *
 * The `service-down` variant of the payload carries locked copy
 * stamped inline at the emission site (parameterized on the resolved
 * server's display name) so the title/body lives next to its only call
 * site rather than as a second constant.
 */
export const FABRIC_DEFAULT_MCP_STATUS_CTA = {
	title: "Connect Excalidraw to render diagrams in chat",
	body: "Your prompt mentioned Excalidraw, but the Excalidraw MCP server isn't connected for this account. Connect it once and Nexus will render editable diagrams inline.",
	primaryAction: {
		label: "Connect Excalidraw",
		href: "/app/mcp-servers?focus=excalidraw",
	},
} as const;

/**
 * Execute the iterative phase of the orchestrator workflow.
 *
 * This is the core of the iterative execution pattern - instead of planning
 * all steps upfront, the LLM sees the current state and decides what to do next.
 */
export async function executeIterativePhase(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	modeConfig: ExecutionModeConfig,
	_altkConfig: ALTKConfig,
	updateProgress: (phase: string, message: string) => void,
	waitForApproval: () => Promise<ApprovalSignalData | null>,
	isCancelled: () => boolean,
): Promise<
	PhaseResult<{
		finalResponse: string;
		authRequired?: { configId: string; serverName: string };
	}>
> {
	log.info("Starting iterative execution phase", {
		executionId: state.executionId,
		maxIterations: modeConfig.maxIterations || BUDGET.defaultMaxIterations,
	});

	updateProgress("iterating", "Starting iterative execution...");

	// Initialize conversation history with any prior conversation context
	// This allows follow-up questions to reference previous responses
	const priorHistory: IterativeMessage[] = (input.history || []).map((h) => ({
		role: h.role as "user" | "assistant",
		content: h.content,
		timestamp: new Date().toISOString(),
	}));

	// Append attached image context to user message so LLM knows about them
	// These are S3 storage paths (not URLs) - the image generation activity downloads from S3 directly
	let userContent = state.enrichedMessage;
	if (input.attachedImageUrls?.length) {
		userContent += `\n\n[ATTACHED IMAGES: ${input.attachedImageUrls.length} image(s). Storage paths: ${input.attachedImageUrls.join(", ")}. Use fabric_generate_image with the storage path as inputImage parameter for image editing/modification tasks.]`;
	}

	// Add the current user message after the history
	const conversationHistory: IterativeMessage[] = [
		...priorHistory,
		{
			role: "user",
			content: userContent,
			timestamp: new Date().toISOString(),
		},
	];

	log.info("[IterativeExecution] Initialized conversation history", {
		priorHistoryLength: priorHistory.length,
		totalHistoryLength: conversationHistory.length,
	});

	// Sync to state
	state.iterativeConversationHistory = [...conversationHistory];
	state.currentIteration = 0;

	// Initialize with meta-tools only (Tool Search pattern - 85% token reduction)
	// OAuth tools from preloadedResources are still included if available
	const metaTools = getMetaTools();
	const discoveredTools: Record<string, unknown> = {}; // Tools found via search_tools
	const discoveredToolConfigIds: Record<string, string> = {}; // configId per discovered tool for direct execution
	// Server names from pre-loaded MCP configs — used in system prompt for focused agents
	let preloadedServerNames: string[] = [];
	// Non-empty only when we took the stub-catalog path (preloaded count
	// exceeded `TOOLS.eagerLoadThreshold`). See orchestrator-config TOOLS doc.
	let preloadedToolCatalog = "";

	if (input.enabledMcpConfigIds && input.enabledMcpConfigIds.length > 0) {
		log.info(
			"[IterativeExecution] Agent has assigned MCP servers — pre-loading tools",
			{ configCount: input.enabledMcpConfigIds.length },
		);
		try {
			const preloadedMcpTools = await preloadMcpToolsForConfigsActivity({
				enabledMcpConfigIds: input.enabledMcpConfigIds,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			preloadedServerNames = [
				...new Set(preloadedMcpTools.map((t) => t.serverName)),
			];

			// Decide eager vs. stub-catalog by total preloaded count.
			if (preloadedMcpTools.length <= TOOLS.eagerLoadThreshold) {
				for (const tool of preloadedMcpTools) {
					discoveredTools[tool.toolName] = {
						description: tool.description,
						inputSchema: tool.inputSchema,
					};
					discoveredToolConfigIds[tool.toolName] = tool.configId;
				}
				log.info(
					`[IterativeExecution] Pre-loaded ${preloadedMcpTools.length} tools (eager, ≤ threshold ${TOOLS.eagerLoadThreshold})`,
					{ servers: preloadedServerNames },
				);
			} else {
				preloadedToolCatalog =
					buildPreloadedToolCatalog(preloadedMcpTools);
				log.warn(
					`[IterativeExecution] Pre-loaded MCP tool count (${preloadedMcpTools.length}) exceeds eager threshold (${TOOLS.eagerLoadThreshold}); injecting stub catalog into system prompt — schemas load on demand via search_tools`,
					{
						preloaded: preloadedMcpTools.length,
						threshold: TOOLS.eagerLoadThreshold,
						servers: preloadedServerNames,
					},
				);
			}
		} catch (preloadError) {
			log.warn(
				"[IterativeExecution] Failed to pre-load MCP tools — will fall back to search_tools",
				{ error: String(preloadError) },
			);
		}
	}

	// Pre-register project_rag_query when a project is attached so the LLM
	// can use it immediately without wasting iterations on search_tools.
	// Also pre-register search_slack_messages / search_teams_messages so the
	// agent can fetch live integration content when project_rag_query (which
	// only covers embedded Qdrant content) has nothing for a Slack/Teams query.
	if (input.projectId) {
		discoveredTools.project_rag_query = {
			description:
				"Search the attached project's documents, contexts, and codebase analysis for relevant information. Use this when answering questions about the project, its requirements, architecture, or any project-specific context.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"The search query to find relevant project context. Be specific for better results.",
					},
				},
				required: ["query"],
			},
		};
		discoveredTools.search_slack_messages = {
			description:
				"Search live Slack messages in channels linked to the attached project. Use this when the user asks about Slack discussions, decisions, async chat, or what teammates said in Slack. Calls the Slack API directly — does NOT depend on RAG ingestion, so it works even when project_rag_query returns no Slack content.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Search query — keywords, phrases, topics, or 'from:@user' to filter by sender.",
					},
					limit: {
						type: "number",
						description:
							"Maximum number of messages to return (default: 15, max: 50).",
					},
				},
				required: ["query"],
			},
		};
		discoveredTools.search_teams_messages = {
			description:
				"Search live Microsoft Teams messages in chats and channels linked to the attached project. Use this when the user asks about Teams discussions, decisions, async chat, or what teammates said in Teams. Calls the Microsoft Graph API directly — does NOT depend on RAG ingestion.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Search query — keywords, phrases, or topics relevant to the discussion you want to find.",
					},
					limit: {
						type: "number",
						description:
							"Maximum number of raw messages per pass before relevance filtering (default: 15, max: 50).",
					},
				},
				required: ["query"],
			},
		};
		log.info(
			"[IterativeExecution] Pre-registered project_rag_query, search_slack_messages, and search_teams_messages tools",
			{
				projectId: input.projectId,
			},
		);
	}

	// Start with meta-tools + any OAuth tools + any pre-loaded MCP tools
	let availableTools = {
		...metaTools,
		...formatToolsForLLM(state.preloadedResources, discoveredTools),
	};

	log.info("Iterative phase initialized", {
		metaToolCount: Object.keys(metaTools).length,
		oauthToolCount: Object.keys(formatToolsForLLM(state.preloadedResources))
			.length,
		preloadedMcpToolCount: Object.keys(discoveredTools).length,
		totalInitialTools: Object.keys(availableTools).length,
	});

	// ─── Default-MCP eager surface routing ───────────────────────────────────
	//
	// Suppression set the workflow propagates into `runAgentIteration` so
	// the activity drops these names from the tool map handed to the LLM.
	// Initialized once for the whole phase (the helper only runs once).
	const suppressedFrameTools = new Set<string>();
	// Tool names backed by an `isManagedDefault=true` MCPConfig.
	// Populated when the eager-routing helper successfully resolves a
	// managed-default config — the `executeMcpTool` failure wrapper at
	// the call site below uses this set to decide whether to push a
	// `mcp_default_tool_failed` payload with
	// `failureKind: "tool-call-error"` onto `state.mcpDefaultToolSignals`.
	const managedDefaultToolNames = new Set<string>();
	// Parallel map for the `serverKey` so the analytics payload can be
	// stamped with the same `serverKey` the helper resolved (avoids
	// re-resolving the config at the call site).
	const managedDefaultToolServerKeys = new Map<string, string>();
	let serviceDownShortCircuit: {
		response: string;
		toolCallId: string;
	} | null = null;

	const routingResult = await applyDefaultMcpEagerRouting({
		surface: input.surface,
		userMessage: state.enrichedMessage,
		enabledMcpConfigIds: input.enabledMcpConfigIds,
		userId: input.userId,
		organizationId: input.organizationId,
		discoveredTools,
		discoveredToolConfigIds,
		suppressedFrameTools,
		executionId: state.executionId,
	});

	switch (routingResult.kind) {
		case "skipped":
			break;
		case "eager-loaded": {
			// Defense in depth — also drop the suppressed name from the
			// workflow-level `availableTools` map so the activity never even
			// has the chance to surface it. The activity drops it again as a
			// belt-and-braces safeguard (see `runAgentIteration`'s
			// `suppressedToolNames` handling).
			availableTools = {
				...metaTools,
				...formatToolsForLLM(state.preloadedResources, discoveredTools),
			};
			for (const name of suppressedFrameTools) {
				if (name in availableTools) {
					delete availableTools[name];
				}
			}
			// Remember which tool name is backed by a managed-default
			// MCPConfig so the `executeMcpTool` failure wrapper at the call
			// site can stamp the matching `mcp_default_tool_failed` payload.
			// The helper guarantees the config it eager-loaded is
			// `isManagedDefault=true` (it only resolves `defaultEnabled=true`
			// registry rows; custom servers can't be default-enabled in v1).
			managedDefaultToolNames.add(routingResult.toolName);
			managedDefaultToolServerKeys.set(
				routingResult.toolName,
				routingResult.serverKey,
			);
			break;
		}
		case "service-down": {
			// Emit a synthetic `fabric_default_mcp_status` tool result so
			// the frontend dispatcher renders the inline status card in
			// the assistant turn. The new tool name replaces the legacy
			// `fabric_connect_excalidraw_cta` — the frontend dispatcher
			// in `CopilotPage.tsx` continues to accept the legacy name
			// as a deprecated alias so in-flight histories from before
			// the rename keep rendering correctly.
			//
			// The payload's `kind` discriminator picks the branch on the
			// `<DefaultMcpStatusCard>`. The discriminated union forbids a
			// `primaryAction` field on the `service-down` branch (no
			// inline retry in v1) — the frontend type guard
			// `isDefaultMcpStatusCta` enforces that at the type level.
			// The title/body use locked copy parameterized on the
			// resolved server's display name.
			const ctaToolCallId = `tc-cta-${state.executionId}`;
			const serviceDownTitle = `${routingResult.serverName} is temporarily unavailable`;
			const serviceDownBody = `We couldn't reach the ${routingResult.serverName} service to render your diagram. Try again in a moment.`;
			state.toolCalls.push({
				id: ctaToolCallId,
				name: FABRIC_DEFAULT_MCP_STATUS,
				args: {
					reason: "service-down",
					serverKey: routingResult.serverKey,
					failureKind: routingResult.failureKind,
				},
				result: {
					type: "structured_cta",
					kind: "service-down",
					serverKey: routingResult.serverKey,
					serverName: routingResult.serverName,
					title: serviceDownTitle,
					body: serviceDownBody,
				},
				status: "success",
				durationMs: 0,
			});

			// Push the analytics payload onto the workflow state's signal
			// array. The per-event SSE forwarder downstream fires
			// `useAnalytics().trackEvent("mcp_default_tool_failed", …)`
			// on the client.
			//
			// The `surface` cast is sound: `routingResult.kind === "service-down"`
			// implies the surface gate in `applyDefaultMcpEagerRouting`
			// (which returns `skipped` otherwise) already accepted the
			// `input.surface` value, so it is one of the routed-surface
			// literals at runtime. The compile-time guard
			// `AssertSurfaceCoverage` keeps this cast tight against
			// future surface additions.
			state.mcpDefaultToolSignals.push({
				kind: "failed",
				surface: input.surface as McpDefaultToolSurface,
				serverKey: routingResult.serverKey,
				failureKind: routingResult.failureKind,
				errorMessage: routingResult.errorMessage,
				executionId: state.executionId,
				organizationId: input.organizationId ?? null,
			});

			// System-prompt addendum tells the model to acknowledge the
			// CTA and NOT compensate by calling `fabric_create_frame`.
			// Defense in depth on top of the suppression set.
			state.enrichedSystemPrompt = `${state.enrichedSystemPrompt}\n\nDEFAULT MCP SERVICE DOWN — ${routingResult.serverName} is currently unavailable. A status card has been shown to the user. Do NOT attempt to compensate with fabric_create_frame or any other rendering tool. Acknowledge briefly that the service is unavailable and stop.`;
			suppressedFrameTools.add("fabric_create_frame");
			suppressedFrameTools.add("fabric_create_slideshow");

			// Brief acknowledgment text — short-circuits the iteration
			// loop with a deterministic response so we don't burn an LLM
			// call on the service-down branch.
			serviceDownShortCircuit = {
				response: `${routingResult.serverName} is temporarily unavailable. I've shown a status card above. Please try again in a moment.`,
				toolCallId: ctaToolCallId,
			};

			log.info(
				"[DefaultMcpEagerRouting] Service down — emitted status card and short-circuiting iteration",
				{
					executionId: state.executionId,
					serverKey: routingResult.serverKey,
					failureKind: routingResult.failureKind,
					toolCallId: ctaToolCallId,
				},
			);
			break;
		}
	}

	// Drain the service-down analytics signal pushed above (if any).
	// The flusher is a no-op when the cursor is already at the end, so
	// calling it unconditionally is safe. We do this BEFORE the
	// short-circuit return so the SSE event reaches the client before
	// the iteration ends.
	await flushMcpDefaultToolSignals(state);

	// Short-circuit out of the iteration loop entirely on the service-down
	// branch — we already have the final user-facing response.
	if (serviceDownShortCircuit) {
		return {
			success: true,
			data: { finalResponse: serviceDownShortCircuit.response },
			shouldContinue: true,
		};
	}

	// Main iteration loop
	while (!isCancelled()) {
		state.currentIteration++;
		const iteration = state.currentIteration;

		updateProgress("iterating", `Iteration ${iteration}...`);

		// Prune old tool results to prevent context bloat
		if (state.currentIteration > TOOL_RESULTS.recentIterationsToKeep) {
			pruneConversationHistory(
				conversationHistory,
				state.currentIteration,
			);
		}

		// Check budget before each iteration
		const budgetCheck = checkIterationBudget(
			state.iterationCosts,
			modeConfig,
		);
		if (!budgetCheck.withinBudget) {
			// Surface the exhaustion to the UI. Keep the soft-degrade
			// behavior (run synthesis), but emit a LimitSignal so the frontend can
			// render a banner + TokenBudgetCard in red. Logged at error level so
			// it shows up in Sentry with the execution identifiers attached.
			const budgetStatus = buildBudgetStatus(
				state.iterationCosts,
				modeConfig,
				budgetCheck.reason,
			);
			const internalLimitSignal: LimitSignal = {
				kind: "internal_budget",
				message: budgetCheck.reason ?? "Internal token budget exceeded",
				budget: budgetStatus,
			};
			state.limitSignals.push(internalLimitSignal);
			log.error("Orchestrator token budget exhausted", {
				reason: budgetCheck.reason,
				executionId: state.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				budget: budgetStatus,
			});
			updateProgress("synthesizing", "Summarizing findings...");

			// Minimum useful synthesis length. The exhaustion synthesis used to
			// occasionally return "Task completed." (15 chars) on long Sonnet
			// runs — well below anything actionable. Anything under this
			// threshold is treated as a degenerate output and we fall back to
			// the deterministic `summarizeAccomplishments` static summary.
			const MIN_USEFUL_SYNTHESIS_CHARS = 200;

			let synthesisContent = "";
			try {
				// Do NOT add an extra pruneConversationHistory pass here. The
				// per-iteration prune already retains the last
				// `recentIterationsToKeep` iterations of tool results;
				// pruning again strips them and synthesis sees only
				// `[Previous tool result pruned]` placeholders.
				const synthesisResult = await runAgentIteration({
					conversationHistory,
					availableTools: {}, // No tools → forces text response
					systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
					userId: input.userId,
					organizationId: input.organizationId,
					executionId: state.executionId,
					iteration: state.currentIteration + 1,
					maxStepsPerIteration: 1,
					modelOverride: input.modelOverride,
					// Synthesis must return plain text; skip auto-binding of
					// skill tools that would otherwise make the model emit
					// tool_calls and break the type === "response" branch.
					enableSkillTools: false,
				});

				// Track synthesis cost
				state.iterationCosts.push({
					iteration: state.currentIteration + 1,
					inputTokens: synthesisResult.usage.inputTokens,
					outputTokens: synthesisResult.usage.outputTokens,
					timestamp: new Date().toISOString(),
				});

				if (synthesisResult.type === "response") {
					synthesisContent = synthesisResult.content;
				}

				log.info("LLM synthesis completed", {
					responseLength: synthesisContent.length,
					resultType: synthesisResult.type,
					inputTokens: synthesisResult.usage.inputTokens,
					outputTokens: synthesisResult.usage.outputTokens,
				});

				// One-shot retry when the model returns under the threshold.
				// Sonnet's adherence to "minimum one paragraph" is imperfect:
				// even with substantive context the model occasionally emits
				// "Task completed." (15 chars) and exits early. A second
				// attempt with an explicit length-failure callout reliably
				// recovers in our tests. Cheap (~3K input tokens, single
				// completion) and runs only on the rare failure path.
				if (
					synthesisContent.trim().length < MIN_USEFUL_SYNTHESIS_CHARS
				) {
					log.warn(
						"Synthesis output too short — retrying with stricter instructions",
						{
							firstAttemptChars: synthesisContent.trim().length,
							minRequired: MIN_USEFUL_SYNTHESIS_CHARS,
						},
					);
					const retrySystemPrompt = `${SYNTHESIS_SYSTEM_PROMPT}\n\nRETRY NOTE: A previous attempt returned a response under ${MIN_USEFUL_SYNTHESIS_CHARS} characters. That response was discarded. Produce the full structured summary now with all three required sections (## Summary, ## What I did, ## What's still needed). Do NOT respond with single-line acknowledgments like "Task completed." — that mode of response failed validation.`;
					const retryResult = await runAgentIteration({
						conversationHistory,
						availableTools: {},
						systemPrompt: retrySystemPrompt,
						userId: input.userId,
						organizationId: input.organizationId,
						executionId: state.executionId,
						iteration: state.currentIteration + 2,
						maxStepsPerIteration: 1,
						modelOverride: input.modelOverride,
						enableSkillTools: false,
					});
					state.iterationCosts.push({
						iteration: state.currentIteration + 2,
						inputTokens: retryResult.usage.inputTokens,
						outputTokens: retryResult.usage.outputTokens,
						timestamp: new Date().toISOString(),
					});
					if (
						retryResult.type === "response" &&
						retryResult.content.trim().length >
							synthesisContent.trim().length
					) {
						synthesisContent = retryResult.content;
					}
					log.info("LLM synthesis retry completed", {
						responseLength: synthesisContent.length,
						resultType: retryResult.type,
						inputTokens: retryResult.usage.inputTokens,
						outputTokens: retryResult.usage.outputTokens,
					});
				}
			} catch (synthesisError) {
				log.warn(
					"LLM synthesis failed, falling back to static summary",
					{
						error: String(synthesisError),
					},
				);
			}

			if (synthesisContent.trim().length < MIN_USEFUL_SYNTHESIS_CHARS) {
				log.warn(
					"Synthesis output too short after retry — falling back to deterministic summary",
					{
						actualChars: synthesisContent.trim().length,
						minRequired: MIN_USEFUL_SYNTHESIS_CHARS,
					},
				);
				synthesisContent = summarizeAccomplishments(state);
			}

			// Stash the summary on state so buildWorkflowOutput can surface
			// it as `handoffRecommended` for the frontend's "Continue in new
			// chat" CTA. Independent of finalResponse — the workflow itself
			// completes successfully with the synthesis as its response, but
			// the handoff signal tells the UI this thread is done.
			state.pendingHandoff = {
				reason:
					budgetCheck.reason ?? "Conversation context limit reached",
				summary: synthesisContent,
			};

			return {
				success: true,
				data: { finalResponse: synthesisContent },
				shouldContinue: true,
			};
		}

		// Inject budget warning into system prompt when approaching limits
		const budgetWarning = getBudgetWarning(
			state.iterationCosts,
			modeConfig,
		);
		let iterationSystemPrompt = budgetWarning
			? `${state.enrichedSystemPrompt}${budgetWarning}`
			: state.enrichedSystemPrompt;

		// When images are attached, hint the LLM to search for image tools
		if (input.attachedImageUrls?.length && iteration === 1) {
			iterationSystemPrompt += `\n\nIMPORTANT: The user has attached image(s). You MUST use the search_tools function to find image generation/editing tools (e.g. search for "image generation") before responding. Do NOT describe images textually — use the discovered tool to process or generate images.`;
		}

		// When image generation results exist, instruct LLM to inline them
		const imageToolResults = state.toolCalls.filter(
			(tc) =>
				tc.name === "fabric_generate_image" &&
				tc.status === "success" &&
				typeof tc.result === "string",
		);
		if (imageToolResults.length > 0) {
			iterationSystemPrompt += `\n\nCRITICAL IMAGE DISPLAY RULE: You have generated ${imageToolResults.length} image(s) using fabric_generate_image. For EACH design/variation in your response, use this exact order:
1. Section heading (e.g., "## Design 1: Name")
2. Full text description of the design
3. The image markdown: ![Generated Image](url)

Place each ![Generated Image](url) AFTER the text description, NOT before it. Copy the exact URL from each tool result. Do NOT omit any image URLs.`;
		}

		// Focused-agent mode: when tools were pre-loaded from assigned MCP servers,
		// tell the model to use them directly instead of calling search_tools first.
		//
		// Stub-catalog mode re-emits the catalog every iteration (not just iter 1):
		// `runAgentIteration` is stateless, the system prompt isn't replayed via
		// `conversationHistory`, and post-compaction the model would otherwise lose
		// visibility of catalog tools whose schemas it hasn't yet pulled via
		// `search_tools`. Re-emitting costs ~1.5K tokens vs. the 48K/iter the
		// eager-schema path would have spent.
		if (preloadedToolCatalog) {
			iterationSystemPrompt += `\n\nFOCUSED AGENT — The catalog below lists the MCP tools exposed by ${preloadedServerNames.join(", ")}. Their schemas are NOT pre-attached. Before invoking a tool from the catalog, call search_tools with the exact tool name (e.g., search_tools({ query: "<tool_name>" })) to load its inputSchema; the loaded schema persists for the rest of this conversation. Tools NOT in the catalog (search_tools, project_rag_query, search_slack_messages, search_teams_messages, OAuth integrations such as Microsoft Teams or GitHub) are already attached and can be called directly without a search_tools roundtrip.\n\n${preloadedToolCatalog}`;
		} else if (
			iteration === 1 &&
			preloadedServerNames.length > 0 &&
			Object.keys(discoveredTools).length > 0
		) {
			const preloadedToolList = Object.keys(discoveredTools).join(", ");
			iterationSystemPrompt += `\n\nFOCUSED AGENT — Pre-loaded tools from ${preloadedServerNames.join(", ")}: ${preloadedToolList}. These tools are ALREADY available — call them directly. Do NOT call search_tools first; that wastes a round-trip and may return incorrect tools.`;
		} else if (
			// Fallback: for general agents, hint which servers are available so search_tools
			// can formulate targeted queries.
			iteration === 1 &&
			(state.preloadedResources?.mcpTools?.length ?? 0) > 0
		) {
			const serverNames = [
				...new Set(
					(state.preloadedResources?.mcpTools ?? []).map(
						(t) => t.serverName,
					),
				),
			];
			iterationSystemPrompt += `\n\nAvailable MCP integrations: ${serverNames.join(", ")}. Use search_tools with a query that includes the server name and action (e.g., "${serverNames[0]} create …") to reliably discover the right tools.`;
		}

		// Generic schema-adherence reminder when discovered tools are available.
		// Catches cases where a tool parameter is typed as "string" but requires
		// a JSON-encoded value (the model must JSON.stringify before passing).
		if (Object.keys(discoveredTools).length > 0) {
			iterationSystemPrompt += `\n\nTool usage: call every tool exactly as its inputSchema specifies. If a parameter is typed as "string" but its description says it expects JSON or an array, JSON.stringify() the value before passing it. Never call a tool with empty args {}.

CRITICAL: NEVER fill tool parameters with placeholder or example values (e.g. "your-repo-owner", "example-org", "my-repo", "YOUR_VALUE", "<owner>"). When required information like a repository owner, repo name, channel ID, or similar identifier is not explicitly stated by the user:
1. FIRST try to discover it using available tools (e.g. use "search_commits" with the commit SHA to find owner/repo, use "get_authenticated_user" to find the current user's GitHub login, use "list_repositories" to list available repos).
2. Only ask the user if the information cannot be discovered through tool calls.
Never guess or use example values — always use real data from API responses.`;
		}

		// Run agent iteration
		updateProgress(
			"thinking",
			iteration === 1
				? "Analyzing request..."
				: `Processing results (iteration ${iteration})...`,
		);

		log.info("Running agent iteration", {
			iteration,
			historyLength: conversationHistory.length,
			hasBudgetWarning: !!budgetWarning,
		});

		// Issue #5: Reduce steps per iteration when approaching budget limit
		// This prevents a single iteration from blowing past the budget by 3x
		const stepsPerIteration = budgetWarning
			? BUDGET.budgetWarningStepsPerIteration
			: BUDGET.defaultMaxStepsPerIteration;

		const iterationResult = await runAgentIteration({
			conversationHistory,
			availableTools,
			systemPrompt: iterationSystemPrompt,
			userId: input.userId,
			organizationId: input.organizationId,
			executionId: state.executionId,
			iteration,
			maxStepsPerIteration: stepsPerIteration,
			modelOverride: input.modelOverride,
			// Pass paperclip image attachments to the model as real pixels on
			// the first iteration only — vision-capable models then SEE the
			// image instead of relying solely on its RAG-extracted description.
			// Gated to iteration 1 so images aren't re-sent (and re-billed) on
			// every follow-up step.
			...(iteration === 1 && input.attachedDocumentIds?.length
				? { attachedDocumentIds: input.attachedDocumentIds }
				: {}),
			// Defense-in-depth suppression for surface-aware routing
			// (e.g. the default-MCP eager router drops `fabric_create_frame`
			// so the model can't substitute a frame for a real renderer).
			// Empty when no helper opted in — non-routed surfaces see no
			// behavior change.
			...(suppressedFrameTools.size > 0
				? { suppressedToolNames: [...suppressedFrameTools] }
				: {}),
		});

		// If the iteration classifier tagged a provider limit/quota
		// error, bubble it into state so it reaches the workflow output + SSE.
		// The iteration itself has already soft-degraded to a text response, so
		// the loop continues normally — we only need to preserve visibility.
		if (
			iterationResult.type === "response" &&
			iterationResult.limitSignal
		) {
			state.limitSignals.push(iterationResult.limitSignal);
			log.error("Provider limit signal detected in iteration", {
				iteration,
				executionId: state.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				kind: iterationResult.limitSignal.kind,
				provider: iterationResult.limitSignal.provider,
			});
		}

		// Track costs
		const iterInputTokens = iterationResult.usage.inputTokens;
		const iterOutputTokens = iterationResult.usage.outputTokens;
		state.iterationCosts.push({
			iteration,
			inputTokens: iterInputTokens,
			outputTokens: iterOutputTokens,
			timestamp: new Date().toISOString(),
		});

		const cumulativeTokens = state.iterationCosts.reduce(
			(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
			0,
		);
		const maxTokens =
			modeConfig.maxTotalTokens || BUDGET.defaultMaxTotalTokens;
		const budgetPct =
			maxTokens > 0
				? Math.round((cumulativeTokens / maxTokens) * 100)
				: 0;

		log.info("[IterativeExecution] Iteration token usage", {
			iteration,
			inputTokens: iterInputTokens,
			outputTokens: iterOutputTokens,
			iterationTotal: iterInputTokens + iterOutputTokens,
			cumulativeTokens,
			maxTotalTokens: maxTokens,
			budgetUsedPct: budgetPct,
			resultType: iterationResult.type,
		});

		// Stream error: the provider/gateway emitted a transient error and
		// the in-activity retry has already been spent. Fail the workflow
		// (status: failed, surfaced via SSE) without writing the error text
		// into iterativeConversationHistory — otherwise the error would
		// re-feed itself into every subsequent turn in this chat thread as
		// a poisoned "assistant message" the model has to reason past.
		if (iterationResult.type === "stream_error") {
			log.error("Iteration aborted by transient stream error", {
				iteration,
				executionId: state.executionId,
				message: iterationResult.message,
				partialChars: iterationResult.partialResponse.length,
			});
			return {
				success: false,
				error: `LLM stream error: ${iterationResult.message}`,
				shouldContinue: false,
			};
		}

		// Check if this is a final response
		if (iterationResult.type === "response") {
			let finalResponse = iterationResult.content;

			// Inject generated image URLs that the LLM may have omitted from its response
			const generatedImageUrls = state.toolCalls
				.filter(
					(tc) =>
						tc.name === "fabric_generate_image" &&
						tc.status === "success" &&
						typeof tc.result === "string",
				)
				.map((tc) => {
					const match = (tc.result as string).match(
						/!\[Generated Image\]\(([^)]+)\)/,
					);
					return match?.[1];
				})
				.filter((url): url is string => !!url);

			if (generatedImageUrls.length > 0) {
				const missingUrls = generatedImageUrls.filter(
					(url) => !finalResponse.includes(url),
				);

				log.info("Image URL injection check", {
					totalImageUrls: generatedImageUrls.length,
					missingUrlCount: missingUrls.length,
					includedByLLM:
						generatedImageUrls.length - missingUrls.length,
				});

				if (missingUrls.length > 0) {
					// Try to inline images into response sections
					// Pass all valid URLs so the function can distinguish real images
					// from broken/truncated image markdown the LLM may have written
					finalResponse = inlineImagesIntoResponse(
						finalResponse,
						missingUrls,
						generatedImageUrls,
					);
				}
			}

			log.info("Agent returned final response", {
				iteration,
				responseLength: finalResponse.length,
			});

			// Defensive flush before the phase exits successfully.
			// In practice the per-tool-call flush already drained every
			// signal, but the last iteration could still publish a signal
			// from the eager-routing helper (if applied late) or from a
			// trailing managed-default tool result, so we drain once more
			// to keep the analytics surface consistent.
			await flushMcpDefaultToolSignals(state);

			return {
				success: true,
				data: { finalResponse },
				shouldContinue: true,
			};
		}

		// Process tool calls
		const toolCalls = iterationResult.toolCalls;
		log.info("Agent requested tool calls", {
			iteration,
			toolCount: toolCalls.length,
			tools: toolCalls.map((tc) => tc.name),
		});

		// Process each tool call with safety layer
		for (const toolCall of toolCalls) {
			if (isCancelled()) {
				return {
					success: false,
					error: "Execution cancelled",
					shouldContinue: false,
				};
			}

			// ================================================================
			// SAFETY LAYER: Assess risk before execution
			// Respect autonomy level from user preferences or agent config
			// ================================================================
			const autonomyLevel = input.autonomyLevel ?? "BALANCED";
			const riskAssessment = assessToolCallRisk(toolCall, autonomyLevel);

			if (riskAssessment.requiresApproval) {
				log.info("Tool call requires approval", {
					toolName: toolCall.name,
					riskLevel: riskAssessment.riskLevel,
					reason: riskAssessment.reason,
				});

				// Create approval request
				state.pendingToolApproval = {
					toolCall: {
						id: toolCall.id,
						name: toolCall.name,
						args: toolCall.args,
					},
					riskLevel: riskAssessment.riskLevel,
					reason: riskAssessment.reason || "High-risk operation",
					iteration,
				};

				updateProgress(
					"awaiting_approval",
					`Approval needed: ${riskAssessment.reason}`,
				);
				state.status = "awaiting_approval";

				// Create approval task
				const approval = await createOrchestratorApprovalRequest({
					executionId: state.executionId,
					stepId: `iteration-${iteration}-${toolCall.id}`,
					stepDescription: `Tool: ${toolCall.name} - ${riskAssessment.reason}`,
					stepType: "tool_call",
					userId: input.userId,
					organizationId: input.organizationId,
					riskScore:
						riskAssessment.riskLevel === "critical"
							? 95
							: riskAssessment.riskLevel === "high"
								? 75
								: 50,
					riskLevel: riskAssessment.riskLevel,
				});

				state.pendingApproval = {
					approvalId: approval.approvalId,
					stepId: `iteration-${iteration}-${toolCall.id}`,
					reason: riskAssessment.reason || "High-risk operation",
				};

				// Wait for approval
				const decision = await waitForApproval();

				// Update approval task status
				await updateApprovalTaskStatus({
					approvalId: approval.approvalId,
					approved: decision?.approved || false,
					feedback: decision?.feedback,
				});

				// Clear pending states
				state.pendingToolApproval = null;
				state.pendingApproval = null;
				state.approvalDecision = null;

				if (!decision?.approved) {
					log.info("Tool call rejected", {
						toolName: toolCall.name,
						feedback: decision?.feedback,
					});

					// Add rejection to conversation
					conversationHistory.push({
						role: "assistant",
						content: "",
						toolCalls: [
							{
								id: toolCall.id,
								name: toolCall.name,
								args: toolCall.args,
								...(toolCall.providerMetadata && {
									providerMetadata: toolCall.providerMetadata,
								}),
							},
						],
						timestamp: new Date().toISOString(),
						iteration,
					});
					conversationHistory.push({
						role: "tool",
						content: `Tool call rejected by user: ${decision?.feedback || "No reason provided"}`,
						toolCallId: toolCall.id,
						timestamp: new Date().toISOString(),
						iteration,
					});

					// Continue to next tool call (or let LLM adapt)
					continue;
				}

				state.status = "running";
				updateProgress("iterating", `Executing: ${toolCall.name}`);
			}

			// ================================================================
			// Execute the tool
			// ================================================================
			updateProgress("executing_tool", `Calling ${toolCall.name}...`);

			log.info("Executing tool", {
				toolName: toolCall.name,
				args: Object.keys(toolCall.args),
			});

			const startTime = Date.now();
			let toolResult: unknown;
			let toolError: string | undefined;
			let mcpAppResourceUri: string | undefined;
			let mcpAppConfigId: string | undefined;
			const preloadedTool =
				state.preloadedResources?.toolMap[toolCall.name];

			try {
				// ================================================================
				// SPECIAL HANDLING: search_tools meta-tool
				// Discovers capabilities on-demand via semantic search
				// ================================================================
				if (toolCall.name === "search_tools") {
					updateProgress("executing_tool", "Searching for tools...");
					log.info("Executing search_tools meta-tool", {
						args: toolCall.args,
					});

					// Execute semantic search for relevant tools
					// CRITICAL: Use workflow input's enabledMcpConfigIds and enabledIntegrationIds
					// NOT database preferences - workflow input represents the user's current session preferences
					const searchResult = await searchAvailableTools({
						query: (toolCall.args.query as string) || "",
						originalQuery: input.message,
						category: toolCall.args.category as
							| ToolCategory
							| undefined,
						limit: (toolCall.args.limit as number) || 10,
						minConfidence: 0.3,
						userId: input.userId,
						organizationId: input.organizationId,
						enabledMcpConfigIds:
							input.enabledMcpConfigIds ?? undefined,
						enabledIntegrationIds:
							input.enabledIntegrationIds ?? undefined,
						enabledFabricToolIds:
							input.enabledFabricToolIds ?? undefined,
					});

					// Format result for agent
					const toolsFound = searchResult.results.map((r) => ({
						name: r.toolName,
						description: r.description,
						confidence: r.confidence,
						serverName: r.serverName,
						category: r.category,
						readOnly: r.isReadOnly,
						inputSchema: r.inputSchema, // Include schema so LLM knows required parameters
					}));

					// Also search for available agents that can handle this task
					const agentToolsFound: Array<{
						name: string;
						description: string;
						confidence: number;
						type: string;
					}> = [];
					try {
						const agentSearchResult = await searchAvailableAgents({
							query: (toolCall.args.query as string) || "",
							userId: input.userId,
							organizationId: input.organizationId,
							enabledAgentIds: input.enabledAgentIds ?? undefined,
						});

						// Create delegation tools for matched agents
						for (const agent of agentSearchResult.results) {
							const delegationToolName = `delegate_to_${agent.agentId}`;
							const skillsSummary =
								agent.skills.length > 0
									? ` Skills: ${agent.skills.join(", ")}.`
									: "";
							const delegationDescription = `Delegate a task to the "${agent.displayName}" AI agent. ${agent.description}${skillsSummary} Use this when you need to hand off a complex sub-task to this specialized agent.`;

							discoveredTools[delegationToolName] = {
								description: delegationDescription,
								inputSchema: {
									type: "object",
									properties: {
										message: {
											type: "string",
											description:
												"Detailed task description to delegate to this agent. Be specific about what you need done.",
										},
									},
									required: ["message"],
								},
							};

							agentToolsFound.push({
								name: delegationToolName,
								description: delegationDescription,
								confidence: agent.confidence,
								type: "agent_delegation",
							});
						}

						if (agentSearchResult.results.length > 0) {
							log.info(
								`[MetaTool] Discovered ${agentSearchResult.results.length} agents for delegation`,
								{
									agents: agentSearchResult.results.map(
										(a) => a.agentId,
									),
								},
							);
						}
					} catch (agentSearchError) {
						log.warn(
							"[MetaTool] Agent search failed, continuing with tools only",
							{ error: String(agentSearchError) },
						);
					}

					// Also search for enabled workflow integrations (NHTSA, etc.)
					// These are discovered via DB query + semantic matching, not Qdrant
					const integrationToolsFound: Array<{
						name: string;
						description: string;
						confidence: number;
						category: string;
						inputSchema?: Record<string, unknown>;
					}> = [];
					let integrationsFound = 0;
					// Executability is now decided by the activity from the shared
					// executor registry, which the sandbox cannot import. Gated by
					// patched() because it changes how already-recorded
					// `searchAvailableIntegrations` results are interpreted: a
					// pre-patch history may contain providers the old code
					// filtered out, and reconstructing different discoveredTools
					// would shift every later activity input.
					const chatIntegrationRegistryV1 = patched(
						"loom-chat-integration-executor-registry-v1",
					);
					try {
						const integrationSearchResult =
							await searchAvailableIntegrations({
								query: (toolCall.args.query as string) || "",
								limit: 5,
								minConfidence: 0.3,
								userId: input.userId,
								organizationId: input.organizationId,
								enabledIntegrationIds:
									input.enabledIntegrationIds ?? undefined,
								executionSurface: chatIntegrationRegistryV1
									? "LOOM_CHAT"
									: undefined,
							});

						// Pre-patch replay quarantine: the legacy hardcoded
						// allowlist, kept ONLY so old histories replay exactly as
						// they ran. Delete once in-flight chat workflows have
						// drained and the patch is deprecated.
						const executableResults = chatIntegrationRegistryV1
							? integrationSearchResult.results
							: integrationSearchResult.results.filter(
									(i) => i.provider === "NHTSA_VPIC",
								);
						// Same patch marker as the discovery switch above. It has
						// never shipped, so extending what it gates — first-wins
						// provider binding and registry-derived argument schemas
						// — is safe: no recorded history can contain it.
						if (chatIntegrationRegistryV1) {
							const projections =
								projectIntegrationTools(executableResults);
							// One integration now yields several tools (one per
							// operation), so the count reported to the model
							// stays a count of INTEGRATIONS, not of tools.
							integrationsFound = new Set(
								projections.map((p) => p.provider),
							).size;
							for (const projection of projections) {
								discoveredTools[projection.toolName] = {
									description: projection.description,
									inputSchema: projection.inputSchema,
								};
								discoveredToolConfigIds[projection.toolName] =
									projection.configId;

								integrationToolsFound.push({
									name: projection.toolName,
									description: projection.description,
									confidence: projection.confidence,
									category: "integration",
									inputSchema: projection.inputSchema,
								});
							}
						} else {
							// Pre-patch replay quarantine — the original
							// projection, including its last-wins overwrite of
							// same-provider rows. Kept verbatim so old histories
							// reconstruct exactly what they recorded. Delete with
							// the rest of the legacy branch.
							integrationsFound = executableResults.length;
							for (const integration of executableResults) {
								const opToolName = `integration__${integration.provider}`;
								const opNames = integration.operations.map(
									(op) => op.name,
								);
								const opList = integration.operations
									.map(
										(op) => `${op.name}: ${op.description}`,
									)
									.join("; ");
								const opDescription = `${integration.description}. Available operations: ${opList}. Use the 'operation' parameter with one of: ${opNames.join(", ")}`;
								const opInputSchema: Record<string, unknown> = {
									type: "object",
									properties: {
										operation: {
											type: "string",
											description: `The operation to execute. Must be one of: ${opNames.join(", ")}`,
											enum: opNames,
										},
										args: {
											type: "object",
											description:
												"Arguments for the operation",
										},
									},
									required: ["operation"],
								};

								discoveredTools[opToolName] = {
									description: opDescription,
									inputSchema: opInputSchema,
								};
								discoveredToolConfigIds[opToolName] =
									encodeIntegrationToolRef(
										integration.provider,
										integration.integrationId,
									);

								integrationToolsFound.push({
									name: opToolName,
									description: opDescription,
									confidence: integration.confidence,
									category: "integration",
									inputSchema: opInputSchema,
								});
							}
						}

						if (executableResults.length > 0) {
							log.info(
								`[MetaTool] Discovered ${executableResults.length} integration(s)`,
								{
									integrations: executableResults.map(
										(i) => i.provider,
									),
								},
							);
						}
					} catch (integrationSearchError) {
						log.warn("[MetaTool] Integration search failed", {
							error: String(integrationSearchError),
						});
						// Fail loudly: swallowing this presents a broken
						// discovery activity as "you have no integrations", which
						// sends the model down a dead end it cannot diagnose.
						if (chatIntegrationRegistryV1) {
							throw integrationSearchError;
						}
					}

					const allFound = [
						...toolsFound,
						...agentToolsFound,
						...integrationToolsFound,
					];
					toolResult = {
						tools: allFound,
						totalFound: allFound.length,
						message:
							allFound.length > 0
								? `Found ${toolsFound.length} tools, ${agentToolsFound.length} agents, and ${integrationsFound} integrations. These are now available for you to use.`
								: chatIntegrationRegistryV1
									? "No tools found matching your query. Try rephrasing your search, or check that the required MCP server is connected and that a matching integration is connected and executable from chat."
									: "No tools found matching your query. Try rephrasing your search or check if the required MCP server is connected.",
					};

					// Add discovered tools to available tools for subsequent iterations
					for (const result of searchResult.results) {
						discoveredTools[result.toolName] = {
							description: result.description,
							inputSchema: result.inputSchema,
						};
						// Store configId for direct MCP execution (avoids scanning all configs)
						if (result.configId) {
							discoveredToolConfigIds[result.toolName] =
								result.configId;
						}
					}

					// Update available tools with newly discovered capabilities
					availableTools = {
						...metaTools,
						...formatToolsForLLM(
							state.preloadedResources,
							discoveredTools,
						),
					};

					// Issue #11: Track search quality metrics
					state.toolSearchMetrics.totalSearches++;
					if (allFound.length === 0) {
						state.toolSearchMetrics.zeroResultSearches++;
					} else {
						// Track confidence of top result
						const topConfidence = Math.max(
							...allFound.map(
								(t) =>
									(t as { confidence?: number }).confidence ??
									0,
							),
						);
						state.toolSearchMetrics.confidenceSum += topConfidence;
					}
					for (const result of searchResult.results) {
						if (
							!state.toolSearchMetrics.toolsDiscovered.includes(
								result.toolName,
							)
						) {
							state.toolSearchMetrics.toolsDiscovered.push(
								result.toolName,
							);
						}
					}

					log.info(
						`[MetaTool] Discovered ${toolsFound.length} tools + ${agentToolsFound.length} agents, now have ${Object.keys(availableTools).length} total tools available`,
						{
							searchMetrics: {
								totalSearches:
									state.toolSearchMetrics.totalSearches,
								zeroResultSearches:
									state.toolSearchMetrics.zeroResultSearches,
								uniqueToolsDiscovered:
									state.toolSearchMetrics.toolsDiscovered
										.length,
							},
						},
					);
				} else if (toolCall.name.startsWith("delegate_to_")) {
					// Agent delegation tool execution
					const agentId = toolCall.name.replace("delegate_to_", "");
					const delegationMessage =
						typeof toolCall.args.message === "string"
							? toolCall.args.message
							: JSON.stringify(toolCall.args);

					log.info("Delegating to agent", {
						agentId,
						messagePreview: delegationMessage.substring(0, 200),
					});
					updateProgress(
						"executing_tool",
						`Delegating to agent: ${agentId}...`,
					);

					const agentResult = await executeAgentAsTool({
						agentId,
						input: { message: delegationMessage },
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: input.projectId,
						parentExecutionId: state.executionId,
					});

					toolResult = agentResult.output;

					log.info("Agent delegation completed", {
						agentId,
						durationMs: agentResult.durationMs,
					});
				} else if (
					preloadedTool?.serverName === "databricks-vector-search" &&
					preloadedTool.dispatchMetadata
				) {
					const dispatchMetadata = preloadedTool.dispatchMetadata;
					log.info("Executing agent Databricks knowledge search", {
						toolName: toolCall.name,
						integrationId: dispatchMetadata.integrationId,
						indexCount: dispatchMetadata.indexNames.length,
					});
					const databricksResult =
						await executeDatabricksKnowledgeSearchActivity({
							binding: dispatchMetadata,
							args: toolCall.args,
							userId: input.userId,
							organizationId: input.organizationId,
						});
					toolResult = {
						response: databricksResult.summary,
						chunkCount: databricksResult.chunks.length,
						failures: databricksResult.failures,
						skippedIndexes: databricksResult.skippedIndexes,
					};
				} else if (toolCall.name.startsWith("workspace_rag")) {
					// Workspace RAG tool — execute directly without MCP
					const isSummarize =
						toolCall.name === "workspace_rag_summarize";
					const query =
						(toolCall.args.query as string) ||
						(isSummarize
							? "summarize all attached workspace documents"
							: "");
					const workspaceIds = input.workspaceIds || [];
					const topK =
						(toolCall.args.topK as number) ||
						(isSummarize ? 20 : 10);
					const minSimilarity =
						(toolCall.args.minSimilarity as number) || undefined;

					log.info("Executing workspace RAG", {
						toolName: toolCall.name,
						query: query.substring(0, 100),
						workspaceCount: workspaceIds.length,
					});

					if (workspaceIds.length === 0) {
						toolResult =
							"No workspace documents are available. Please attach documents to a workspace to enable document search.";
					} else {
						const ragResult =
							await retrieveWorkspaceDocumentsActivity(
								query,
								input.userId,
								input.organizationId,
								workspaceIds,
								undefined,
								topK,
								minSimilarity,
							);

						if (ragResult.context && ragResult.chunkCount > 0) {
							toolResult = ragResult.context;
							log.info("Workspace RAG completed", {
								chunkCount: ragResult.chunkCount,
								contextLength: ragResult.context.length,
							});
						} else {
							toolResult = `No relevant content found in workspace documents for query: "${query}".`;
						}
					}
				} else if (toolCall.name === "project_rag_query") {
					// Project RAG tool — execute directly without MCP
					const query = (toolCall.args.query as string) || "";
					const projectId = input.projectId;
					const topK =
						typeof toolCall.args.topK === "number"
							? toolCall.args.topK
							: undefined;

					log.info("Executing project RAG", {
						toolName: toolCall.name,
						query: query.substring(0, 100),
						projectId,
					});

					if (!projectId) {
						toolResult =
							"No project is attached to this conversation. Please attach a project in the Projects tab to enable project context search.";
					} else {
						const ragResult = await retrieveProjectContextsActivity(
							query,
							projectId,
							input.userId,
							input.organizationId,
							topK,
						);

						if (ragResult.context && ragResult.chunkCount > 0) {
							toolResult = ragResult.context;
							log.info("Project RAG completed", {
								chunkCount: ragResult.chunkCount,
								contextLength: ragResult.context.length,
							});
						} else {
							toolResult = `No relevant content found in project contexts for query: "${query}".`;
						}
					}
				} else if (toolCall.name === "search_slack_messages") {
					// Live Slack search — execute directly without MCP
					const query = (toolCall.args.query as string) || "";
					const projectId = input.projectId;
					const rawLimit =
						typeof toolCall.args.limit === "number"
							? toolCall.args.limit
							: 15;
					const limit = Math.min(Math.max(1, rawLimit), 50);

					log.info("Executing search_slack_messages", {
						toolName: toolCall.name,
						query: query.substring(0, 100),
						projectId,
						limit,
					});

					if (!projectId) {
						toolResult =
							"No project is attached to this conversation. Please attach a project in the Projects tab to enable Slack search.";
					} else {
						const slackResult = await searchProjectSlackMessages({
							projectId,
							query,
							userId: input.userId,
							organizationId: input.organizationId,
							limit,
						});
						toolResult = JSON.stringify(slackResult);
						log.info("search_slack_messages completed", {
							totalCount: slackResult.totalCount,
							searchedChannels:
								slackResult.searchedChannels.length,
							errorCount: slackResult.errors.length,
						});
					}
				} else if (toolCall.name === "search_teams_messages") {
					// Live Microsoft Teams search — execute directly without MCP
					const query = (toolCall.args.query as string) || "";
					const projectId = input.projectId;
					const rawLimit =
						typeof toolCall.args.limit === "number"
							? toolCall.args.limit
							: 15;
					const limit = Math.min(Math.max(1, rawLimit), 50);

					log.info("Executing search_teams_messages", {
						toolName: toolCall.name,
						query: query.substring(0, 100),
						projectId,
						limit,
					});

					if (!projectId) {
						toolResult =
							"No project is attached to this conversation. Please attach a project in the Projects tab to enable Teams search.";
					} else {
						const teamsResult = await searchProjectTeamsMessages({
							projectId,
							query,
							userId: input.userId,
							organizationId: input.organizationId,
							limit,
						});
						toolResult = JSON.stringify(teamsResult);
						log.info("search_teams_messages completed", {
							totalCount: teamsResult.totalCount,
							searchedChats: teamsResult.searchedChats.length,
							errorCount: teamsResult.errors.length,
						});
					}
				} else if (
					toolCall.name === "list_skills" ||
					toolCall.name === "load_skill" ||
					toolCall.name === "read_skill_file"
				) {
					// Anthropic Agent Skills read tools — dispatched directly
					// (bypasses MCP routing). Bound in run-agent-iteration.ts.
					log.info("Executing skill tool", {
						toolName: toolCall.name,
					});
					const skillResult = await executeSkillToolActivity({
						toolName: toolCall.name as
							| "list_skills"
							| "load_skill"
							| "read_skill_file",
						args: toolCall.args,
						userId: input.userId,
						organizationId: input.organizationId,
					});
					toolResult = skillResult;
				} else {
					// Regular MCP tool execution
					const result = await executeMcpTool({
						toolName: toolCall.name,
						args: toolCall.args,
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: input.projectId,
						mcpConfigId: discoveredToolConfigIds[toolCall.name],
						attachedImageUrls: input.attachedImageUrls,
						// Binds the integration authority check to this run.
						// Same patch marker as the registry-backed discovery
						// above — it widens the recorded activity input.
						executionId: patched(
							"loom-chat-integration-executor-registry-v1",
						)
							? state.executionId
							: undefined,
						// `executeMcpTool` already races the call against
						// `runWithTimeout` — but only when a ceiling is
						// supplied, and no Loom call site supplied one, so a
						// server that never answers was bounded only by the
						// activity timeout. Its own patch marker: this widens
						// the recorded activity input, so replaying a history
						// from before it must keep sending the old shape.
						timeoutMs: patched("loom-mcp-tool-call-ceiling-v1")
							? DEFAULT_MCP_TOOL_TIMEOUT_MS
							: undefined,
					});

					toolResult = result.output;
					// Capture MCP App resource URI for iframe rendering
					if (result.mcpAppResourceUri) {
						mcpAppResourceUri = result.mcpAppResourceUri;
						mcpAppConfigId = result.mcpAppConfigId;
					}

					// Check for structured failures (executeMcpTool returns success: false instead of throwing)
					if (!result.success) {
						toolError =
							typeof result.output === "object" &&
							result.output !== null &&
							"error" in result.output
								? String(
										(result.output as { error: unknown })
											.error,
									)
								: "Tool execution failed";

						// Handle OAuth authorization required - surface to UI for reconnection
						if (result.authRequired) {
							const serverName =
								result.authRequiredServerName ||
								"the MCP server";
							const configId = result.authRequiredConfigId;

							log.warn("Tool blocked on OAuth authorization", {
								toolName: toolCall.name,
								configId,
								serverName,
							});

							// Track the failed tool call
							state.toolCalls.push({
								id: toolCall.id,
								name: toolCall.name,
								args: toolCall.args,
								result: {
									error: `OAuth authorization required for ${serverName}`,
								},
								status: "error",
								durationMs: Date.now() - startTime,
							});

							// Update progress to awaiting_auth phase
							updateProgress(
								"awaiting_auth" as string,
								`Waiting for authorization: ${serverName}`,
							);
							state.status =
								"awaiting_auth" as typeof state.status;

							// Return with auth required info so workflow can propagate to UI
							return {
								success: false,
								error: `OAuth authorization required for ${serverName}. Please connect this service in Settings and try again.`,
								shouldContinue: false,
								data: {
									finalResponse: `I need access to ${serverName} to continue. Please connect this service in Settings and try again.`,
									authRequired: configId
										? { configId, serverName }
										: undefined,
								},
							};
						}
						log.warn("Tool execution returned failure", {
							toolName: toolCall.name,
							error: toolError,
						});
					}
				}
			} catch (error) {
				toolError =
					error instanceof Error ? error.message : String(error);
				toolResult = { error: toolError };
				log.warn("Tool execution threw exception", {
					toolName: toolCall.name,
					error: toolError,
				});
			}

			// Emit `mcp_default_tool_failed` with
			// `failureKind: "tool-call-error"` when a tool backed by a
			// managed-default MCPConfig failed. Both error paths above
			// converge on `toolError` truthy, so we check it here once.
			// Existing error-handling for user-installed tools is
			// untouched. The `managedDefaultToolNames` set is populated
			// by the eager-routing helper case above so this branch only
			// fires for the narrow set of tools the helper resolved
			// against an `isManagedDefault=true` config.
			if (toolError && managedDefaultToolNames.has(toolCall.name)) {
				const serverKey =
					managedDefaultToolServerKeys.get(toolCall.name) ?? "";
				state.mcpDefaultToolSignals.push({
					kind: "failed",
					surface: input.surface as McpDefaultToolSurface,
					serverKey,
					failureKind: "tool-call-error",
					errorMessage: sanitizeMcpErrorMessage(toolError),
					executionId: state.executionId,
					organizationId: input.organizationId ?? null,
				});
				log.info(
					"[DefaultMcpToolCall] Managed-default tool failed — emitted mcp_default_tool_failed analytics signal",
					{
						executionId: state.executionId,
						toolName: toolCall.name,
						serverKey,
					},
				);
			}

			// Emit `mcp_default_tool_invoked` after a successful
			// managed-default tool call. The eager-routing helper
			// populates `managedDefaultToolNames` only for tools whose
			// resolved `MCPConfig` is for a `defaultEnabled=true` registry
			// row. Because custom servers can't be `defaultEnabled` in
			// v1, every entry in the set is a managed-default row — i.e.
			// `MCPConfig.isManagedDefault === true` — so
			// `configSource: "managed-default"` is the only branch this
			// workflow path can take in v1. The literal is left explicit
			// (not derived from a `MCPConfig` read) because reading
			// `isManagedDefault` here would require a second DB round-trip
			// per tool call for a value the helper already proved. The
			// `"user-installed"` branch is reserved for a follow-up when
			// a user-installed config can also be a `defaultEnabled`
			// server's backing config (not possible today).
			if (!toolError && managedDefaultToolNames.has(toolCall.name)) {
				const serverKey =
					managedDefaultToolServerKeys.get(toolCall.name) ?? "";
				state.mcpDefaultToolSignals.push({
					kind: "invoked",
					surface: input.surface as McpDefaultToolSurface,
					serverKey,
					toolName: toolCall.name,
					configSource: "managed-default",
					executionId: state.executionId,
					organizationId: input.organizationId ?? null,
				});
				log.info(
					"[DefaultMcpToolCall] Managed-default tool invoked — emitted mcp_default_tool_invoked analytics signal",
					{
						executionId: state.executionId,
						toolName: toolCall.name,
						serverKey,
					},
				);
			}

			// Drain any new signals (this tool call's failure or success,
			// plus any service-down signal pushed earlier in this
			// iteration phase) to the SSE pipeline. The flusher is a
			// no-op when the cursor is already at the end, so calling it
			// after every tool call is safe and cheap.
			await flushMcpDefaultToolSignals(state);

			const durationMs = Date.now() - startTime;

			// `conversationHistory` is the input to `runAgentIteration`. Shrinking
			// it on replay would shift the activity input vs. what Temporal
			// recorded for in-flight workflows, so gate the scrub behind a
			// patched marker. New executions get the lean args; pre-patch
			// histories replay with the full HTML they originally carried.
			const retainedArgs = patched("orch-frame-args-scrub-2026-04")
				? scrubArgsForRetention(toolCall.name, toolCall.args)
				: toolCall.args;

			// Track tool call
			state.toolCalls.push({
				id: toolCall.id,
				name: toolCall.name,
				args: retainedArgs,
				result: toolResult,
				status: toolError ? "error" : "success",
				durationMs,
				mcpAppResourceUri,
				mcpAppConfigId,
			});

			// 3-strike per-tool failure breaker. OAuth-required failures return
			// early above and don't reach this counter. Gated by patched() so
			// in-flight pre-patch executions replay deterministically.
			if (patched("orch-tool-failure-breaker-2026-04")) {
				const TOOL_FAILURE_THRESHOLD = 3;
				if (toolError) {
					const next =
						(state.consecutiveToolFailures[toolCall.name] ?? 0) + 1;
					state.consecutiveToolFailures[toolCall.name] = next;
					if (next >= TOOL_FAILURE_THRESHOLD) {
						log.error("Tool failure breaker tripped", {
							toolName: toolCall.name,
							consecutiveFailures: next,
							threshold: TOOL_FAILURE_THRESHOLD,
							lastError: toolError,
						});
						return {
							success: false,
							error: `Tool "${toolCall.name}" failed ${next} times in a row; aborting iteration loop. Last error: ${toolError}`,
							shouldContinue: false,
							data: {
								finalResponse: `I tried to use \`${toolCall.name}\` ${next} times in a row and it kept failing with: ${toolError}\n\nI'm stopping here so we don't loop. Please check the tool's status or rephrase your request.`,
							},
						};
					}
				} else if (state.consecutiveToolFailures[toolCall.name]) {
					state.consecutiveToolFailures[toolCall.name] = 0;
				}
			}

			// Add to conversation history (tag with iteration for pruning).
			// Use the scrubbed args so the LLM doesn't keep re-receiving the
			// full rendered HTML on every subsequent iteration.
			conversationHistory.push({
				role: "assistant",
				content: "",
				toolCalls: [
					{
						id: toolCall.id,
						name: toolCall.name,
						args: retainedArgs,
						...(toolCall.providerMetadata && {
							providerMetadata: toolCall.providerMetadata,
						}),
					},
				],
				timestamp: new Date().toISOString(),
				iteration,
			});

			// Summarize large tool results to avoid bloating context.
			// Skill tools return structured reference material (SKILL.md bodies
			// and asset templates) the model needs verbatim to render accurate
			// artifacts — LLM-summarizing them would lose the exact HTML/CSS
			// structure. Give them a larger allowance; individual files are
			// already capped at MAX_SKILL_FILE_READ_BYTES (256 KB) in the loader.
			const MAX_TOOL_RESULT_LENGTH =
				toolCall.name === "load_skill" ||
				toolCall.name === "read_skill_file"
					? 64_000
					: TOOL_RESULTS.maxChars;

			// Extract plain text from MCP result format:
			// { content: [{ type: "text", text: "..." }], isError: false }
			// This avoids the JSON wrapper overhead and keeps results human-readable.
			// Important: read_me returns ~8000 chars of format docs — extracting the
			// text brings it under the limit so it isn't LLM-summarized (which would
			// lose the critical element format the LLM needs to call create_view).
			function extractMcpResultText(result: unknown): string {
				if (typeof result === "string") {
					return result;
				}
				const r = result as Record<string, unknown> | null;
				if (r && Array.isArray(r.content)) {
					const parts = (
						r.content as Array<{ type?: string; text?: string }>
					)
						.filter((c) => c.type === "text" && c.text)
						.map((c) => c.text as string);
					if (parts.length > 0) {
						return parts.join("\n");
					}
				}
				return JSON.stringify(result);
			}

			let resultContent = extractMcpResultText(toolResult);

			if (resultContent.length > MAX_TOOL_RESULT_LENGTH) {
				log.info("Tool result too large, summarizing with LLM", {
					toolName: toolCall.name,
					originalLength: resultContent.length,
					targetLength: MAX_TOOL_RESULT_LENGTH,
				});
				try {
					resultContent = await summarizeLargeToolResult({
						toolName: toolCall.name,
						toolResult: resultContent,
						userQuery: state.enrichedMessage,
						maxOutputLength: MAX_TOOL_RESULT_LENGTH - 500,
						userId: input.userId,
						organizationId: input.organizationId,
					});
				} catch (err) {
					log.warn(
						"LLM summarization failed, falling back to truncation",
						{
							error: String(err),
						},
					);
					resultContent =
						resultContent.substring(0, MAX_TOOL_RESULT_LENGTH) +
						`\n... [TRUNCATED: ${resultContent.length - MAX_TOOL_RESULT_LENGTH} chars omitted]`;
				}
			}

			// Debug: Log the tool result content being added to conversation
			log.info("Adding tool result to conversation", {
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				resultPreview: resultContent.substring(0, 500),
				resultLength: resultContent.length,
			});

			conversationHistory.push({
				role: "tool",
				content: resultContent,
				toolCallId: toolCall.id,
				timestamp: new Date().toISOString(),
				iteration,
			});

			log.info("Tool executed", {
				toolName: toolCall.name,
				success: !toolError,
				durationMs,
			});
		}

		// Sync conversation history to state
		state.iterativeConversationHistory = [...conversationHistory];

		// Mid-execution conversation compaction.
		// Once cumulative token usage crosses the threshold, fold older turns
		// into a single "PROGRESS SO FAR" summary block so subsequent
		// iterations have less context to process. Buys ~7–15 more iterations
		// on long sessions at the cost of one ~5K-token summarization call.
		await maybeCompactConversationHistory(
			state,
			conversationHistory,
			iteration,
			cumulativeTokens,
			maxTokens,
			input.userId,
			input.organizationId,
		);

		// Update progress for next iteration
		updateProgress(
			"iterating",
			`Completed iteration ${iteration}, continuing...`,
		);
	}

	// Cancelled
	return {
		success: false,
		error: "Execution cancelled",
		shouldContinue: false,
	};
}

// ============================================================================
// Conversation History Compaction
// ============================================================================

/**
 * Trim leading orphan tool-result messages from a slice. Tool-result messages
 * MUST be preceded by an assistant message containing the matching tool_call;
 * if a slice starts with a tool result whose call was dropped, the next API
 * request fails validation. Returns the slice with such orphans removed.
 */
export function trimLeadingOrphans(
	slice: IterativeMessage[],
): IterativeMessage[] {
	let i = 0;
	while (i < slice.length && slice[i].role === "tool") {
		i++;
	}
	return i === 0 ? slice : slice.slice(i);
}

/**
 * Trim a slice so it does not end mid-tool-pair. If the last message is an
 * assistant turn containing tool_calls, drop it — the matching tool_results
 * live in the kept-recent slice and will become orphans without their parent.
 */
export function trimTrailingOrphans(
	slice: IterativeMessage[],
): IterativeMessage[] {
	if (slice.length === 0) {
		return slice;
	}
	const last = slice[slice.length - 1];
	if (
		last.role === "assistant" &&
		last.toolCalls &&
		last.toolCalls.length > 0
	) {
		return slice.slice(0, -1);
	}
	return slice;
}

/**
 * Trigger conversation compaction if budget threshold + cooldown allow it.
 * Mutates `conversationHistory` in place by replacing older turns with a
 * single summary block. Updates `state.lastCompactionIteration` and adds a
 * cost entry so subsequent budget calculations reflect the compaction call.
 *
 * Emits `execution.context_compacted` SSE event so the UI can show a small
 * "Compressed earlier context to keep going" hint without surprising users
 * when the model "forgets" earlier specifics.
 */
export async function maybeCompactConversationHistory(
	state: WorkflowState,
	conversationHistory: IterativeMessage[],
	iteration: number,
	cumulativeTokens: number,
	maxTotalTokens: number,
	userId: string,
	organizationId?: string,
): Promise<void> {
	const budgetPct =
		maxTotalTokens > 0 ? (cumulativeTokens / maxTotalTokens) * 100 : 0;

	if (budgetPct < COMPACTION.triggerThresholdPct) {
		return;
	}
	if (
		iteration - state.lastCompactionIteration <
		COMPACTION.cooldownIterations
	) {
		return;
	}
	// Need at least the original user message + cooldown floor + recent slice
	if (
		conversationHistory.length <
		1 + COMPACTION.minTurnsToCompact + COMPACTION.keepRecentTurns
	) {
		return;
	}

	const originalUserMessage = conversationHistory[0];
	const middleSlice = conversationHistory.slice(
		1,
		-COMPACTION.keepRecentTurns,
	);
	const recentSlice = conversationHistory.slice(-COMPACTION.keepRecentTurns);

	// Don't cut mid-pair on either side of the compaction boundary.
	const safeMiddle = trimTrailingOrphans(middleSlice);
	const safeRecent = trimLeadingOrphans(recentSlice);

	if (safeMiddle.length < COMPACTION.minTurnsToCompact) {
		return;
	}

	const taskText =
		typeof originalUserMessage.content === "string"
			? originalUserMessage.content
			: "(no original task captured)";

	log.info("Triggering conversation history compaction", {
		iteration,
		executionId: state.executionId,
		budgetPct: Math.round(budgetPct),
		turnsToCompact: safeMiddle.length,
		turnsKeptRecent: safeRecent.length,
	});

	let compactionResult: {
		summaryText: string;
		usage: { inputTokens: number; outputTokens: number };
	} | null = null;
	try {
		compactionResult = await compactConversationHistoryActivity({
			oldTurns: safeMiddle,
			currentTask: taskText,
			userId,
			organizationId,
			maxSummaryTokens: COMPACTION.maxSummaryTokens,
			executionId: state.executionId,
			iteration,
			historyLengthBefore: conversationHistory.length,
		});
	} catch (error) {
		log.warn("Compaction activity failed — continuing without compaction", {
			iteration,
			error: error instanceof Error ? error.message : String(error),
		});
		// Set cooldown anyway so we don't retry immediately every iteration.
		state.lastCompactionIteration = iteration;
		return;
	}

	if (!compactionResult.summaryText.trim()) {
		log.warn("Compaction returned empty summary — skipping replacement", {
			iteration,
		});
		state.lastCompactionIteration = iteration;
		return;
	}

	// Track the compaction's own LLM cost in the budget accounting.
	state.iterationCosts.push({
		iteration,
		inputTokens: compactionResult.usage.inputTokens,
		outputTokens: compactionResult.usage.outputTokens,
		timestamp: new Date().toISOString(),
	});

	// Replace history in place with [original user msg, summary, ...recent].
	const summaryMessage: IterativeMessage = {
		role: "user",
		content: `[CONTEXT SUMMARY — earlier portion of this conversation has been compacted to save context budget. Treat the items below as established facts; do not re-fetch information already noted here.]\n\n${compactionResult.summaryText}`,
		timestamp: new Date().toISOString(),
		iteration: 0,
	};

	conversationHistory.splice(
		0,
		conversationHistory.length,
		originalUserMessage,
		summaryMessage,
		...safeRecent,
	);
	state.iterativeConversationHistory = [...conversationHistory];
	state.lastCompactionIteration = iteration;

	log.info("Conversation history compacted", {
		iteration,
		executionId: state.executionId,
		summaryChars: compactionResult.summaryText.length,
		newHistoryLength: conversationHistory.length,
		compactionInputTokens: compactionResult.usage.inputTokens,
		compactionOutputTokens: compactionResult.usage.outputTokens,
	});
}

/**
 * Render a tool-call's `args` as a short, single-line key=value summary,
 * preferring keys most likely to identify what the call was actually doing
 * (paths, IDs, queries) and dropping anything that would balloon the output.
 *
 * Total length is capped (`MAX_ARG_LINE_CHARS`) so a single noisy call cannot
 * dominate the fallback summary.
 */
const MAX_ARG_LINE_CHARS = 160;
const MAX_ARG_VALUE_CHARS = 80;
const ARG_SEPARATOR = ", ";
function renderToolCallArgs(args: unknown): string {
	if (!args || typeof args !== "object") {
		return "";
	}
	const obj = args as Record<string, unknown>;
	const parts: string[] = [];
	let used = 0;
	for (const [key, value] of Object.entries(obj)) {
		let rendered: string;
		if (value === null || value === undefined) {
			continue;
		}
		if (typeof value === "string") {
			rendered =
				value.length > MAX_ARG_VALUE_CHARS
					? `"${value.slice(0, MAX_ARG_VALUE_CHARS)}…"`
					: JSON.stringify(value);
		} else if (typeof value === "number" || typeof value === "boolean") {
			rendered = String(value);
		} else {
			// Skip nested objects/arrays — they bloat the line and rarely add
			// identifying info beyond the scalar fields above.
			continue;
		}
		const fragment = `${key}=${rendered}`;
		const separator = parts.length > 0 ? ARG_SEPARATOR.length : 0;
		if (used + separator + fragment.length > MAX_ARG_LINE_CHARS) {
			parts.push("…");
			break;
		}
		parts.push(fragment);
		used += separator + fragment.length;
	}
	return parts.join(ARG_SEPARATOR);
}

/**
 * Render a deterministic summary of what the orchestrator actually did, used
 * as the fallback when LLM-driven exhaustion synthesis returns a degenerate
 * output (under MIN_USEFUL_SYNTHESIS_CHARS). Designed to be usable on its own
 * — the user may see this verbatim — so it includes the original task, an
 * iteration/tool-call rollup, and per-tool args so they can decide what to
 * pick up in a fresh conversation.
 */
const MAX_TOOLS_LISTED = 8;
const MAX_CALLS_PER_TOOL_SHOWN = 4;
const MAX_ORIGINAL_TASK_CHARS = 400;
export function summarizeAccomplishments(state: WorkflowState): string {
	const sections: string[] = [];

	const originalTask = (state.enrichedMessage || "").trim();
	if (originalTask) {
		sections.push(
			`## Original request\n\n${truncateWithEllipsis(originalTask, MAX_ORIGINAL_TASK_CHARS)}`,
		);
	}

	const successful = state.toolCalls.filter((tc) => tc.status === "success");
	const failed = state.toolCalls.filter((tc) => tc.status === "error");
	const iterations = state.currentIteration ?? 0;

	if (state.toolCalls.length === 0) {
		sections.push(
			`## What I attempted\n\nReached the conversation limit after ${iterations} iteration(s) without successfully invoking any tools.`,
		);
		sections.push(
			"## To continue\n\nOpen a new chat. The summary above will be carried over as context.",
		);
		return sections.join("\n\n");
	}

	const headline = `Reached the conversation limit after ${iterations} iteration(s). Made ${state.toolCalls.length} tool call(s) — ${successful.length} successful${failed.length ? `, ${failed.length} failed` : ""}.`;

	// Group by tool name preserving first-seen order so the output is
	// deterministic and reads chronologically.
	const groupOrder: string[] = [];
	const groups = new Map<
		string,
		{ successful: typeof state.toolCalls; failed: typeof state.toolCalls }
	>();
	for (const tc of state.toolCalls) {
		let entry = groups.get(tc.name);
		if (!entry) {
			entry = { successful: [], failed: [] };
			groups.set(tc.name, entry);
			groupOrder.push(tc.name);
		}
		(tc.status === "success" ? entry.successful : entry.failed).push(tc);
	}

	const toolLines: string[] = [];
	const shownTools = groupOrder.slice(0, MAX_TOOLS_LISTED);
	for (const toolName of shownTools) {
		const group = groups.get(toolName);
		if (!group) {
			continue;
		}
		const total = group.successful.length + group.failed.length;
		const failedSuffix = group.failed.length
			? `, ${group.failed.length} failed`
			: "";
		toolLines.push(`**${toolName}** (×${total}${failedSuffix})`);

		// Successful calls preferred so the user has actionable data; pad
		// with failed calls if there's room.
		const callsToShow = [...group.successful, ...group.failed].slice(
			0,
			MAX_CALLS_PER_TOOL_SHOWN,
		);

		for (const call of callsToShow) {
			const argLine = renderToolCallArgs(call.args);
			const status = call.status === "error" ? " — failed" : "";
			toolLines.push(`- ${argLine || "(no identifying args)"}${status}`);
		}
		if (total > callsToShow.length) {
			toolLines.push(`- (${total - callsToShow.length} more)`);
		}
	}
	if (groupOrder.length > shownTools.length) {
		toolLines.push(
			`*…and ${groupOrder.length - shownTools.length} other tool(s).*`,
		);
	}

	sections.push(
		`## What I attempted\n\n${headline}\n\n${toolLines.join("\n")}`,
	);
	sections.push(
		"## To continue\n\nOpen a new chat. The summary above will be carried over as context.",
	);

	return sections.join("\n\n");
}

/**
 * Try to inline images into the response by matching them to sections.
 * Looks for numbered headings/sections (e.g., "## Design 1", "**1.", "### Option 1")
 * and inserts images at sections that DON'T already have an image.
 * Falls back to appending at the bottom.
 */
function inlineImagesIntoResponse(
	response: string,
	imageUrls: string[],
	allValidUrls: string[],
): string {
	// Find section boundaries using common patterns:
	// "## Design 1", "### 1.", "**Design 1:**", "**1.", "---" separators
	const sectionPattern =
		/(?:^|\n)(#{1,4}\s+(?:Design|Option|Concept|Variation|Version|Image|Style|Idea)\s*\d|#{1,4}\s+\d+[.):\s]|\*\*\s*(?:Design|Option|Concept|Variation|Version|Image|Style|Idea)\s*\d|\*\*\s*\d+[.):]|\n---+\n)/gi;

	const matches = [...response.matchAll(sectionPattern)];

	if (matches.length >= 2) {
		// Determine which sections DON'T already have a VALID image.
		// Check for actual generated URLs, not just "![" — the LLM may have
		// written truncated/broken image markdown that we need to replace.
		const sectionsWithoutImages: number[] = [];
		for (let i = 0; i < matches.length; i++) {
			const sectionStart = matches[i].index || 0;
			const sectionEnd =
				i + 1 < matches.length
					? matches[i + 1].index || response.length
					: response.length;
			const sectionContent = response.slice(sectionStart, sectionEnd);
			const hasValidImage = allValidUrls.some((url) =>
				sectionContent.includes(url),
			);
			if (!hasValidImage) {
				sectionsWithoutImages.push(i);
			}
		}

		log.info("Image inlining: section analysis", {
			totalSections: matches.length,
			sectionsWithoutImages: sectionsWithoutImages.length,
			missingImageCount: imageUrls.length,
			sectionHeaders: matches.map((m) => m[0].trim().substring(0, 60)),
		});

		if (sectionsWithoutImages.length > 0) {
			let result = response;
			let offset = 0;
			let imageIdx = 0;

			for (const sectionIdx of sectionsWithoutImages) {
				if (imageIdx >= imageUrls.length) {
					break;
				}

				const imageMarkdown = `\n\n![Generated Image](${imageUrls[imageIdx]})\n`;

				if (sectionIdx + 1 < matches.length) {
					// Insert before the next section heading (end of current section)
					const insertPos =
						(matches[sectionIdx + 1].index || 0) + offset;
					result =
						result.slice(0, insertPos) +
						imageMarkdown +
						result.slice(insertPos);
					offset += imageMarkdown.length;
				} else {
					// Last section — append at the end of the response
					result += imageMarkdown;
				}
				imageIdx++;
			}

			// Append any remaining images at the end
			while (imageIdx < imageUrls.length) {
				result += `\n\n![Generated Image](${imageUrls[imageIdx]})`;
				imageIdx++;
			}

			return result;
		}
	}

	// Fallback: just append all images at the bottom
	log.info("Image inlining: using bottom-append fallback", {
		sectionMatchCount: matches.length,
		imageCount: imageUrls.length,
	});
	return (
		response +
		"\n\n" +
		imageUrls.map((url) => `![Generated Image](${url})`).join("\n\n")
	);
}
