/**
 * Report Agent Loop
 *
 * Implements an agentic loop for report generation where the AI:
 * 1. Receives context (project, team, etc.) + available MCP tools
 * 2. Decides which tools to call to gather data (max iterations, each can invoke multiple tools)
 * 3. Returns gathered data for report rendering
 *
 * Key features:
 * - Max iterations to control costs (default 15, each iteration can invoke multiple tools)
 * - If limit reached, forces final data return with partial note
 * - AI uses human-readable context to figure out tool parameters
 * - Tools are filtered to read-only operations based on provider
 */

import type { AiJobKey } from "@repo/ai";
import { getCurrentDateContext, streamText, tool } from "@repo/ai";
import { withRollingCacheBreakpoint } from "@repo/ai/prompt-cache";
import { db, resolveReportMcpConfig } from "@repo/database";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import { heartbeat } from "@temporalio/activity";
import {
	boundGatheredData,
	DEFAULT_GATHERED_DATA_MAX_BYTES,
} from "./gathered-data-budget";
import {
	buildNoToolsErrorMessage,
	classifyConnectionError,
	classifyToolOutcome,
	isReadOnlyTool,
	redactMessage,
} from "./mcp-diagnostics";
import type { McpServerDiagnostic } from "./types";

/** Never trim below this — avoids a misconfigured tiny budget gutting reports. */
const GATHERED_DATA_MIN_BYTES = 100_000;
/** Never exceed this — must stay under Temporal's ~2 MiB activity-result limit. */
const GATHERED_DATA_MAX_SAFE_BYTES = 1_900_000;

/**
 * Resolve the byte budget for the returned `gatheredData`.
 * Env-overridable via `FABRIC_REPORT_GATHERED_DATA_MAX_BYTES`. The value must be
 * a bare base-10 integer (byte count) — malformed values like "1.5MB" are
 * rejected (not silently coerced to 1) — and is clamped to a Temporal-safe range
 * so neither a tiny budget guts reports nor a too-large one re-opens the
 * oversized-payload failure.
 */
function readGatheredDataMaxBytes(): number {
	const raw = process.env.FABRIC_REPORT_GATHERED_DATA_MAX_BYTES?.trim();
	if (!raw) {
		return DEFAULT_GATHERED_DATA_MAX_BYTES;
	}
	if (!/^\d+$/.test(raw)) {
		console.warn(
			`[AgentLoop] Ignoring malformed FABRIC_REPORT_GATHERED_DATA_MAX_BYTES="${raw}" (must be a bare byte count); using default ${DEFAULT_GATHERED_DATA_MAX_BYTES}`,
		);
		return DEFAULT_GATHERED_DATA_MAX_BYTES;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_GATHERED_DATA_MAX_BYTES;
	}
	return Math.min(
		GATHERED_DATA_MAX_SAFE_BYTES,
		Math.max(GATHERED_DATA_MIN_BYTES, parsed),
	);
}

/**
 * Bound `gatheredData` to the payload budget just before returning it from the
 * activity. When trimming happens the run is marked partial (existing render
 * notice) and a diagnostic marker + warn log record what was cut, so the
 * truncation is visible in Temporal history and worker logs.
 */
function finalizeGatheredData(
	gatheredData: Record<string, unknown>,
	executionId: string,
): {
	data: Record<string, unknown>;
	trimmed: boolean;
	truncation?: GatheredDataTruncation;
} {
	const bounded = boundGatheredData(gatheredData, {
		maxBytes: readGatheredDataMaxBytes(),
	});
	if (!bounded.trimmed) {
		return { data: bounded.data, trimmed: false };
	}
	console.warn(
		`[AgentLoop] gatheredData exceeded the payload budget for ${executionId} ` +
			`(${bounded.originalBytes} → ${bounded.finalBytes} bytes); trimmed to fit ` +
			`Temporal's activity-result limit: ${bounded.notes.join("; ")}`,
	);
	return {
		data: bounded.data,
		trimmed: true,
		truncation: {
			originalBytes: bounded.originalBytes,
			finalBytes: bounded.finalBytes,
			notes: bounded.notes,
		},
	};
}

/**
 * True only for the Vercel AI SDK's NoOutputGeneratedError — the "empty turn"
 * signal (model returned no text and no tool calls). Matched by error name or
 * message so we do not depend on the SDK exporting the class. Deliberately
 * narrow: genuine provider/transport errors (401/429/5xx/network) must NOT
 * match, so they propagate and the run fails loud.
 */
export function isNoOutputGeneratedError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	return (
		err.name.includes("NoOutputGenerated") ||
		err.message.includes("No output generated")
	);
}

/** Output-token cap for report data-gathering. Mirrors the orchestrator
 * (run-agent-iteration.ts:851) — without an explicit cap the provider may
 * silently truncate the stream to a content-free / no-finish-step turn. */
export const REPORT_MAX_OUTPUT_TOKENS = 16384;

/** Build the streamText options for one report model turn. Extracted so the
 * cap + tool-choice logic is unit-testable without driving the whole loop. */
export function buildReportStreamRequest(args: {
	model: unknown;
	system: string;
	messages: unknown[];
	tools: Record<string, unknown>;
}) {
	const hasTools = Object.keys(args.tools).length > 0;
	return {
		model: args.model as any,
		system: args.system,
		// The agent re-sends a GROWING, append-only history every iteration (tool
		// results run to ~12k chars each). A single rolling cache breakpoint on
		// the last message caches everything before it -- tools + system + all
		// prior messages -- so each turn reuses the prefix the previous turn wrote
		// instead of re-billing the whole transcript. Provider-agnostic: a no-op
		// on non-Anthropic providers (OpenAI/Gemini auto-cache the prefix anyway).
		messages: withRollingCacheBreakpoint(args.messages) as any,
		tools: hasTools ? (args.tools as any) : undefined,
		toolChoice: hasTools ? ("auto" as const) : undefined,
		maxOutputTokens: REPORT_MAX_OUTPUT_TOKENS,
	};
}

export type AgentUsage = { inputTokens: number; outputTokens: number };

export type ModelStreamLike = {
	textStream: AsyncIterable<string>;
	fullStream: AsyncIterable<{ type: string; [k: string]: unknown }>;
	text: Promise<string>;
	toolCalls: Promise<unknown[]>;
	finishReason: Promise<string | undefined>;
	usage: Promise<{ inputTokens?: number; outputTokens?: number } | undefined>;
};

export type StreamDiagnostics = {
	finishReason: string | null;
	sawFinishStep: boolean;
	usageResolved: boolean;
	attempts: number;
	provider?: string;
	modelString?: string;
};

export type ConsumeResult = {
	text: string;
	toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
	usage: AgentUsage;
	usageResolved: boolean;
	finishReason: string | null;
	sawFinishStep: boolean;
	streamError?: unknown;
	resolveError?: unknown;
};

/**
 * Drain a streamText result's fullStream, collecting text + tool calls and
 * observing whether a terminal finish-step arrived and with what finishReason.
 * Mirrors the orchestrator (run-agent-iteration.ts:855-918): errors surface as
 * `error` parts and are captured (not thrown); after the stream ends, usage and
 * finishReason are awaited in a try/catch — a rejection is the NoOutput/zero-
 * finish-step truncation signal. Heartbeats during idle gaps keep the Temporal
 * activity alive.
 */
export async function consumeStream(
	stream: ModelStreamLike,
	opts: { heartbeat: () => void; idleHeartbeatMs?: number },
): Promise<ConsumeResult> {
	const idleMs = opts.idleHeartbeatMs ?? 30_000;
	let text = "";
	const toolCalls: ConsumeResult["toolCalls"] = [];
	let sawFinishStep = false;
	let finishReason: string | null = null;
	// Fix 2: collect ALL error parts + iterator-throw; resolve genuine-preferred at end.
	const streamErrors: unknown[] = [];

	// Codex F-A: settle ALL four terminal promises up front via allSettled. In
	// ai@6.0.116 the zero-recorded-step path rejects `usage` AND `finishReason`
	// together; awaiting them sequentially in one try/catch would skip the second
	// await and leak an unhandled rejection. allSettled observes all regardless
	// of which (or all) reject. text and toolCalls are included so a genuine
	// provider rejection on EITHER channel surfaces via promiseRejections; their
	// fulfilled values are intentionally ignored (fullStream parts remain the
	// source of truth for text/toolCalls content). (Mirrors PR #1761's "attach
	// handlers before draining" technique.)
	const settled = Promise.allSettled([
		stream.usage,
		stream.finishReason,
		stream.text,
		stream.toolCalls,
	]);
	settled.catch(() => {}); // belt-and-suspenders: never an unhandled rejection

	// Codex F-D: heartbeat on a fixed interval so a provider stall BETWEEN parts
	// (or before the first part) cannot starve the Temporal activity heartbeat.
	// The `for await` blocks while idle, but the event loop still runs this
	// interval. Cleared in `finally`. idleMs must be < the activity's configured
	// heartbeatTimeout (verify against the workflow's activity proxy).
	const hb = setInterval(() => {
		try {
			opts.heartbeat();
		} catch {
			/* heartbeat called outside an activity context (tests) — ignore */
		}
	}, idleMs);

	try {
		for await (const part of stream.fullStream) {
			switch (part.type) {
				case "text-delta":
					text += (part as { text?: string }).text ?? "";
					break;
				case "tool-call":
					toolCalls.push({
						toolCallId: (part as any).toolCallId,
						toolName: (part as any).toolName,
						input: (part as any).input ?? {},
					});
					break;
				case "finish-step":
					sawFinishStep = true;
					if ((part as any).finishReason) {
						finishReason = (part as any).finishReason;
					}
					break;
				case "finish":
					sawFinishStep = true;
					if ((part as any).finishReason) {
						finishReason = (part as any).finishReason;
					}
					break;
				case "error":
					streamErrors.push((part as any).error);
					break;
			}
		}
	} catch (err) {
		// fullStream itself threw (uncommon) — classify alongside the outputs.
		streamErrors.push(err);
	} finally {
		clearInterval(hb);
	}

	let usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
	let usageResolved = false;
	// Destructure all four settled results. text and toolCalls fulfilled values are
	// intentionally ignored — fullStream parts are the source of truth for content.
	// Their REJECTION reasons, however, are collected into promiseRejections so a
	// genuine provider error on any channel lands in the fail-loud path.
	const [usageR, finishR, textR, toolCallsR] = await settled;
	const promiseRejections: unknown[] = [];
	if (usageR.status === "fulfilled" && usageR.value) {
		usage = {
			inputTokens: usageR.value.inputTokens ?? 0,
			outputTokens: usageR.value.outputTokens ?? 0,
		};
		usageResolved = true;
	} else if (usageR.status === "rejected") {
		promiseRejections.push(usageR.reason);
	}
	if (finishR.status === "fulfilled") {
		// A fulfilled finishReason promise means the stream reached a terminal
		// state — a zero-step truncation REJECTS it. Keep sawFinishStep aligned
		// with that authoritative signal even if no explicit finish-step part was
		// observed in fullStream, so a clean finish is never misread as truncation.
		sawFinishStep = true;
		if (finishR.value && finishReason === null) {
			finishReason = finishR.value;
		}
	} else if (finishR.status === "rejected") {
		promiseRejections.push(finishR.reason);
	}
	// text and toolCalls: only collect rejections (fulfilled values not used here).
	if (textR.status === "rejected") {
		promiseRejections.push(textR.reason);
	}
	if (toolCallsR.status === "rejected") {
		promiseRejections.push(toolCallsR.reason);
	}
	// Prefer a GENUINE (non-NoOutput) rejection so the classifier fails loud even
	// when one channel rejects NoOutput and another rejects 429/5xx.
	const resolveError =
		promiseRejections.find((r) => !isNoOutputGeneratedError(r)) ??
		promiseRejections[0];

	// Fix 2: genuine-preferred selection across all collected stream errors.
	const streamError =
		streamErrors.find((e) => !isNoOutputGeneratedError(e)) ??
		streamErrors[0];

	return {
		text,
		toolCalls,
		usage,
		usageResolved,
		finishReason,
		sawFinishStep,
		streamError,
		resolveError,
	};
}

export type IterationOutcome =
	| {
			kind: "result";
			text: string;
			toolCalls: unknown[];
			usage: AgentUsage;
			streamDiagnostics: StreamDiagnostics;
	  }
	| {
			kind: "empty";
			usage: AgentUsage;
			streamDiagnostics: StreamDiagnostics;
	  };

/**
 * Run one model iteration, retrying up to MAX_ATTEMPTS times if it produces a
 * truncated/empty turn (zero finish-step, or finishReason "length" with no
 * content). Genuine errors are re-thrown (fail-loud). Usage is summed across
 * all attempts where the SDK resolves it; zero-finish-step attempts where usage
 * rejects contribute 0 (Codex F3 — SDK reality). streamDiagnostics describes
 * the FINAL attempt (Codex F-B).
 */
export async function runModelIterationWithRetry(
	makeStream: () => ModelStreamLike,
	opts: {
		heartbeat: () => void;
		idleHeartbeatMs?: number;
		maxAttempts?: number;
	},
): Promise<IterationOutcome> {
	const MAX_ATTEMPTS = opts.maxAttempts ?? 3;
	const agg: AgentUsage = { inputTokens: 0, outputTokens: 0 };
	// Codex F-B: diagnostics describe the FINAL attempt (the one that determines
	// the outcome), so a salvaged zero-finish-step turn reports usageResolved:false
	// even if an EARLIER retry happened to resolve usage. Aggregate usage stays in
	// `agg`; the diagnostic flags track the last attempt only.
	let lastFinishReason: string | null = null;
	let lastSawFinishStep = false;
	let lastUsageResolved = false;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const c = await consumeStream(makeStream(), {
			heartbeat: opts.heartbeat,
			idleHeartbeatMs: opts.idleHeartbeatMs,
		});

		if (c.usageResolved) {
			agg.inputTokens += c.usage.inputTokens;
			agg.outputTokens += c.usage.outputTokens;
		}
		lastFinishReason = c.finishReason;
		lastSawFinishStep = c.sawFinishStep;
		lastUsageResolved = c.usageResolved;

		// (1) Genuine (non-empty-turn) error on any channel → fail loud.
		const genuine = [c.streamError, c.resolveError].find(
			(e) => e !== undefined && !isNoOutputGeneratedError(e),
		);
		if (genuine !== undefined) {
			throw genuine;
		}

		// (2) Usable output, or a clean empty stop → result.
		const isLegitStop = c.sawFinishStep && c.finishReason === "stop";
		if (c.text !== "" || c.toolCalls.length > 0 || isLegitStop) {
			return {
				kind: "result",
				text: c.text,
				toolCalls: c.toolCalls,
				usage: agg,
				streamDiagnostics: {
					finishReason: c.finishReason,
					sawFinishStep: c.sawFinishStep,
					usageResolved: c.usageResolved, // THIS attempt's
					attempts: attempt,
				},
			};
		}

		// (3) Truncation (zero finish-step, or 'length' with empty content) → retry.
		if (attempt < MAX_ATTEMPTS) {
			await heartbeatedSleep(1000 * attempt, opts.heartbeat);
		}
	}

	return {
		kind: "empty",
		usage: agg,
		streamDiagnostics: {
			finishReason: lastFinishReason,
			sawFinishStep: lastSawFinishStep,
			usageResolved: lastUsageResolved, // the FINAL (salvaged) attempt's
			attempts: MAX_ATTEMPTS,
		},
	};
}

/** Sleep `ms`, emitting a heartbeat at start so a Temporal activity stays alive
 * across the backoff. Kept tiny; backoffs are ≤ ~2s. */
async function heartbeatedSleep(
	ms: number,
	heartbeat: () => void,
): Promise<void> {
	heartbeat();
	await new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Types
// =============================================================================

export interface InstanceContext {
	project?: string;
	team?: string;
	[key: string]: string | number | undefined;
}

/**
 * Normalize context values: coerce all values to strings.
 * JSON parsing from the DB can produce numbers (e.g., accountSlug: 123456)
 * but MCP tools expect string arguments (slug.startsWith would fail on a number).
 */
function normalizeContext(
	context: InstanceContext,
): Record<string, string | undefined> {
	const normalized: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(context)) {
		normalized[key] = value != null ? String(value) : undefined;
	}
	return normalized;
}

export interface AgentLoopResult {
	/** Gathered data from tool calls */
	gatheredData: Record<string, unknown>;
	/** Number of tool calls made */
	toolCallCount: number;
	/** Whether data gathering was incomplete due to limit */
	isPartial: boolean;
	/** List of tools that were called */
	toolsUsed: string[];
	/** Token usage */
	usage: { inputTokens: number; outputTokens: number };
	/** Error message if failed */
	error?: string;
	/** Per-MCP-server connection diagnostics gathered during the run. */
	mcpDiagnostics: McpServerDiagnostic[];
	/** Diagnostics from the final model iteration (truncation flavor, finishReason). */
	streamDiagnostics?: StreamDiagnostics;
	/**
	 * Set when the returned `gatheredData` was trimmed to fit Temporal's
	 * activity-result payload limit. Present ⇒ `isPartial` is true.
	 */
	gatheredDataTruncation?: GatheredDataTruncation;
}

/** Records that the returned `gatheredData` was trimmed to fit the payload budget. */
export interface GatheredDataTruncation {
	/** Serialized byte size before trimming. */
	originalBytes: number;
	/** Serialized byte size after trimming (≤ the budget). */
	finalBytes: number;
	/** Human-readable list of what was trimmed. */
	notes: string[];
}

export interface ExecuteAgentLoopInput {
	/** Task description - what data to gather */
	taskDescription: string;
	/** Optional user prompt override (replaces default user message) */
	promptOverride?: string;
	/** Human-readable context (project name, team name, etc.) */
	context: InstanceContext;
	/** MCP config IDs to connect to */
	mcpConfigIds: string[];
	/** Provider types for tool filtering (e.g., ["azure_devops"]) */
	providers: string[];
	/** Max AI iterations allowed (each iteration can invoke multiple tools) (default: 15) */
	maxIterations?: number;
	/** Fabric AI enriched system prompt */
	enrichedSystemPrompt?: string;
	/** Custom system prompt override from instance (replaces default system instructions) */
	customSystemPrompt?: string;
	/** Skills content to append to system prompt */
	skillsContent?: string;
	/** User ID */
	userId: string;
	/** Organization ID */
	organizationId?: string;
	/** Background-attribution label threaded from the workflow input (Fizzy #1894). */
	jobType?: AiJobKey;
	/** Execution ID for tracking */
	executionId: string;
}

interface McpToolDefinition {
	description: string;
	inputSchema: Record<string, unknown>;
	configId: string;
	serverName: string;
}

interface ToolCallResult {
	toolName: string;
	result: unknown;
	error?: string;
}

// =============================================================================
// Safety Limits
// =============================================================================

/** Maximum number of tool calls allowed per single AI iteration */
const MAX_TOOL_CALLS_PER_ITERATION = 20;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert JSON Schema to Zod schema for AI SDK
 */
function jsonSchemaToZod(schema: Record<string, unknown>): unknown {
	const { jsonSchemaToZod: convert } = require("../orchestrator/utils");
	return convert(schema);
}

/**
 * Hardcoded system prompt for the report generation AI agent
 *
 * TODO: Replace with Fabric AI composed prompt when implemented.
 * Fabric AI will use Strategy → Context → Pattern system to dynamically
 * build the system prompt based on template configuration.
 */
const REPORT_AGENT_SYSTEM_PROMPT = `You are an expert report generation assistant. Your job is to gather data using the available tools and then analyze it to generate comprehensive reports.

## Your Capabilities
- You have access to read-only tools for gathering data from connected systems
- You can search, list, and retrieve data but cannot modify anything
- You MUST gather ALL relevant data before providing your analysis

## CRITICAL: Multi-Step Data Gathering Strategy

You MUST follow this strategy. Do NOT skip steps.

### Step 1: Discover Structure
If specific context values (board ID, account slug, project ID, etc.) are already provided below, use them directly instead of re-discovering them — but still call structural tools (e.g., get_columns) to find the segments within a provided target. Otherwise, call discovery/listing tools first:
- Get boards, projects, or workspaces to find the target
- Get columns, categories, statuses, or groups within the target
- Get tags, labels, or other classification data

### Step 2: Fetch Data Per Segment
Many APIs return one page per call, so a single call rarely covers a segment. Read each tool's own description first, then use the strategy it calls for:
- If a tool's description says its result is COMPLETE (it fetches every upstream page server-side), trust it: use the result as-is and do NOT re-query it with filters to "check" for more
- If the tool returns pagination metadata (has_more/next_page/total_count), page through results — stop when has_more is false OR a page comes back empty — instead of guessing from page size
- If results are not pageable and you have column IDs, call get_cards/get_items for EACH column individually using the \`column_id\` filter
- If the tool supports a status filter, fetch for EACH status separately
- If you have categories/groups, fetch for each one
- Only when a tool returns a full-looking batch AND declares neither pagination metadata nor completeness should you assume more data exists — then try additional filters (column, status, tag, assignee) to reach the rest
- If columns returned empty, use OTHER filter strategies the tool supports: tags, assignees, search (status only if the tool schema exposes it)

### Step 3: Deduplicate, Aggregate, and Verify
- Merge results from all fetches and remove duplicates (by ID)
- Count total UNIQUE items across all fetches
- If the user mentioned an expected count and your total is lower, try additional filters or broader queries
- Use search tools as a cross-check if available
- If you suspect missing items, try fetching individual items by ID if you know specific IDs

### Step 4: Analyze
Only after gathering the data the report needs — complete, or capped with the coverage stated — provide your analysis.

## Instructions
1. When calling tools, use the context values provided (e.g., project name, team name, board ID) to find the right resources
2. ALWAYS call multiple tools — a single tool call is almost never sufficient for a complete report
3. If a tool needs an ID that was not provided in context, first call a listing tool to discover it
4. If you cannot find certain data, note what's missing and continue with available data

## Output Format
Provide clear, well-structured analysis with:
- Key findings and insights
- Relevant metrics and data points
- Total count of items found
- Actionable recommendations where appropriate`;

/**
 * Convert camelCase to snake_case
 */
function toSnakeCase(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Build system prompt for data gathering
 * @param context - Instance context (project, team, etc.)
 * @param basePrompt - Base system prompt (custom, enriched, or default)
 */
function buildDataGatheringPrompt(
	context: Record<string, string | undefined>,
	basePrompt: string = REPORT_AGENT_SYSTEM_PROMPT,
): string {
	const parts: string[] = [basePrompt];

	// Add context if provided
	if (Object.keys(context).length > 0) {
		parts.push("");
		parts.push("## Context — IMPORTANT: Use these values in tool calls");
		parts.push(
			"Pass IDs and slugs below as tool arguments; name values are matching hints, not arguments. " +
				"Tool parameters use snake_case (e.g., `account_slug`, `board_id`). " +
				"Always include the required parameters shown below when calling tools.",
		);
		parts.push("");
		for (const [key, value] of Object.entries(context)) {
			if (value) {
				const snakeKey = toSnakeCase(key);
				if (key.endsWith("Name")) {
					parts.push(
						`- **${key}**: \`${value}\` — matching hint: use it to pick the right resource from listing results; only pass it as an argument if the tool schema actually has a \`${snakeKey}\` parameter`,
					);
				} else if (snakeKey !== key) {
					parts.push(
						`- **${key}** → pass as \`${snakeKey}\`: \`${value}\``,
					);
				} else {
					parts.push(`- **${key}**: \`${value}\``);
				}
			}
		}
		// Add strategy hint based on available context
		const hasBoard =
			!!context.boardId || !!context.boardName || !!context.board_id;
		const hasProject =
			!!context.project || !!context.projectId || !!context.project_id;

		if (hasBoard) {
			const boardId = context.boardId || context.board_id || "";
			parts.push("");
			parts.push("## Recommended Strategy for Board Data");
			parts.push(
				"The `get_cards` tool supports a `board_id` parameter to scope results to a specific board, " +
					"and it combines freely with `column_id`, `indexed_by`, and `search`.",
			);
			parts.push("");
			parts.push("### Fetching board cards");
			if (!boardId) {
				parts.push(
					"First call `get_boards` and match the board name to resolve its `board_id`.",
				);
			}
			parts.push(
				"1. Call `get_columns` with the board_id to discover workflow columns",
			);
			parts.push(
				"2. `get_cards` returns one PAGE as an object {cards, page, total_count, has_more, next_page} (server-controlled page size). Call it with `board_id`" +
					(boardId ? ` (\`${boardId}\`)` : "") +
					", then keep calling with `page: next_page` until `has_more` is false OR `cards` comes back empty (an out-of-range page can report has_more=true with empty cards), up to at most 10 pages. Cite `total_count` as the true total — when you fetched fewer, present your data as a sample of total_count",
			);
			parts.push(
				"3. For closed/archived cards, combine `indexed_by='closed'` with `board_id` and paginate the same way — closed cards never appear in the default listing. Stalled/golden cards: `indexed_by='stalled'` or `indexed_by='golden'` with `board_id`",
			);
			parts.push(
				"4. Derive per-column breakdowns by grouping the cards you already fetched by their `column.id` (or `column.name`). Do NOT also issue per-column `get_cards` calls after paginating the board — that re-fetches the same cards and wastes the run's time budget. Reserve `column_id` calls for the rare case where you skipped board-level pagination entirely",
			);
			parts.push("");
			parts.push(
				"**IMPORTANT**: `get_cards` cannot filter by status or due dates — passing `status`, `due_before`, or `due_after` is an error. " +
					"The default listing already contains only published cards; use `indexed_by='closed'` for closed ones.",
			);
		} else if (hasProject) {
			parts.push("");
			parts.push("## Recommended Strategy for Project Data");
			parts.push(
				"1. First discover the project structure (iterations, areas, teams)",
			);
			parts.push("2. Then fetch work items per iteration or category");
			parts.push("3. Aggregate all results before analyzing");
		}
	}

	// Date context last — keeps the stable base prompt at position 0 so
	// provider prompt caching can match on it across turns.
	parts.push("");
	parts.push(getCurrentDateContext());

	return parts.join("\n");
}

/**
 * The raw `properties` bag of a tool's JSON input schema.
 *
 * On the `mcpClient.tools()` path the AI SDK wraps the server's schema in a
 * `jsonSchema(...)` container, so the real JSON Schema sits behind an
 * (enumerable, synchronous) `jsonSchema` getter; a bare JSON Schema is accepted
 * too. Anything else — absent, a Zod schema, a thenable — yields null.
 */
function extractSchemaProperties(
	inputSchema: unknown,
): Record<string, unknown> | null {
	if (!inputSchema || typeof inputSchema !== "object") {
		return null;
	}
	const container = inputSchema as { jsonSchema?: unknown };
	const raw =
		container.jsonSchema && typeof container.jsonSchema === "object"
			? (container.jsonSchema as { properties?: unknown })
			: (inputSchema as { properties?: unknown });
	const properties = raw.properties;
	return properties &&
		typeof properties === "object" &&
		!Array.isArray(properties)
		? (properties as Record<string, unknown>)
		: null;
}

/** True when a JSON Schema property declares a numeric type, bare or in a `type` array. */
function schemaDeclaresNumeric(property: unknown): boolean {
	if (!property || typeof property !== "object") {
		return false;
	}
	const type = (property as { type?: unknown }).type;
	const isNumeric = (t: unknown) => t === "number" || t === "integer";
	return Array.isArray(type) ? type.some(isNumeric) : isNumeric(type);
}

/**
 * Coerce LLM-emitted tool arguments to the types the MCP tool actually declares.
 *
 * Models routinely emit JSON numbers for values MCP tools type as strings (an
 * `account_slug` of `123456`), which a string-typed zod field rejects — hence
 * the long-standing stringify-every-number rule. But that rule is wrong in the
 * other direction: `fizzy_get_cards` declares `page` as an integer, and `"2"`
 * fails an integer-typed field (the deployed Cloudflare handler happens to
 * accept digit strings, but no zod-validated transport does).
 *
 * So consult the tool's own schema: a property declared `number`/`integer`
 * (including inside a `type` array such as `["integer","null"]`) keeps its
 * numeric value, everything else is stringified. When no schema is exposed we
 * fall back to stringify-all, the behavior this replaced. Exported for tests.
 */
export function coerceToolArgs(
	rawArgs: Record<string, unknown>,
	inputSchema?: unknown,
): Record<string, unknown> {
	const properties = extractSchemaProperties(inputSchema);
	const args: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawArgs)) {
		if (typeof value !== "number") {
			args[key] = value;
			continue;
		}
		args[key] = schemaDeclaresNumeric(properties?.[key])
			? value
			: String(value);
	}
	return args;
}

/**
 * Tools whose list results may arrive as a fizzy-mcp 1.1.0 page envelope.
 * Anchored at the end of the name so `fizzy_get_cards` / `trello_list_cards`
 * match but a differently-shaped `get_cards_summary` does not.
 */
function isCardListTool(toolName: string): boolean {
	return /(?:get|list)_cards$/i.test(toolName);
}

/**
 * Unwrap a card-list result that may be a fizzy-mcp 1.1.0 page envelope
 * ({ cards, page, total_count, has_more, next_page }) or a bare card array.
 * Returns null when the value is neither. Exported for tests.
 */
export function extractCardsArray(value: unknown): unknown[] | null {
	if (Array.isArray(value)) {
		return value;
	}
	if (value && typeof value === "object") {
		const cards = (value as { cards?: unknown }).cards;
		if (Array.isArray(cards)) {
			return cards;
		}
	}
	return null;
}

/**
 * Pagination fields of a fizzy-mcp page envelope, when present. Only reads
 * envelope-shaped values (object with an array `cards`). Exported for tests.
 */
export function extractPageMeta(
	value: unknown,
): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const bag = value as Record<string, unknown>;
	if (!Array.isArray(bag.cards)) {
		return null;
	}
	const meta: Record<string, unknown> = {};
	for (const key of ["page", "total_count", "has_more", "next_page"]) {
		if (key in bag) {
			meta[key] = bag[key];
		}
	}
	return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Slim a card down to the fields reports reason about, so a ~33KB raw card
 * (HTML description, avatar URLs, nested creator objects) becomes a few
 * hundred bytes before summarization. Applied to the LLM-context copy only —
 * `gatheredData` keeps the full cards for rendering. Exported for tests.
 */
export function projectCardForContext(card: unknown): unknown {
	if (!card || typeof card !== "object" || Array.isArray(card)) {
		return card;
	}
	const c = card as Record<string, unknown>;
	const projected: Record<string, unknown> = {};
	for (const key of [
		"id",
		"number",
		"title",
		"status",
		"closed",
		"golden",
		"due_on",
		"created_at",
		"last_active_at",
		"url",
	]) {
		if (c[key] !== undefined) {
			projected[key] = c[key];
		}
	}
	const board = c.board;
	if (board && typeof board === "object" && !Array.isArray(board)) {
		projected.board = {
			id: (board as { id?: unknown }).id,
			name: (board as { name?: unknown }).name,
		};
	}
	const column = c.column;
	if (column && typeof column === "object" && !Array.isArray(column)) {
		projected.column = {
			id: (column as { id?: unknown }).id,
			name: (column as { name?: unknown }).name,
		};
	}
	if (Array.isArray(c.assignees)) {
		projected.assignees = c.assignees.map((a) =>
			a && typeof a === "object" && !Array.isArray(a)
				? {
						id: (a as { id?: unknown }).id,
						name: (a as { name?: unknown }).name,
					}
				: a,
		);
	}
	if (Array.isArray(c.tags)) {
		projected.tags = c.tags;
	}
	if (typeof c.description === "string" && c.description.length > 0) {
		// Slice by code point, not UTF-16 unit: `slice(0, 280)` can cut an emoji
		// (or any astral character) in half and leave a lone surrogate behind.
		const codePoints = Array.from(c.description);
		projected.description =
			codePoints.length > 280
				? `${codePoints.slice(0, 280).join("")}…`
				: c.description;
	}
	return projected;
}

/**
 * Drop cards belonging to other boards from a card-list result, client-side.
 *
 * `serverScoped` says whether the call itself was already narrowed to the board
 * (a `board_id`/`column_id` argument). When it was NOT, an envelope-shaped
 * result is ALWAYS rewritten: its `total_count` describes the account-wide
 * query, not this board, so the number would otherwise be cited as the board
 * total. That holds even when the page dropped nothing AND when the page is
 * empty — an out-of-range page (`{cards: [], has_more: true, total_count: 611}`)
 * is exactly the case that would otherwise smuggle an account-wide total into
 * `_coverage` via its last-non-null rule. A genuinely server-scoped call that
 * dropped nothing, and a bare array with nothing dropped, are returned untouched.
 *
 * Exported for tests.
 */
export function applyBoardPreFilter(params: {
	parsedOutput: unknown;
	toolName: string;
	targetBoardId: string | undefined;
	serverScoped: boolean;
}): unknown {
	const { parsedOutput, toolName, targetBoardId, serverScoped } = params;
	if (!targetBoardId || !isCardListTool(toolName)) {
		return parsedOutput;
	}
	// No length guard: an EMPTY unscoped envelope still has to be rewritten so
	// its account-wide `total_count` never reaches `_coverage`.
	const cards = extractCardsArray(parsedOutput);
	if (!cards) {
		return parsedOutput;
	}

	const normalizedBoardId = String(targetBoardId);
	const filtered = cards.filter((card: unknown) => {
		const c = card as {
			board?: { id?: string | number };
			board_id?: string | number;
		};
		const cardBoardId = c?.board?.id || c?.board_id;
		// Keep cards that match OR cards with no board info (can't filter)
		return cardBoardId == null || String(cardBoardId) === normalizedBoardId;
	});
	const dropped = cards.length - filtered.length;

	if (dropped > 0) {
		console.log(
			`[AgentLoop] Board filter: ${cards.length} -> ${filtered.length} cards (removed ${dropped} from other boards)`,
		);
	}

	if (Array.isArray(parsedOutput)) {
		return dropped > 0 ? filtered : parsedOutput;
	}
	if (serverScoped && dropped === 0) {
		return parsedOutput;
	}
	return {
		...(parsedOutput as Record<string, unknown>),
		cards: filtered,
		// The scoping above is client-side; the server-side total describes the
		// unscoped query, so it no longer describes what remains. Null matches
		// the envelope's own "unknown" convention.
		total_count: null,
		_board_filtered: {
			kept: filtered.length,
			dropped,
			board_id: normalizedBoardId,
		},
	};
}

/**
 * Accumulate pagination coverage for a card-list tool under the reserved
 * `_coverage` key: `total_count` (last non-null wins), the distinct pages
 * fetched, and whether the highest fetched page still reported more.
 * `_`-prefixed keys count as zero records in the data gate but are forwarded
 * to the report prompt, so the final report can cite the true total instead
 * of the fetched sample size.
 */
function recordPageCoverage(
	gatheredData: Record<string, unknown>,
	toolName: string,
	envelope: unknown,
): void {
	const meta = extractPageMeta(envelope);
	if (!meta) {
		return;
	}
	if (!gatheredData._coverage) {
		gatheredData._coverage = {};
	}
	const coverageRoot = gatheredData._coverage as Record<string, unknown>;
	const prior = (coverageRoot[toolName] ?? {}) as {
		total_count?: unknown;
		pages_fetched?: unknown;
		has_more_at_last_page?: unknown;
	};
	const page = typeof meta.page === "number" ? meta.page : null;
	const pages = new Set<number>(
		Array.isArray(prior.pages_fetched)
			? (prior.pages_fetched as number[])
			: [],
	);
	if (page !== null) {
		pages.add(page);
	}
	const sortedPages = [...pages].sort((a, b) => a - b);
	const highest = sortedPages[sortedPages.length - 1];
	coverageRoot[toolName] = {
		total_count:
			meta.total_count != null
				? meta.total_count
				: ((prior.total_count as unknown) ?? null),
		pages_fetched: sortedPages,
		has_more_at_last_page:
			page !== null && page === highest
				? (meta.has_more ?? null)
				: ((prior.has_more_at_last_page as unknown) ?? null),
	};
}

/**
 * Merge a tool result into the gathered data dictionary.
 * When the same tool is called multiple times (e.g., fizzy_get_cards with
 * different column_id filters), array results are merged and deduplicated by `id`.
 */
export function mergeToolResult(
	gatheredData: Record<string, unknown>,
	toolName: string,
	result: unknown,
): void {
	// fizzy-mcp 1.1.0 wraps card listings in a page envelope; store the bare
	// card array so every downstream consumer (consolidation, board fix, data
	// gate, budget, renderer) keeps seeing arrays, and keep the envelope's
	// pagination meta under `_coverage`.
	let normalized = result;
	if (isCardListTool(toolName)) {
		const cards = extractCardsArray(result);
		if (cards && !Array.isArray(result)) {
			recordPageCoverage(gatheredData, toolName, result);
			normalized = cards;
		}
	}
	if (gatheredData[toolName] !== undefined) {
		const existing = gatheredData[toolName];
		if (Array.isArray(existing) && Array.isArray(normalized)) {
			// Merge arrays and deduplicate by `id` field if present
			const merged = [...existing, ...normalized];
			const seenIds = new Set<string>();
			const deduped: unknown[] = [];
			for (const item of merged) {
				const id =
					item && typeof item === "object" && "id" in item
						? (item as { id: string }).id
						: null;
				if (id) {
					if (seenIds.has(id)) {
						continue;
					}
					seenIds.add(id);
				}
				deduped.push(item);
			}
			gatheredData[toolName] = deduped;
		} else {
			// Non-array: use numbered suffix
			let suffix = 2;
			while (gatheredData[`${toolName}_${suffix}`] !== undefined) {
				suffix++;
			}
			gatheredData[`${toolName}_${suffix}`] = normalized;
		}
	} else {
		gatheredData[toolName] = normalized;
	}
}

/**
 * Consolidate individual card results into the bulk cards array. Exported for
 * tests.
 *
 * The AI often calls `fizzy_get_card` (singular) many times to fetch individual
 * cards. `mergeToolResult` stores these as `fizzy_get_card`, `fizzy_get_card_2`,
 * `fizzy_get_card_3`, etc. (numbered suffixes for non-array results).
 *
 * This function merges all `fizzy_get_card*` objects into the `fizzy_get_cards`
 * (plural) array so all card data is unified for table rendering and AI analysis.
 */
export function consolidateIndividualCards(
	gatheredData: Record<string, unknown>,
): void {
	const bulkKey = "fizzy_get_cards";
	const individualPrefix = "fizzy_get_card";

	// Collect individual card objects from fizzy_get_card, fizzy_get_card_2, etc.
	const individualCards: unknown[] = [];
	const keysToRemove: string[] = [];

	for (const [key, value] of Object.entries(gatheredData)) {
		// Match fizzy_get_card or fizzy_get_card_N (but NOT fizzy_get_cards or fizzy_get_card_comments)
		if (key === individualPrefix || /^fizzy_get_card_\d+$/.test(key)) {
			if (value && typeof value === "object" && !Array.isArray(value)) {
				individualCards.push(value);
				keysToRemove.push(key);
			}
		}
	}

	if (individualCards.length === 0) {
		return;
	}

	console.log(
		`[AgentLoop:Consolidate] Merging ${individualCards.length} individual fizzy_get_card results into ${bulkKey}`,
	);

	// Merge into the bulk cards array
	const existingCards = Array.isArray(gatheredData[bulkKey])
		? (gatheredData[bulkKey] as unknown[])
		: [];
	const merged = [...existingCards, ...individualCards];

	// Deduplicate by id
	const seenIds = new Set<string>();
	const deduped: unknown[] = [];
	for (const item of merged) {
		const id =
			item && typeof item === "object" && "id" in item
				? String((item as { id: unknown }).id)
				: null;
		if (id) {
			if (seenIds.has(id)) {
				continue;
			}
			seenIds.add(id);
		}
		deduped.push(item);
	}

	gatheredData[bulkKey] = deduped;

	// Remove individual keys to avoid duplicate data in downstream processing
	for (const key of keysToRemove) {
		delete gatheredData[key];
	}

	console.log(
		`[AgentLoop:Consolidate] Result: ${deduped.length} total unique cards (was ${existingCards.length} bulk + ${individualCards.length} individual)`,
	);
}

/**
 * Build the final prompt when tool limit is reached
 */
function _buildFinalGatheringPrompt(_toolResults: ToolCallResult[]): string {
	const parts: string[] = [];

	parts.push("You have reached the maximum number of tool calls.");
	parts.push("Please summarize the data you have gathered so far.");
	parts.push("");
	parts.push(
		"**Note**: Data gathering may be incomplete as the tool call limit was reached.",
	);
	parts.push("");

	return parts.join("\n");
}

// =============================================================================
// MCP Tool Gathering
// =============================================================================

/**
 * Connect to each MCP config, list tools, and keep only read-only ones.
 * Captures a per-server diagnostic (success and failure) instead of swallowing
 * connection errors. Degrades: returns whatever tools connected; the caller
 * decides whether the (possibly empty) result is fatal.
 */
/**
 * Load DB display names for the given configs so a connection that fails before
 * the server identifies itself still surfaces a friendly name. Best-effort: on
 * any DB error it returns an empty map and probing falls back to the config id.
 */
async function loadConfigDisplayNames(
	configIds: string[],
): Promise<Record<string, string>> {
	if (configIds.length === 0) {
		return {};
	}
	try {
		const rows = await db.mCPConfig.findMany({
			where: { id: { in: configIds } },
			select: {
				id: true,
				displayName: true,
				mcpServer: { select: { name: true } },
			},
		});
		const map: Record<string, string> = {};
		for (const r of rows) {
			const name = r.displayName || r.mcpServer?.name;
			if (name) {
				map[r.id] = name;
			}
		}
		return map;
	} catch (error) {
		console.warn(
			"[AgentLoop] Failed to load MCP config display names:",
			error,
		);
		return {};
	}
}

/**
 * Probe a single MCP config: connect, list tools, keep read-only ones, and
 * produce a diagnostic. Never throws — connection failures become an
 * error-outcome diagnostic. `displayName` is the DB-known friendly name, used
 * as the serverName fallback when a connection fails before the server
 * identifies itself (so the UI shows "GitHub", not a raw config id).
 */
async function probeMcpConfig(
	configId: string,
	opts: {
		userId: string;
		organizationId?: string;
		providers: string[];
		displayName?: string;
	},
): Promise<{
	configId: string;
	diagnostic: McpServerDiagnostic;
	tools: Record<string, McpToolDefinition>;
}> {
	const { userId, organizationId, providers, displayName } = opts;
	try {
		const result = await getCachedMcpClientForConfig({
			configId,
			userId,
			organizationId,
		});
		const serverName = result.serverName || displayName || configId;
		const allServerTools = await result.client.tools();
		const total = Object.keys(allServerTools).length;
		const tools: Record<string, McpToolDefinition> = {};

		for (const [toolName, toolDef] of Object.entries(allServerTools)) {
			if (!isReadOnlyTool(toolName, providers)) {
				continue;
			}
			const def = toolDef as {
				description?: string;
				inputSchema?: Record<string, unknown>;
			};
			tools[toolName] = {
				description: def.description || toolName,
				inputSchema: def.inputSchema || { type: "object" },
				configId,
				serverName,
			};
		}

		const readOnlyCount = Object.keys(tools).length;
		console.log(
			`[AgentLoop] Connected to ${serverName}, ${readOnlyCount}/${total} read-only tools`,
		);
		return {
			configId,
			tools,
			diagnostic: {
				configId,
				serverName,
				outcome: classifyToolOutcome(total, readOnlyCount),
				toolCount: total,
				readOnlyToolCount: readOnlyCount,
			},
		};
	} catch (error) {
		const outcome = classifyConnectionError(error);
		const raw = error instanceof Error ? error.message : String(error);
		// McpClientError may carry the friendly serverName; otherwise fall back
		// to the DB displayName, then the raw config id as a last resort.
		const serverName =
			(error as { serverName?: string })?.serverName ||
			displayName ||
			configId;
		console.warn(
			`[AgentLoop] Failed to connect to MCP config ${configId} (${outcome}):`,
			raw,
		);
		return {
			configId,
			tools: {},
			diagnostic: {
				configId,
				serverName,
				outcome,
				toolCount: 0,
				readOnlyToolCount: 0,
				errorMessage: redactMessage(raw),
			},
		};
	}
}

/**
 * Self-healing resolution of a report instance's MCP connections — the root-cause
 * fix for dangling bindings.
 *
 * For each MCP data source, resolve its bound config id: PREFER the stored id, but
 * if it's gone / reconnected → new id / a teammate's or another-context config,
 * fall back to the running user's OWN config for that server (see
 * {@link resolveReportMcpConfig}). Returns the effective `mcpConfigs` (for the
 * agentic loop) and `mcpBindings` (for the handler), so a stale/deleted config id
 * no longer hard-fails the whole run with CONFIG_NOT_FOUND.
 *
 * It's an ordinary activity (no workflow state) — safe for the worker; the
 * WORKFLOW gates the call behind `patched()` so in-flight executions are
 * unaffected.
 */
export async function resolveReportConnections(input: {
	connections: {
		mcpConfigs?: string[];
		mcpBindings?: Record<string, string>;
	};
	dataSources: Array<{
		id?: string;
		key?: string;
		provider?: string;
		type?: string;
		config?: { mcpServerKey?: string };
	}>;
	userId: string;
	organizationId?: string;
}): Promise<{
	mcpConfigs: string[];
	mcpBindings: Record<string, string>;
	healed: Array<{ dataSource: string; from: string | null; to: string }>;
	unresolved: string[];
}> {
	const { connections, dataSources, userId, organizationId } = input;
	const origBindings = connections.mcpBindings ?? {};
	const origConfigs = Array.isArray(connections.mcpConfigs)
		? connections.mcpConfigs
		: [];

	const mcpBindings: Record<string, string> = { ...origBindings };
	const configOrder: string[] = [];
	const configSet = new Set<string>();
	const healed: Array<{
		dataSource: string;
		from: string | null;
		to: string;
	}> = [];
	const unresolved: string[] = [];

	const mcpDataSources = dataSources.filter(
		(d) => (d.type ?? "mcp") === "mcp",
	);

	for (const ds of mcpDataSources) {
		const dsLabel = ds.id ?? ds.key ?? ds.provider;
		if (!dsLabel) {
			continue;
		}
		// The binding may be keyed by the data source id, provider, or key.
		const stored =
			(ds.id ? origBindings[ds.id] : undefined) ??
			(ds.provider ? origBindings[ds.provider] : undefined) ??
			(ds.key ? origBindings[ds.key] : undefined) ??
			null;
		const serverKeys = [
			ds.provider,
			ds.key,
			ds.id,
			ds.config?.mcpServerKey,
		].filter(Boolean) as string[];

		const resolved = await resolveReportMcpConfig({
			storedConfigId: stored,
			serverKeys,
			userId,
			organizationId,
		});

		if (!resolved || !resolved.enabled) {
			unresolved.push(dsLabel);
			continue;
		}

		if (!configSet.has(resolved.configId)) {
			configSet.add(resolved.configId);
			configOrder.push(resolved.configId);
		}
		// Write the effective id under every key this source may be looked up by,
		// so both the agentic loop (mcpConfigs) and the handler (mcpBindings[id] /
		// [provider]) see the healed config.
		for (const k of [ds.id, ds.provider, ds.key]) {
			if (k) {
				mcpBindings[k] = resolved.configId;
			}
		}
		if (resolved.healed) {
			healed.push({
				dataSource: dsLabel,
				from: stored,
				to: resolved.configId,
			});
		}
	}

	// Legacy/empty case: nothing resolved via data-source metadata (e.g. an
	// instance carrying only a raw mcpConfigs array). Preserve the original
	// configs so behaviour is unchanged for those.
	const mcpConfigs =
		configOrder.length > 0 ? configOrder : Array.from(new Set(origConfigs));

	return { mcpConfigs, mcpBindings, healed, unresolved };
}

export async function gatherMcpReadOnlyTools(params: {
	mcpConfigIds: string[];
	providers: string[];
	userId: string;
	organizationId?: string;
	/** Map of configId -> friendly name, used as a fallback on failures. */
	configDisplayNames?: Record<string, string>;
}): Promise<{
	tools: Record<string, McpToolDefinition>;
	toolConfigMap: Record<string, string>;
	diagnostics: McpServerDiagnostic[];
}> {
	const {
		mcpConfigIds,
		providers,
		userId,
		organizationId,
		configDisplayNames,
	} = params;
	const tools: Record<string, McpToolDefinition> = {};
	const toolConfigMap: Record<string, string> = {};

	heartbeat();
	// Probe every config concurrently — independent network round trips, each
	// with its own connection timeout. Sequential probing made one slow/dead
	// server block all the others (N x timeout latency on the hot path).
	const probes = await Promise.all(
		mcpConfigIds.map((configId) =>
			probeMcpConfig(configId, {
				userId,
				organizationId,
				providers,
				displayName: configDisplayNames?.[configId],
			}),
		),
	);

	const diagnostics = probes.map((p) => p.diagnostic);

	// Merge tool maps deterministically: the first config to expose a given
	// tool name wins. Without this, a later config silently shadowed an earlier
	// one in the flat map while both were still reported as connected.
	for (const probe of probes) {
		for (const [toolName, def] of Object.entries(probe.tools)) {
			if (toolName in tools) {
				console.warn(
					`[AgentLoop] Tool name collision "${toolName}": keeping config ${toolConfigMap[toolName]}, ignoring ${probe.configId}`,
				);
				continue;
			}
			tools[toolName] = def;
			toolConfigMap[toolName] = probe.configId;
		}
	}

	return { tools, toolConfigMap, diagnostics };
}

// =============================================================================
// Main Activity
// =============================================================================

/**
 * Execute the agent loop for data gathering
 *
 * This activity implements an agentic approach where:
 * 1. AI receives the task, context, and available read-only tools
 * 2. AI decides which tools to call (max iterations, each can invoke multiple tools)
 * 3. AI returns gathered data for report rendering
 */
export async function executeAgentDataGatheringLoop(
	input: ExecuteAgentLoopInput,
): Promise<AgentLoopResult> {
	const {
		taskDescription,
		promptOverride,
		context: rawContext,
		mcpConfigIds,
		providers,
		maxIterations = 15,
		enrichedSystemPrompt,
		customSystemPrompt,
		skillsContent,
		userId,
		organizationId,
		jobType,
		executionId,
	} = input;
	// Normalize context: coerce all values to strings (JSON parsing can produce numbers)
	const context = normalizeContext(rawContext);
	const toolResults: ToolCallResult[] = [];
	const toolsUsed: string[] = [];
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	// Outer-scoped so the catch block can include diagnostics collected so far
	let diagnostics: McpServerDiagnostic[] = [];

	try {
		// 1. Connect to MCP servers and discover tools
		console.log(
			`[AgentLoop] Connecting to ${mcpConfigIds.length} MCP servers for execution ${executionId}`,
		);

		// Resolve friendly names up-front so a connection that fails before the
		// server identifies itself still shows a human name (not a raw config id).
		const configDisplayNames = await loadConfigDisplayNames(mcpConfigIds);

		const {
			tools: allTools,
			toolConfigMap,
			diagnostics: mcpDiagnostics,
		} = await gatherMcpReadOnlyTools({
			mcpConfigIds,
			providers,
			userId,
			organizationId,
			configDisplayNames,
		});
		diagnostics = mcpDiagnostics;

		if (Object.keys(allTools).length === 0) {
			return {
				gatheredData: {},
				toolCallCount: 0,
				isPartial: true,
				toolsUsed: [],
				usage: { inputTokens: 0, outputTokens: 0 },
				error: buildNoToolsErrorMessage(diagnostics),
				mcpDiagnostics: diagnostics,
			};
		}

		console.log(
			"[AgentLoop] Total read-only tools available:",
			Object.keys(allTools).length,
		);

		// 2. Convert tools to AI SDK format
		const aiSdkTools: Record<string, unknown> = {};
		for (const [toolName, toolDef] of Object.entries(allTools)) {
			try {
				const zodSchema = jsonSchemaToZod(
					toolDef.inputSchema || { type: "object" },
				);
				aiSdkTools[toolName] = tool({
					description: toolDef.description,
					inputSchema: zodSchema,
				} as unknown as Parameters<typeof tool>[0]);
			} catch (error) {
				console.warn(
					`[AgentLoop] Failed to convert tool ${toolName}:`,
					error,
				);
			}
		}

		// Log tool schemas for debugging (helps identify available parameters)
		for (const [toolName, toolDef] of Object.entries(allTools)) {
			const schema = toolDef.inputSchema;
			const props = (schema as Record<string, unknown>)?.properties;
			const jsonSchema = (schema as Record<string, unknown>)?.jsonSchema;
			const actualProps =
				jsonSchema && typeof jsonSchema === "object"
					? (jsonSchema as Record<string, unknown>).properties
					: props;
			const paramNames = actualProps
				? Object.keys(actualProps as Record<string, unknown>)
				: [];
			console.log(
				`[AgentLoop] Tool schema: ${toolName}(${paramNames.join(", ")}) — ${toolDef.description?.substring(0, 100)}`,
			);
		}

		// 3. Build system prompt
		// Priority: customSystemPrompt > enrichedSystemPrompt > default hardcoded prompt
		let baseSystemPrompt =
			customSystemPrompt ||
			enrichedSystemPrompt ||
			REPORT_AGENT_SYSTEM_PROMPT;
		// Append promptOverride as additional system instructions (role/behavior directives)
		// This keeps it out of the user message so the AI gets a concrete task instead
		if (promptOverride) {
			baseSystemPrompt = `${baseSystemPrompt}\n\n## Additional Instructions\n${promptOverride}`;
		}
		// Append skills content if provided
		if (skillsContent) {
			baseSystemPrompt = `${baseSystemPrompt}\n\n${skillsContent}`;
		}
		const promptSource = customSystemPrompt
			? "custom"
			: enrichedSystemPrompt
				? "enriched"
				: "default";
		const systemPrompt = buildDataGatheringPrompt(
			context,
			baseSystemPrompt,
		);

		// 4. Get AI model
		const { getAiModelWithSelection } = await import(
			"../orchestrator/utils/model-selector"
		);
		const { model, provider, modelString } = await getAiModelWithSelection(
			userId,
			organizationId,
			true,
			undefined,
			jobType,
		);

		// --- Structured logging: Activity start ---
		console.log(`[AgentLoop] ===== EXECUTION START (${executionId}) =====`);
		console.log(
			`[AgentLoop] Config: tools=${Object.keys(aiSdkTools).length}, maxIterations=${maxIterations}, promptSource=${promptSource}`,
		);
		console.log(
			`[AgentLoop] Available tools: ${Object.keys(aiSdkTools).join(", ")}`,
		);
		console.log(
			`[AgentLoop] System prompt (${systemPrompt.length} chars):\n${systemPrompt}`,
		);

		// 5. Run agentic loop
		// taskDescription is always the actionable task (what data to gather/report to produce)
		// promptOverride is folded into system prompt above as role/behavior instructions
		// Include context values in the user message so the LLM uses them immediately
		// instead of ignoring them in the system prompt and doing unnecessary discovery
		let userMessage =
			taskDescription ||
			"Gather the data needed and provide a comprehensive analysis. Use the available tools to collect information, then summarize what you found.";

		if (Object.keys(context).length > 0) {
			const contextLines: string[] = [];
			for (const [key, value] of Object.entries(context)) {
				if (value) {
					contextLines.push(`- ${key}: ${value}`);
				}
			}
			if (contextLines.length > 0) {
				userMessage += `\n\nUse these values in tool calls — IDs/slugs as arguments, names to match listing results (do NOT call discovery tools to re-find them):\n${contextLines.join("\n")}`;
			}
		}

		console.log(`[AgentLoop] User message: ${userMessage}`);

		const conversationHistory: Array<{
			role: "user" | "assistant" | "tool";
			content: string | unknown[];
		}> = [
			{
				role: "user",
				content: userMessage,
			},
		];

		let iterationCount = 0;
		let toolCallCount = 0;
		let salvagedFromEmptyTurn = false;
		const gatheredData: Record<string, unknown> = {};
		let lastStreamDiagnostics: StreamDiagnostics | undefined;

		while (iterationCount < maxIterations) {
			heartbeat();
			iterationCount++;

			console.log(
				`[AgentLoop] --- Iteration ${iterationCount}/${maxIterations} ---`,
			);

			// Run one model iteration with empty-turn resilience (Fizzy agent-loop).
			// An empty turn (no text + no tool calls, or NoOutputGeneratedError) is
			// retried up to MAX_ATTEMPTS (3) attempts with backoff; a genuine error
			// propagates to the function catch (fail-loud). usage is summed across
			// attempts so empty-turn token cost is not lost.
			const makeStream = () =>
				streamText(
					buildReportStreamRequest({
						model,
						system: systemPrompt,
						messages: conversationHistory,
						tools: aiSdkTools,
					}),
				) as unknown as ModelStreamLike;

			const outcome = await runModelIterationWithRetry(makeStream, {
				heartbeat,
			});
			lastStreamDiagnostics = {
				...outcome.streamDiagnostics,
				provider,
				modelString,
			};

			// Accumulate token usage for EVERY iteration, including a salvaged
			// empty one, before any early exit (Codex finding 3).
			totalInputTokens += outcome.usage.inputTokens;
			totalOutputTokens += outcome.usage.outputTokens;

			if (outcome.kind === "empty") {
				salvagedFromEmptyTurn = true;
				console.warn(
					`[AgentLoop] Empty model turn after retry at iteration ${iterationCount}; salvaging ${toolResults.length} gathered tool result(s)`,
				);
				break;
			}

			const result = {
				text: outcome.text,
				toolCalls: outcome.toolCalls as Array<{
					toolCallId: string;
					toolName: string;
					input?: unknown;
				}>,
				usage: outcome.usage,
			};

			console.log(
				`[AgentLoop] Iteration ${iterationCount} tokens: input=${outcome.usage.inputTokens}, output=${outcome.usage.outputTokens} (cumulative: input=${totalInputTokens}, output=${totalOutputTokens})`,
			);

			// Check if this is a final response (no tool calls)
			if (!result.toolCalls || result.toolCalls.length === 0) {
				const responseText = result.text || "";

				console.log(
					`[AgentLoop] AI completed data gathering (response: ${responseText.length} chars)`,
				);
				console.log(
					`[AgentLoop] AI final response:\n${responseText.substring(0, 2000)}${responseText.length > 2000 ? "\n... [truncated]" : ""}`,
				);

				// Compile gathered data from tool results (merge multiple calls to same tool)
				for (const tr of toolResults) {
					if (!tr.error) {
						mergeToolResult(gatheredData, tr.toolName, tr.result);
					}
				}

				// Consolidate individual card results into the bulk cards array
				consolidateIndividualCards(gatheredData);

				// Post-processing: fix board-specific card data if needed
				const boardFixApplied = await fetchBoardSpecificCards({
					gatheredData,
					context,
					toolConfigMap,
					userId,
					organizationId,
				});

				console.log(
					`[AgentLoop] ===== EXECUTION COMPLETE (${executionId}) =====`,
				);
				console.log(
					`[AgentLoop] Summary: ${iterationCount} iterations, ${toolCallCount} tool calls, tools=[${toolsUsed.join(", ")}]`,
				);
				console.log(
					`[AgentLoop] Total tokens: input=${totalInputTokens}, output=${totalOutputTokens}`,
				);
				console.log(
					`[AgentLoop] Data keys: ${Object.keys(gatheredData).join(", ")}`,
				);

				// Bound the payload so a large board's data cannot exceed
				// Temporal's activity-result blob limit.
				const budgeted = finalizeGatheredData(
					gatheredData,
					executionId,
				);
				return {
					gatheredData: budgeted.data,
					toolCallCount,
					// A trimmed run is partial (renders the existing partial notice).
					// So is a board fix: it swapped in page-1-per-column fetches
					// whose coverage against the board total is unknown.
					isPartial: budgeted.trimmed || boardFixApplied,
					toolsUsed,
					usage: {
						inputTokens: totalInputTokens,
						outputTokens: totalOutputTokens,
					},
					mcpDiagnostics: diagnostics,
					streamDiagnostics: lastStreamDiagnostics,
					...(budgeted.truncation
						? { gatheredDataTruncation: budgeted.truncation }
						: {}),
				};
			}

			// Log tool calls for this iteration
			console.log(
				`[AgentLoop] Iteration ${iterationCount}: AI requested ${result.toolCalls.length} tool call(s): ${result.toolCalls.map((tc: any) => tc.toolName).join(", ")}`,
			);

			// Build assistant message with ALL tool calls from this turn
			// AI SDK uses 'input' not 'args' for tool calls
			const toolCallParts: Array<{
				type: "tool-call";
				toolCallId: string;
				toolName: string;
				input: Record<string, unknown>;
			}> = [];

			// Collect tool results to add after processing all tool calls
			// AI SDK uses 'output' with { type: 'json' | 'text', value: ... } format
			const toolResultsForHistory: Array<{
				type: "tool-result";
				toolCallId: string;
				toolName: string;
				output:
					| { type: "json"; value: unknown }
					| { type: "text"; value: string };
			}> = [];

			// Process tool calls (cap per-iteration to prevent runaway cost)
			const toolCallsToProcess = result.toolCalls.slice(
				0,
				MAX_TOOL_CALLS_PER_ITERATION,
			);
			if (result.toolCalls.length > MAX_TOOL_CALLS_PER_ITERATION) {
				console.warn(
					`[AgentLoop] AI requested ${result.toolCalls.length} tool calls in one iteration, capping to ${MAX_TOOL_CALLS_PER_ITERATION}`,
				);
			}

			for (const toolCall of toolCallsToProcess) {
				heartbeat(); // Keep alive during multi-tool iterations with LLM summarization
				const typedToolCall = toolCall as {
					toolCallId: string;
					toolName: string;
					input?: unknown;
				};
				const toolName = typedToolCall.toolName;
				const rawArgs =
					(typedToolCall.input as Record<string, unknown>) || {};
				// Coerce numeric values to strings — LLMs often emit JSON numbers
				// for values like account_slug that MCP tools expect as strings.
				// Params the tool's own schema declares as numeric (e.g.
				// fizzy_get_cards' `page`) keep their number; with no schema
				// exposed we fall back to stringifying every number.
				const args = coerceToolArgs(
					rawArgs,
					allTools[toolName]?.inputSchema,
				);

				console.log(`[AgentLoop] Executing tool: ${toolName}`);
				console.log(`[AgentLoop]   Args: ${JSON.stringify(args)}`);

				toolCallCount++;
				if (!toolsUsed.includes(toolName)) {
					toolsUsed.push(toolName);
				}

				// Add tool call to the assistant message parts (AI SDK uses 'input')
				toolCallParts.push({
					type: "tool-call",
					toolCallId: typedToolCall.toolCallId,
					toolName,
					input: args,
				});

				// Execute the tool — re-fetch client from cache each time to keep
				// connections alive and handle reconnection if cache TTL expired
				const toolConfigId = toolConfigMap[toolName];
				if (!toolConfigId) {
					const errorResult: ToolCallResult = {
						toolName,
						result: null,
						error: `Tool ${toolName} not found`,
					};
					toolResults.push(errorResult);

					toolResultsForHistory.push({
						type: "tool-result",
						toolCallId: typedToolCall.toolCallId,
						toolName,
						output: {
							type: "json",
							value: { error: errorResult.error },
						},
					});
					continue;
				}

				try {
					const { client: mcpClient } =
						await getCachedMcpClientForConfig({
							configId: toolConfigId,
							userId,
							organizationId,
						});
					const mcpTools = await mcpClient.tools();
					const mcpTool = mcpTools[toolName] as unknown as {
						execute?: (
							args: Record<string, unknown>,
							context: {
								toolCallId: string;
								messages: unknown[];
							},
						) => Promise<unknown>;
					};

					let toolOutput: unknown;
					if (mcpTool?.execute) {
						toolOutput = await mcpTool.execute(args, {
							toolCallId: typedToolCall.toolCallId,
							messages: [],
						});
					} else {
						throw new Error(
							`Tool ${toolName} does not have execute method`,
						);
					}

					const rawParsedOutput = parseMcpResponse(toolOutput);

					// Pre-filter: if this is a card list and we have a target boardId,
					// remove cards from other boards BEFORE summarization
					const targetBoardId = context.boardId || context.board_id;
					const parsedOutput = applyBoardPreFilter({
						parsedOutput: rawParsedOutput,
						toolName,
						targetBoardId: targetBoardId
							? String(targetBoardId)
							: undefined,
						serverScoped: Boolean(args.board_id || args.column_id),
					});

					const successResult: ToolCallResult = {
						toolName,
						result: parsedOutput,
					};
					toolResults.push(successResult);

					// Summarize large results using LLM to preserve relevant context
					let resultForContext = parsedOutput;
					const resultStr = JSON.stringify(parsedOutput);
					const MAX_RESULT_CHARS = 12000;
					if (resultStr.length > MAX_RESULT_CHARS) {
						// A fizzy-mcp page envelope carries the pagination fields the
						// model needs to keep paginating (has_more/next_page/total_count).
						// Whatever happens to the body below, these survive verbatim.
						const pageMeta = extractPageMeta(parsedOutput) ?? {};
						// The board pre-filter's honesty marker matters most on
						// exactly these large pages — carry it through every
						// shrunken shape below, same as the pagination meta.
						const boardFiltered =
							parsedOutput &&
							typeof parsedOutput === "object" &&
							!Array.isArray(parsedOutput)
								? (parsedOutput as Record<string, unknown>)
										._board_filtered
								: undefined;
						// Cards are ~33KB each raw; project them down before summarizing
						// so a 1MB page becomes a single summarizer call — or none, when
						// the projection already fits.
						const contextCards = isCardListTool(toolName)
							? extractCardsArray(parsedOutput)
							: null;
						const projected = contextCards?.map(
							projectCardForContext,
						);
						const projectedStr = projected
							? JSON.stringify(projected)
							: null;
						if (
							projected &&
							projectedStr &&
							projectedStr.length <= MAX_RESULT_CHARS
						) {
							console.log(
								`[AgentLoop] Projected ${toolName}: ${resultStr.length} -> ${projectedStr.length} chars (no summarization needed)`,
							);
							resultForContext = {
								_projected: true,
								_originalLength: resultStr.length,
								...pageMeta,
								...(boardFiltered !== undefined
									? { _board_filtered: boardFiltered }
									: {}),
								cards: projected,
							};
						} else {
							const summarizerInput = projectedStr ?? resultStr;
							try {
								const { summarizeLargeToolResult } =
									await import(
										"../orchestrator/execution/summarize-tool-result"
									);
								console.log(
									`[AgentLoop] Summarizing large result for ${toolName} (${summarizerInput.length} chars -> target ${MAX_RESULT_CHARS})`,
								);
								const summary = await summarizeLargeToolResult({
									toolName,
									toolResult: summarizerInput,
									userQuery: userMessage,
									maxOutputLength: MAX_RESULT_CHARS,
									userId,
									organizationId,
								});
								resultForContext = {
									_summarized: true,
									_originalLength: resultStr.length,
									...pageMeta,
									...(boardFiltered !== undefined
										? { _board_filtered: boardFiltered }
										: {}),
									summary,
								};
								console.log(
									`[AgentLoop] Summarized ${toolName}: ${summarizerInput.length} -> ${summary.length} chars`,
								);
							} catch (summarizeError) {
								// Fallback to simple truncation if summarization fails
								console.log(
									`[AgentLoop] Summarization failed for ${toolName}, falling back to truncation: ${summarizeError instanceof Error ? summarizeError.message : "Unknown error"}`,
								);
								resultForContext = {
									_truncated: true,
									_originalLength: resultStr.length,
									...pageMeta,
									...(boardFiltered !== undefined
										? { _board_filtered: boardFiltered }
										: {}),
									data: (projectedStr ?? resultStr).substring(
										0,
										MAX_RESULT_CHARS,
									),
								};
							}
						}
					}

					toolResultsForHistory.push({
						type: "tool-result",
						toolCallId: typedToolCall.toolCallId,
						toolName,
						output: { type: "json", value: resultForContext },
					});

					const resultSize = resultStr.length;
					const loggedCards = isCardListTool(toolName)
						? extractCardsArray(parsedOutput)
						: null;
					const itemCount = loggedCards
						? loggedCards.length
						: Array.isArray(parsedOutput)
							? parsedOutput.length
							: typeof parsedOutput === "object" &&
									parsedOutput !== null
								? Object.keys(parsedOutput).length
								: 1;
					console.log(
						`[AgentLoop]   Result: ${resultSize} chars, ${loggedCards || Array.isArray(parsedOutput) ? `${itemCount} items` : `${itemCount} keys`}${resultStr.length > 12000 ? " (truncated for context)" : ""}`,
					);
				} catch (error) {
					const errorMessage =
						error instanceof Error
							? error.message
							: "Unknown error";
					const errorResult: ToolCallResult = {
						toolName,
						result: null,
						error: errorMessage,
					};
					toolResults.push(errorResult);

					toolResultsForHistory.push({
						type: "tool-result",
						toolCallId: typedToolCall.toolCallId,
						toolName,
						output: {
							type: "json",
							value: { error: errorMessage },
						},
					});

					console.warn(
						`[AgentLoop] Tool ${toolName} failed:`,
						errorMessage,
					);
				}
			}

			console.log(
				`[AgentLoop] Iteration ${iterationCount} summary: ${toolCallParts.length} tool calls made (total tools used: ${toolCallCount})`,
			);

			// Add ONE assistant message with ALL tool calls from this turn
			// AI SDK expects tool calls with 'input' property
			if (toolCallParts.length > 0) {
				conversationHistory.push({
					role: "assistant",
					content: toolCallParts,
				});
			}

			// Add ONE tool message with ALL tool results
			// AI SDK expects tool results with 'output' property in { type: 'json', value: ... } format
			if (toolResultsForHistory.length > 0) {
				conversationHistory.push({
					role: "tool",
					content: toolResultsForHistory,
				});
			}
		}

		// 6. If we hit the iteration limit, compile what we have
		console.log(
			`[AgentLoop] Iteration limit (${maxIterations}) reached, compiling gathered data`,
		);

		for (const tr of toolResults) {
			if (!tr.error) {
				mergeToolResult(gatheredData, tr.toolName, tr.result);
			}
		}

		// Consolidate individual card results into the bulk cards array
		consolidateIndividualCards(gatheredData);

		// Post-processing: fix board-specific card data if needed
		await fetchBoardSpecificCards({
			gatheredData,
			context,
			toolConfigMap,
			userId,
			organizationId,
		});

		const compiledEmpty = Object.keys(gatheredData).length === 0;
		console.log(
			`[AgentLoop] ===== EXECUTION COMPLETE - PARTIAL${salvagedFromEmptyTurn ? " (empty-turn salvage)" : " (iteration limit)"} (${executionId}) =====`,
		);
		console.log(
			`[AgentLoop] Summary: ${iterationCount} iterations (${salvagedFromEmptyTurn ? "empty-turn salvage" : "limit reached"}), ${toolCallCount} tool calls, tools=[${toolsUsed.join(", ")}]`,
		);
		console.log(
			`[AgentLoop] Total tokens: input=${totalInputTokens}, output=${totalOutputTokens}`,
		);
		console.log(
			`[AgentLoop] Data keys: ${Object.keys(gatheredData).join(", ")}`,
		);

		// Bound the payload so a large board's data cannot exceed Temporal's
		// activity-result blob limit. Already a partial run.
		const budgeted = finalizeGatheredData(gatheredData, executionId);
		return {
			gatheredData: budgeted.data,
			toolCallCount,
			isPartial: true,
			toolsUsed,
			usage: {
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			},
			streamDiagnostics: lastStreamDiagnostics,
			...(budgeted.truncation
				? { gatheredDataTruncation: budgeted.truncation }
				: {}),
			...(compiledEmpty
				? {
						error: `Report generation produced no output: the model returned an empty response after ${toolCallCount} tool call(s); no data was gathered.`,
					}
				: {}),
			mcpDiagnostics: diagnostics,
		};
	} catch (error) {
		console.error(
			`[AgentLoop] ===== EXECUTION FAILED (${executionId}) =====`,
		);
		console.error("[AgentLoop] Error:", error);
		return {
			gatheredData: {},
			toolCallCount: toolResults.length,
			isPartial: true,
			toolsUsed,
			usage: {
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			},
			error: error instanceof Error ? error.message : "Unknown error",
			mcpDiagnostics: diagnostics,
		};
	} finally {
		// Don't close MCP clients here — they are managed by the cache layer
		// (getCachedMcpClientForConfig). Closing them here invalidates the cache
		// entry, causing "closed client" errors on subsequent executions.
		// The cache TTL (10 minutes) handles cleanup automatically.
	}
}

/**
 * Post-processing: Fetch board-specific cards using per-column strategy
 *
 * An UNFILTERED `fizzy_get_cards` call returns one page of the most recent
 * cards across ALL boards (page 1 unless a `page` argument was passed).
 * Runs after the client-side board pre-filter (which already removed cards
 * attributed to other boards): refetches per column when more than half of the
 * retained cards cannot be attributed to the target board, i.e. they carry no
 * board metadata.
 *
 * Strategy: Fetch columns for the target board, then call `fizzy_get_cards` per column_id.
 * Columns are board-scoped, so filtering by column_id effectively filters by board.
 *
 * Returns true only when it actually replaced `gatheredData.fizzy_get_cards`
 * with the per-column refetch. Those fetches are page-1-per-column, so the
 * replacement set is of unknown completeness — the caller must treat the run as
 * partial. Every skip, early return and failure path returns false.
 */
async function fetchBoardSpecificCards(params: {
	gatheredData: Record<string, unknown>;
	context: Record<string, string | undefined>;
	toolConfigMap: Record<string, string>;
	userId: string;
	organizationId?: string;
}): Promise<boolean> {
	const { gatheredData, context, toolConfigMap, userId, organizationId } =
		params;

	// Determine target board ID and account slug from context
	const targetBoardId = context.boardId || context.board_id;
	const accountSlug = context.accountSlug || context.account_slug;

	if (!targetBoardId || !accountSlug) {
		console.log(
			"[AgentLoop:BoardFix] No boardId or accountSlug in context, skipping board-specific fetch",
		);
		return false;
	}

	// Check if we have fizzy_get_cards data
	const cardsData = gatheredData.fizzy_get_cards;
	if (!Array.isArray(cardsData) || cardsData.length === 0) {
		console.log(
			"[AgentLoop:BoardFix] No fizzy_get_cards data found, skipping",
		);
		return false;
	}

	// Check how many cards match the target board (normalize to strings for safe comparison)
	const normalizedTargetBoardId = String(targetBoardId);
	const matchingCards = cardsData.filter((card: unknown) => {
		const c = card as {
			board?: { id?: string | number };
			board_id?: string | number;
		};
		const boardId = c?.board?.id || c?.board_id;
		return boardId != null && String(boardId) === normalizedTargetBoardId;
	});

	const mismatchRatio = 1 - matchingCards.length / cardsData.length;
	console.log(
		`[AgentLoop:BoardFix] Board match: ${matchingCards.length}/${cardsData.length} cards match target board ${targetBoardId} (${Math.round(mismatchRatio * 100)}% mismatch)`,
	);

	// If more than 50% of cards already match, no fix needed
	if (mismatchRatio <= 0.5) {
		console.log(
			"[AgentLoop:BoardFix] Majority of cards match target board, no fix needed",
		);
		return false;
	}

	console.log(
		"[AgentLoop:BoardFix] Majority of cards from wrong board — starting per-column fetch strategy",
	);

	// Find config IDs for fizzy tools
	const columnsConfigId = toolConfigMap.fizzy_get_columns;
	const cardsConfigId = toolConfigMap.fizzy_get_cards;

	if (!columnsConfigId || !cardsConfigId) {
		console.log(
			"[AgentLoop:BoardFix] fizzy_get_columns or fizzy_get_cards not in toolConfigMap, skipping",
		);
		return false;
	}

	try {
		// Step 1: Get columns for the target board
		heartbeat();

		// Use existing column data from gatheredData if available
		let columns: unknown[];
		if (
			Array.isArray(gatheredData.fizzy_get_columns) &&
			gatheredData.fizzy_get_columns.length > 0
		) {
			columns = gatheredData.fizzy_get_columns;
			console.log(
				`[AgentLoop:BoardFix] Reusing ${columns.length} columns from gathered data`,
			);
		} else {
			const { client: columnsClient } = await getCachedMcpClientForConfig(
				{
					configId: columnsConfigId,
					userId,
					organizationId,
				},
			);
			const columnsTools = await columnsClient.tools();
			const columnsTool = columnsTools.fizzy_get_columns as unknown as {
				execute?: (
					args: Record<string, unknown>,
					context: { toolCallId: string; messages: unknown[] },
				) => Promise<unknown>;
			};

			if (!columnsTool?.execute) {
				console.log(
					"[AgentLoop:BoardFix] fizzy_get_columns not executable, skipping",
				);
				return false;
			}

			const columnsResult = await columnsTool.execute(
				{ account_slug: accountSlug, board_id: targetBoardId },
				{
					toolCallId: `board-fix-columns-${Date.now()}`,
					messages: [],
				},
			);
			const parsed = parseMcpResponse(columnsResult);

			if (!Array.isArray(parsed) || parsed.length === 0) {
				console.log(
					"[AgentLoop:BoardFix] No columns found for target board, skipping",
				);
				return false;
			}
			columns = parsed;
			// Store columns in gathered data
			gatheredData.fizzy_get_columns = columns;
		}

		console.log(
			`[AgentLoop:BoardFix] Found ${columns.length} columns for board ${targetBoardId}`,
		);

		// Step 2: Fetch cards for each column
		const allCards: unknown[] = [];
		const seenCardIds = new Set<string>();

		// Keep matching cards from original fetch
		for (const card of matchingCards) {
			const cardId = (card as { id?: string })?.id;
			if (cardId && !seenCardIds.has(cardId)) {
				seenCardIds.add(cardId);
				allCards.push(card);
			}
		}

		for (const column of columns) {
			heartbeat();
			const col = column as { id?: string; name?: string };
			const columnId = col?.id;
			const columnName = col?.name || columnId;

			if (!columnId) {
				continue;
			}

			try {
				const { client: cardsClient } =
					await getCachedMcpClientForConfig({
						configId: cardsConfigId,
						userId,
						organizationId,
					});
				const cardsTools = await cardsClient.tools();
				const cardsTool = cardsTools.fizzy_get_cards as unknown as {
					execute?: (
						args: Record<string, unknown>,
						context: { toolCallId: string; messages: unknown[] },
					) => Promise<unknown>;
				};

				if (!cardsTool?.execute) {
					continue;
				}

				const cardsResult = await cardsTool.execute(
					{ account_slug: accountSlug, column_id: columnId },
					{
						toolCallId: `board-fix-cards-${columnId}-${Date.now()}`,
						messages: [],
					},
				);
				const columnCards = extractCardsArray(
					parseMcpResponse(cardsResult),
				);

				if (columnCards) {
					let addedCount = 0;
					for (const card of columnCards) {
						const cardId = (card as { id?: string })?.id;
						if (cardId && !seenCardIds.has(cardId)) {
							seenCardIds.add(cardId);
							allCards.push(card);
							addedCount++;
						}
					}
					console.log(
						`[AgentLoop:BoardFix] Column "${columnName}": ${columnCards.length} cards fetched, ${addedCount} new unique`,
					);
				} else {
					console.log(
						`[AgentLoop:BoardFix] Column "${columnName}": no card list result`,
					);
				}
			} catch (error) {
				console.warn(
					`[AgentLoop:BoardFix] Failed to fetch cards for column ${columnName}:`,
					error,
				);
			}
		}

		console.log(
			`[AgentLoop:BoardFix] Per-column fetch complete: ${allCards.length} total unique cards (was ${cardsData.length} from bulk fetch)`,
		);

		// Step 3: Replace gathered data with board-specific cards
		if (allCards.length > 0) {
			gatheredData.fizzy_get_cards = allCards;
			// The per-column refetch above replaced the card set with page-1-only
			// column fetches; the old pagination coverage no longer describes it.
			const coverage = gatheredData._coverage as
				| Record<string, unknown>
				| undefined;
			if (coverage) {
				delete coverage.fizzy_get_cards;
			}
			// Underscore key: 0 records in the data gate, forwarded to the report prompt.
			gatheredData._board_fix = { partial: true, coverage: "unknown" };
			return true;
		}
	} catch (error) {
		console.error(
			"[AgentLoop:BoardFix] Board-specific fetch failed:",
			error,
		);
		// Keep original data on failure
	}
	return false;
}

/**
 * Parse MCP tool response
 * Throws an error if the MCP response has isError flag set
 */
function parseMcpResponse(result: unknown): unknown {
	if (result === null || result === undefined) {
		return null;
	}

	const mcpResult = result as { content?: unknown[]; isError?: boolean };

	// Check for MCP error responses - many MCP servers return { isError: true, content: [...] }
	// without throwing, so we need to check this flag explicitly
	if (mcpResult.isError) {
		// Extract error message from content if available
		let errorMessage = "MCP tool returned an error";
		if (mcpResult.content && Array.isArray(mcpResult.content)) {
			const textContent = mcpResult.content.find(
				(c): c is { type: string; text: string } =>
					c !== null &&
					typeof c === "object" &&
					"type" in c &&
					(c as { type?: string }).type === "text",
			);
			if (textContent && typeof textContent.text === "string") {
				errorMessage = textContent.text;
			}
		}
		throw new Error(errorMessage);
	}

	if (mcpResult.content && Array.isArray(mcpResult.content)) {
		const textContent = mcpResult.content.find(
			(c): c is { type: string; text: string } =>
				c !== null &&
				typeof c === "object" &&
				"type" in c &&
				(c as { type?: string }).type === "text",
		);

		if (textContent && typeof textContent.text === "string") {
			try {
				return JSON.parse(textContent.text);
			} catch {
				return textContent.text;
			}
		}
	}

	return result;
}
