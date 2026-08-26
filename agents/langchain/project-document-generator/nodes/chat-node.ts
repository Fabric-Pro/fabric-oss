/**
 * Chat Node
 *
 * Main node for project document generation following the ag-ui-demo pattern.
 *
 * Key behaviors:
 * - Always streams document content via predictive state updates
 * - Model generates summary alongside tool call (in response.content)
 * - After write_document_local, adds confirm_changes tool call and ends
 * - Detects post-confirmation state and outputs acknowledgment only (no tool calls)
 * - Frontend handles confirm/reject locally (no second agent call needed)
 */

import { convertActionsToDynamicStructuredTools } from "@copilotkit/sdk-js/langgraph";
import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	type MessageContent,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import { shapeHistoryForModel } from "@repo/agent-core/message-shape";
import {
	hoistRawStopReason,
	isOutputTruncated,
	resolveStopReason,
} from "@repo/agent-core/output-truncation";
import {
	buildReasoningUpdate,
	countHumanMessages,
	extractTextFromContent,
	stripRawResponseEnvelope,
} from "@repo/agent-core/reasoning-trace";
import { logAgentUsageFromRunnableConfig } from "@repo/agent-core/services/usage-logging";
import {
	applyPatches,
	type DocumentPatch,
	detectDroppedSections,
	detectRenameIntent,
	diagnoseOverlap,
	formatLineRange,
	getDocumentSections,
	listAnchorPaths,
	repairDegradedMarkdown,
	validateDocument,
	validateMarkdownStructure,
} from "@repo/agent-prompts";
import {
	APPLY_DOCUMENT_PATCHES_TOOL,
	WRITE_DOCUMENT_TOOL,
} from "@repo/agent-tools";
import { logger } from "@repo/logs";
import { classifyLimitError } from "@repo/utils/classify-limit-error";
import { normalizeForComparison } from "@repo/utils/normalize-for-comparison";
import { v4 as uuidv4 } from "uuid";
import { buildSystemPromptAsync, getPredictStateConfig } from "../prompts";
import type { AgentState } from "../state";
import {
	buildPatchToolResponseContent,
	buildReplaceAllFollowUpNote,
	calculateRetryDelay,
	countToolRoundsSinceLastHuman,
	DEFAULT_RECURSION_LIMIT,
	extractProviderConfig,
	getAgentModelAsync,
	injectOrgIdIntoToolArgs,
	isContextLengthError,
	isJsonParseError,
	isVisionUnsupportedError,
	MAX_JSON_RETRIES,
	MAX_RETRIES,
	MAX_TOOL_ITERATIONS,
	type ProviderConfig,
	type RequestMessageShapeSummary,
	reasoningOutputAllowanceForConfig,
	sleep,
	summarizeMessagesForLogging,
} from "../utils";
import { reconcileToolCalls } from "./chat-node-tools";

/**
 * Minimum baseline-document size in characters for which we switch from
 * `write_document_local` (full rewrite) to `apply_document_patches` (targeted
 * edits). Full rewrite is already cheap and patch tooling overhead isn't
 * worth it below this threshold. Tunable based on production metrics.
 */
const PATCH_MODE_MIN_DOC_CHARS = 4000;

// 3_200_000 chars ≈ 800K tokens at ~4 chars/token — safety net below
// Anthropic's 1M ctx. The primary fix is the integration-layer extractor.
const BUDGET_TRIM_TRIGGER_CHARS = 3_200_000;
const BUDGET_KEEP_TAIL_MESSAGES = 6;
const BUDGET_SUMMARY_MAX_CHARS = 2_000;

/**
 * Output-token ceiling for an ordinary turn. Deliberately well below what the
 * catalog allows for a large model: several providers admit a request against
 * its rate limit using the REQUESTED `max_tokens` rather than the tokens
 * generated, so reserving a model's full ceiling on every turn can 429 a
 * deployment whose quota sits below it.
 */
const NORMAL_OUTPUT_TOKEN_CEILING = 48_000;

/**
 * Output-token ceiling for the single truncation-recovery retry (issue #2976).
 *
 * The normal ceiling above is a cost/quota trade-off made BEFORE knowing how
 * the turn goes. A turn that came back `finishReason: length` with no content
 * and no tool calls has already proved that budget too small for this
 * particular generation — the provider spent all of it on invisible reasoning
 * before emitting a single visible token. Paying the higher reservation once,
 * on a turn that would otherwise return nothing at all, is the better trade.
 *
 * This is a REQUEST, not a guarantee: `resolveOutputTokenBudget`
 * (`@repo/agent-core/services/langchain-models`) still clamps it down to the
 * resolved model's catalog `maxOutputTokens`, so a small model is never asked
 * for more than it accepts.
 */
const TRUNCATION_RETRY_OUTPUT_TOKEN_CEILING = 96_000;

/**
 * How many times the finalize guard re-prompts a model that called a research
 * tool after its tool budget was spent (issue #2999).
 *
 * Each retry appends error tool results to the SAME request, so the cacheable
 * prefix survives and only the short tail is billed fresh. Two is enough to
 * absorb an ordinary lapse; beyond that the model is not going to comply and
 * the hard fallback below (rebind inline tools only) is cheaper than another
 * round trip.
 */
const MAX_FINALIZE_GUARD_RETRIES = 2;

/**
 * The finalize instruction, as an EPHEMERAL trailing user turn.
 *
 * It must never reach `state.messages`: it exists only inside the array handed
 * to a single `invoke`. Persisting it would add a human turn to the history,
 * which resets the per-turn tool budget that `countToolRoundsSinceLastHuman`
 * derives from that same history — the run would silently earn itself another
 * full round of research on the next node entry.
 *
 * Content is deterministic (no timestamps, no ids): two finalize turns of the
 * same run produce byte-identical text, so this message is not what breaks the
 * provider's prompt cache — and it sits at the very end, after everything the
 * cache covers.
 */
function buildFinalizeDirectiveMessage(params: {
	toolRounds: number;
	patchModeAvailable: boolean;
}): HumanMessage {
	const finalArtifact = params.patchModeAvailable
		? "edit (apply_document_patches or write_document_local)"
		: "document (write_document_local)";
	return new HumanMessage({
		content: `[SYSTEM DIRECTIVE — not from the user]

## Research Budget Exhausted

You have used your available tool-calling budget for this turn (${params.toolRounds} rounds). Do NOT call search, browse, or lookup tools again — any such call is rejected and wastes the turn. Produce your final ${finalArtifact} now using only the information you have already gathered.`,
	});
}

/**
 * A response can carry the same tool call in up to three places, and providers
 * do not always populate all of them:
 *   - `tool_calls` — the normalized LangChain view;
 *   - `additional_kwargs.tool_calls` — the raw OpenAI-shape copy. The unified
 *     server recovers calls from here when the normalized array is empty, so a
 *     call living only here is still a real call;
 *   - `tool_use` / `tool_call` blocks inside array-shaped `content` — the
 *     Anthropic shape, where the call IS part of the content.
 *
 * Anything that decides "does this response call tool X" has to look at all
 * three, and anything that removes a call has to remove it from all three or it
 * reappears on the next replay of the message. Both live on this one reader.
 */
type ToolCallShapes = {
	normalized: Array<Record<string, unknown>>;
	raw: Array<Record<string, unknown>>;
	contentBlocks: Array<Record<string, unknown>>;
};

function isToolCallContentBlock(block: unknown): boolean {
	const type = (block as { type?: unknown } | null | undefined)?.type;
	return type === "tool_use" || type === "tool_call";
}

/** The tool name on any of the three shapes; `""` when a call carries none. */
function readToolCallName(entry: unknown): string {
	const call = entry as
		| { name?: unknown; function?: { name?: unknown } }
		| null
		| undefined;
	const name = call?.function?.name ?? call?.name;
	return typeof name === "string" ? name : "";
}

/**
 * True when a tool call id can actually address a `ToolMessage` back at the
 * model. A blank or non-string id is worse than none: it produces a tool result
 * that references nothing, which providers reject with a 400.
 */
function hasUsableToolCallId(id: unknown): boolean {
	return typeof id === "string" && id.trim().length > 0;
}

function readToolCallShapes(response: {
	content?: unknown;
	tool_calls?: unknown;
	additional_kwargs?: unknown;
}): ToolCallShapes {
	const kwargs = (response.additional_kwargs ?? {}) as Record<
		string,
		unknown
	>;
	return {
		normalized: Array.isArray(response.tool_calls)
			? (response.tool_calls as Array<Record<string, unknown>>)
			: [],
		raw: Array.isArray(kwargs.tool_calls)
			? (kwargs.tool_calls as Array<Record<string, unknown>>)
			: [],
		contentBlocks: Array.isArray(response.content)
			? (response.content as Array<Record<string, unknown>>).filter(
					isToolCallContentBlock,
				)
			: [],
	};
}

/**
 * Names of every tool this response calls that is NOT in `allowed`, looking at
 * all three shapes above. A call with no name at all counts as disallowed: it
 * cannot be executed, and letting it through would leave the same dangling call
 * this check exists to catch.
 */
function disallowedToolCallNames(
	response: AIMessage,
	allowed: Set<string>,
): string[] {
	const shapes = readToolCallShapes(response);
	return [...shapes.normalized, ...shapes.raw, ...shapes.contentBlocks]
		.map(readToolCallName)
		.filter((name) => !allowed.has(name));
}

/**
 * A copy of `response` with every tool call whose name is outside `allowed`
 * removed from all three shapes — content, metadata and the surviving calls
 * carried through intact. Returns the response unchanged (same object) when
 * there is nothing to strip, so callers can run it unconditionally.
 *
 * The terminal fallback of the finalize guard binds only the inline tools, but
 * a bound tool list is a request to the provider, not a schema the response is
 * validated against: gateways do return calls to tools that were never sent,
 * and a hallucinated one persisted here would reach `shouldContinue`, count
 * past the budget, force __end__, and end the run with a dangling tool call and
 * no document — the exact failure the guard exists to prevent.
 */
function stripDisallowedToolCalls(
	response: AIMessage,
	allowed: Set<string>,
): AIMessage {
	if (disallowedToolCallNames(response, allowed).length === 0) {
		return response;
	}

	const isAllowed = (entry: unknown): boolean =>
		allowed.has(readToolCallName(entry));

	const kwargs: Record<string, unknown> = {
		...((response.additional_kwargs ?? {}) as Record<string, unknown>),
	};
	if (Array.isArray(kwargs.tool_calls)) {
		const keptRawCalls = (
			kwargs.tool_calls as Array<Record<string, unknown>>
		).filter(isAllowed);
		if (keptRawCalls.length > 0) {
			kwargs.tool_calls = keptRawCalls;
		} else {
			delete kwargs.tool_calls;
		}
	}

	const content: MessageContent = Array.isArray(response.content)
		? ((response.content as Array<Record<string, unknown>>).filter(
				(block) => !isToolCallContentBlock(block) || isAllowed(block),
			) as MessageContent)
		: response.content;

	return new AIMessage({
		content,
		tool_calls: (response.tool_calls ?? []).filter(isAllowed),
		invalid_tool_calls: response.invalid_tool_calls,
		additional_kwargs: kwargs,
		response_metadata: response.response_metadata,
		usage_metadata: response.usage_metadata,
		id: response.id,
	});
}

/**
 * True when the model returned nothing usable: no tool calls and no text
 * content. Combined with {@link isOutputTruncated} this is the signature of
 * issue #2976 — a reasoning-capable model that burned its entire output
 * budget on invisible thinking and emitted no visible tokens at all.
 *
 * A response carrying partial text, or a tool call (even one with unusable
 * args — the malformed-args branches below own that case), is NOT empty.
 */
function isEmptyModelResponse(response: {
	content?: unknown;
	tool_calls?: unknown;
}): boolean {
	const toolCalls = response.tool_calls;
	if (Array.isArray(toolCalls) && toolCalls.length > 0) {
		return false;
	}
	return extractTextFromContent(response.content).trim().length === 0;
}

function approximateMessageChars(msg: BaseMessage): number {
	const c = (msg as { content?: unknown }).content;
	if (typeof c === "string") {
		return c.length;
	}
	try {
		return JSON.stringify(c ?? "").length;
	} catch {
		return 0;
	}
}

function approximateTotalChars(msgs: BaseMessage[]): number {
	let total = 0;
	for (const m of msgs) {
		total += approximateMessageChars(m);
	}
	return total;
}

// Find a cut index in `rest` that doesn't split an AI tool_call from its
// ToolMessage responses. OpenAI/Anthropic reject histories where a ToolMessage
// has no preceding AI tool_call, or an AI tool_call has no following
// ToolMessage. We start near the desired tail boundary and walk forward
// (toward the end) until both sides are self-consistent. Returns rest.length
// if no safe cut exists — in that case the caller should skip the gate.
function findSafeBudgetCut(rest: BaseMessage[], desired: number): number {
	for (let cut = Math.max(0, desired); cut < rest.length; cut++) {
		const first = rest[cut];
		const last = cut > 0 ? rest[cut - 1] : undefined;
		if (first instanceof ToolMessage) {
			continue;
		}
		if (
			last instanceof AIMessage &&
			Array.isArray(last.tool_calls) &&
			last.tool_calls.length > 0
		) {
			continue;
		}
		return cut;
	}
	return rest.length;
}

// Replaces the middle of `modelMessages` with a SystemMessage summary when
// the char budget is exceeded. The middle (not individual ToolMessages) is
// swapped so AI tool_calls stay paired with their ToolMessages.
//
// `force` runs the compression regardless of the char threshold. Used by the
// truncation-recovery retry (issue #2976): invisible-thinking spend scales
// with the accumulated input, so a turn that burned its whole output budget on
// reasoning needs a SMALLER prompt on the retry, not just a bigger budget —
// long before the 3.2M-char safety net would ever fire.
//
// `pinnedPrefixCount` keeps that many messages immediately after the leading
// system messages verbatim. The document being edited is injected as a
// HumanMessage/AIMessage pair right after the system prompt; summarizing it
// away would leave the model rewriting a document it can no longer see.
async function applyInputBudgetGate(
	modelMessages: BaseMessage[],
	config: RunnableConfig | undefined,
	options?: { force?: boolean; pinnedPrefixCount?: number },
): Promise<BaseMessage[]> {
	const charsBefore = approximateTotalChars(modelMessages);
	if (!options?.force && charsBefore <= BUDGET_TRIM_TRIGGER_CHARS) {
		return modelMessages;
	}

	let systemCount = 0;
	while (
		systemCount < modelMessages.length &&
		modelMessages[systemCount] instanceof SystemMessage
	) {
		systemCount++;
	}
	const leading = modelMessages.slice(0, systemCount);
	// The rebuilt array below carries EXACTLY ONE SystemMessage, at index 0:
	// the leading system content and the summary are merged into it, and the
	// pinned messages follow it. `@langchain/anthropic` (1.3.17) strips only
	// the FIRST message when it is a system message and throws
	// "System messages are only permitted as the first passed message" on any
	// later one — so appending the summary as its own SystemMessage would break
	// every direct-Anthropic request that reaches this gate. The merged form is
	// valid on the OpenAI-compatible gateway paths too, so it is unconditional.
	const pinnedCount = Math.min(
		modelMessages.length - systemCount,
		Math.max(0, options?.pinnedPrefixCount ?? 0),
	);
	const pinned = modelMessages.slice(systemCount, systemCount + pinnedCount);
	const rest = modelMessages.slice(systemCount + pinnedCount);

	if (rest.length <= BUDGET_KEEP_TAIL_MESSAGES) {
		logger.warn(
			"[Project Document Generator] Budget gate skipped — tail already short",
			{ charsBefore, tailLength: rest.length },
		);
		return modelMessages;
	}

	const desiredCut = rest.length - BUDGET_KEEP_TAIL_MESSAGES;
	const safeCut = findSafeBudgetCut(rest, desiredCut);
	if (safeCut >= rest.length) {
		logger.warn(
			"[Project Document Generator] Budget gate skipped — no safe cut preserving tool-call pairs",
			{ charsBefore, restLength: rest.length, desiredCut },
		);
		return modelMessages;
	}

	const toSummarize = rest.slice(0, safeCut);
	const keepTail = rest.slice(safeCut);

	const transcriptLines: string[] = [];
	for (const m of toSummarize) {
		const type = getMessageType(m);
		const content = (m as { content?: unknown }).content;
		const asText =
			typeof content === "string"
				? content
				: (() => {
						try {
							return JSON.stringify(content);
						} catch {
							return "";
						}
					})();
		// Prevent a single huge tool response from dominating the summarizer input.
		transcriptLines.push(`[${type}] ${asText.slice(0, 4_000)}`);
	}
	const transcript = transcriptLines.join("\n---\n");

	const gateStart = Date.now();
	let summaryText: string;
	try {
		const summaryModel = await getAgentModelAsync(config, {
			taskType: "SIMPLE",
			maxTokens: 1024,
		});
		const summaryResp = await summaryModel.invoke([
			new SystemMessage(
				"You are compressing the earlier turns of an AI coding agent's conversation so the next turn fits in context. Preserve concrete facts, decisions, messageIds, chatIds, feature ids, and any user requirements. Drop pleasantries and repeated framing. Output a single plain-text summary, no preamble, <= 2000 characters.",
			),
			new HumanMessage(transcript),
		]);
		await logAgentUsageFromRunnableConfig(config, summaryResp, {
			taskType: "SIMPLE",
			agentId: "project_document_generator:budget_gate",
			latencyMs: Date.now() - gateStart,
		});
		const raw =
			typeof summaryResp.content === "string"
				? summaryResp.content
				: (() => {
						try {
							return JSON.stringify(summaryResp.content);
						} catch {
							return "";
						}
					})();
		summaryText = raw.slice(0, BUDGET_SUMMARY_MAX_CHARS);
	} catch (error) {
		logger.warn(
			"[Project Document Generator] Budget gate summarizer failed; dropping old messages with a placeholder",
			{
				error: error instanceof Error ? error.message : String(error),
			},
		);
		summaryText = `[${toSummarize.length} earlier messages elided to fit the model context window. Re-run the relevant tool (e.g. search_teams_messages) if a specific messageId or earlier decision is needed.]`;
	}

	// One merged system message — see the note above `pinnedCount`. Non-string
	// content (a system prompt assembled as content parts) is flattened through
	// the shared text extractor rather than JSON-stringified, so cache-control
	// wrappers and the like don't leak into the prompt as literal JSON.
	const mergedSystemText = [
		...leading.map((m) => extractTextFromContent(m.content)),
		`## Earlier context (summarized to conserve tokens)\n${summaryText}`,
	]
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n\n");

	const rebuilt: BaseMessage[] = [
		new SystemMessage({ content: mergedSystemText }),
		...pinned,
		...keepTail,
	];
	const charsAfter = approximateTotalChars(rebuilt);

	logger.warn("[Project Document Generator] Budget gate triggered", {
		charsBefore,
		charsAfter,
		messagesBefore: modelMessages.length,
		messagesAfter: rebuilt.length,
		pairsEvicted: toSummarize.length,
		pinnedPrefixCount: pinnedCount,
		forced: options?.force === true,
		summaryLatencyMs: Date.now() - gateStart,
	});

	return rebuilt;
}

/**
 * Get message type - handles multiple formats:
 * - LangChain classes: _getType() returns 'human', 'ai', 'tool', etc.
 * - AG-UI format: 'type' property with 'human', 'ai', 'tool'
 * - OpenAI format: 'role' property with 'user', 'assistant', 'tool'
 */
function getMessageType(msg: any): string {
	if (msg._getType) {
		return msg._getType();
	}
	if (msg.type && typeof msg.type === "string") {
		if (msg.type === "human") {
			return "human";
		}
		if (msg.type === "ai") {
			return "ai";
		}
		if (msg.type === "tool") {
			return "tool";
		}
		return msg.type;
	}
	if (msg.role) {
		if (msg.role === "user") {
			return "human";
		}
		if (msg.role === "assistant") {
			return "ai";
		}
		if (msg.role === "tool") {
			return "tool";
		}
		return msg.role;
	}
	return "unknown";
}

// Hoisted regexes used by stripToolDefinitions' strikethrough pass. Defined at
// module scope so they aren't re-parsed on every invocation.
const BASELINE_STRIKE_SCAN = /~~[^~]+?~~/g;
const STRIKE_REPLACE = /~~([^~]+?)~~(\s*)/g;

// Matches the `<fabric_source_document>` wrapper tag (and its `_*`-suffixed
// neutralization variants used to defuse literal occurrences inside the
// wrapped body — see SOURCE_DOC_TAG site below). Hoisted so chat-node entry
// and stripToolDefinitions share the same definition without re-parsing.
const FABRIC_SOURCE_DOC_TAG_RE = /<\/?fabric_source_document_*>/gi;

// Plain assistant reply used whenever an edit turns out to be a no-op: the
// produced document is normalized-identical to the baseline (no-op suppression),
// or the model called `confirm_changes` itself without ever writing a document
// (bare-confirm interception). In both cases there is nothing to confirm, so we
// tell the user plainly instead of surfacing a confirm affordance that would
// "apply" nothing.
const NO_DOCUMENT_CHANGES_NOTICE =
	"I reviewed the document but found no changes to make — it already reflects the requested update.";

/**
 * Strip tool definitions and system instructions that may have leaked into document content.
 *
 * CopilotKit's internal tool format and system prompt instructions sometimes get echoed by the model.
 * This function removes common patterns like:
 * - "Tools\n\nTools are grouped by namespace..."
 * - "Namespace: functions"
 * - "Target channel: commentary"
 * - TypeScript type definitions for tools
 * - "DOCUMENT PURITY" instructions that got echoed
 *
 * @param document  The document content returned by the model.
 * @param baseline  The document as it existed before this edit (optional). Used
 *                  to distinguish user-authored strikethrough from model
 *                  "deletion marker" strikethrough. When provided, `~~text~~`
 *                  runs already present in the baseline are preserved, and
 *                  only strikethrough newly introduced by the model is stripped.
 *                  Pass `undefined` for first-generation documents.
 */
export function stripToolDefinitions(
	document: string,
	baseline?: string,
): string {
	// Pattern 1: Remove "DOCUMENT PURITY" instruction block and everything after
	// This catches the echoed system prompt instruction
	const documentPurityPattern = /\n*🚫+\s*DOCUMENT PURITY[\s\S]*$/i;
	let cleaned = document.replace(documentPurityPattern, "");

	// Pattern 2: Remove "Tools" section and everything after it if it contains tool definitions
	// This catches: "Tools\n\nTools are grouped by namespace..."
	const toolsSectionPattern =
		/\n*#*\s*Tools\s*\n+Tools are grouped by namespace[\s\S]*$/i;
	cleaned = cleaned.replace(toolsSectionPattern, "");

	// Pattern 3: Remove "Namespace: functions" blocks and everything after
	const namespacePattern = /\n*Namespace:\s*functions[\s\S]*$/gi;
	cleaned = cleaned.replace(namespacePattern, "");

	// Pattern 4: Remove "Target channel: commentary" and everything after
	const targetChannelPattern = /\n*Target channel:\s*commentary[\s\S]*$/gi;
	cleaned = cleaned.replace(targetChannelPattern, "");

	// Pattern 5: Remove "Tool definitions" sections and everything after
	const toolDefinitionsPattern = /\n*Tool definitions[\s\S]*$/gi;
	cleaned = cleaned.replace(toolDefinitionsPattern, "");

	// Pattern 6: Remove TypeScript type definitions for tools
	// Matches: type write_document_local = (_: { ... }) => any;
	const typeDefPattern =
		/\n*type\s+\w+_\w+\s*=\s*\([^)]*\)\s*=>\s*\w+;?\s*/gi;
	cleaned = cleaned.replace(typeDefPattern, "");

	// Pattern 7: Remove any remaining "// Write a document..." style comments at the end
	const trailingCommentPattern = /\n*\/\/\s*Write a document[\s\S]*$/i;
	cleaned = cleaned.replace(trailingCommentPattern, "");

	// Pattern 8: Remove partial "NEVER INCLUDE" instruction blocks
	const neverIncludePattern = /\n*❌\s*NEVER INCLUDE[\s\S]*$/i;
	cleaned = cleaned.replace(neverIncludePattern, "");

	// Pattern 9: Remove "YOUR DOCUMENT OUTPUT MUST END" instructions
	const yourDocumentPattern = /\n*YOUR DOCUMENT OUTPUT MUST END[\s\S]*$/i;
	cleaned = cleaned.replace(yourDocumentPattern, "");

	// Pattern 9b: Remove "Document Content Purity" section if echoed
	const documentContentPurityPattern =
		/\n*##?\s*🚨?\s*CRITICAL:?\s*Document Content Purity[\s\S]*$/i;
	cleaned = cleaned.replace(documentContentPurityPattern, "");

	// Pattern 9c: Remove the `<fabric_source_document>` wrapper tag (and its
	// sanitized `<fabric_source_document_>` neutralization variant) if echoed.
	// Background: the chat node wraps the existing document body in a unique
	// `<fabric_source_document>` user message so the model can locate it. Some
	// models occasionally re-emit the wrapper (or its neutralized form, when
	// the input itself was poisoned by a prior leak) inside the new document
	// body. Once written, the tag becomes part of the saved document and every
	// subsequent edit re-poisons the output. Strip both forms unconditionally
	// — neither tag is ever legitimate document content.
	cleaned = cleaned.replace(FABRIC_SOURCE_DOC_TAG_RE, "");

	// Pattern 10: Remove removal markers that LLMs leave behind
	// These are inline markers, not trailing blocks, so we don't use [\s\S]*$

	// Remove "[removed]", "[deleted]", "(removed)", "(deleted)" placeholders
	cleaned = cleaned.replace(/\s*\[(removed|deleted)\]\s*/gi, " ");
	cleaned = cleaned.replace(/\s*\((removed|deleted)\)\s*/gi, " ");

	// Remove "// removed" or "<!-- removed -->" comments
	cleaned = cleaned.replace(/\s*\/\/\s*(removed|deleted).*$/gim, "");
	cleaned = cleaned.replace(/\s*<!--\s*(removed|deleted).*?-->\s*/gi, "");

	// Strip `~~text~~` runs the model uses as deletion markers, but preserve
	// real user-authored strikethrough: any run already present in the baseline
	// survives. stripDiffTags only handles `<ins>`/`<del>`, so unbaseline-checked
	// `~~...~~` would otherwise get baked into the saved document.
	if (cleaned.includes("~~")) {
		const baselineStrikes = new Set<string>();
		if (baseline?.includes("~~")) {
			for (const match of baseline.matchAll(BASELINE_STRIKE_SCAN)) {
				baselineStrikes.add(match[0]);
			}
		}
		cleaned = cleaned.replace(STRIKE_REPLACE, (match, _body, trailing) => {
			const run = match.slice(0, match.length - trailing.length);
			return baselineStrikes.has(run) ? match : "";
		});
	}

	// Remove "Note: X has been removed" or "X was removed" patterns at end of lines
	cleaned = cleaned.replace(
		/\s*\(?Note:.*(?:removed|deleted).*\)?\s*$/gim,
		"",
	);

	// Remove empty list items that result from removals (- \n or * \n)
	cleaned = cleaned.replace(/^[-*]\s*\n/gm, "");

	// Remove lines that are just "removed" or "deleted"
	cleaned = cleaned.replace(/^\s*(removed|deleted)\s*$/gim, "");

	// Trim trailing whitespace, dashes, and extra newlines.
	// Not when the content ends on a table row: GFM lets the outer pipes be
	// dropped, so a separator row can legitimately end in `---`, and eating
	// that tail leaves the separator a column short of the header — the table
	// then stops parsing and renders as literal pipe text.
	const lastContentLine = cleaned
		.split("\n")
		.reverse()
		.find((candidate) => candidate.trim().length > 0);
	if (!(lastContentLine && /^\s*\|/.test(lastContentLine))) {
		cleaned = cleaned.replace(/[\s\-—]+$/, "");
	}
	cleaned = cleaned.trim();
	cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

	// Log if we stripped anything
	if (cleaned.length < document.length) {
		logger.info(
			"[Project Document Generator] Stripped tool definitions from document",
			{
				originalLength: document.length,
				cleanedLength: cleaned.length,
				strippedChars: document.length - cleaned.length,
			},
		);
	}

	return cleaned;
}

/**
 * Check if we should handle post-confirmation (user just clicked Accept/Reject).
 *
 * SIMPLE RULE: Post-confirmation is ONLY when the LAST message is a tool response
 * to confirm_changes. Any other last message (human, ai, etc.) means process normally.
 *
 * Message pattern after confirmation:
 * [..., AIMessage(confirm_changes tool_call), ToolMessage(accepted: true/false)]
 */
function isAfterConfirmation(messages: BaseMessage[]): {
	isAfter: boolean;
	accepted: boolean;
} {
	if (!messages || messages.length < 2) {
		return { isAfter: false, accepted: false };
	}

	const lastMsg = messages[messages.length - 1];
	const secondLastMsg = messages[messages.length - 2];

	// Check if last message is a tool response
	if (getMessageType(lastMsg) !== "tool") {
		return { isAfter: false, accepted: false };
	}

	// Check if the tool response contains "accepted" (from confirm_changes)
	const content = typeof lastMsg.content === "string" ? lastMsg.content : "";
	if (!content.includes("accepted")) {
		return { isAfter: false, accepted: false };
	}

	// Check if second-to-last is an AI message with confirm_changes tool call
	if (getMessageType(secondLastMsg) !== "ai") {
		return { isAfter: false, accepted: false };
	}

	const toolCalls =
		(secondLastMsg as any).tool_calls || (secondLastMsg as any).toolCalls;
	if (!toolCalls || toolCalls.length === 0) {
		return { isAfter: false, accepted: false };
	}

	const hasConfirmChanges = toolCalls.some((tc: any) => {
		const name = tc.name || tc.function?.name;
		return name === "confirm_changes";
	});

	if (!hasConfirmChanges) {
		return { isAfter: false, accepted: false };
	}

	// Parse the acceptance status
	const accepted =
		content.includes('"accepted":true') ||
		content.includes('"accepted": true');

	logger.info(
		"[Project Document Generator] Post-confirmation state detected",
		{ accepted },
	);
	return { isAfter: true, accepted };
}

/**
 * Build a Command to END that:
 * 1. Runs non-blocking document validation (logs warnings).
 * 2. Emits a tool response for the original tool call (write or patches).
 * 3. Builds the model-generated or programmatic follow-up message.
 * 4. Appends a synthetic `confirm_changes` tool call so the frontend shows
 *    the accept/reject modal.
 * 5. Updates state.document with the final content and clears error state.
 *
 * This is shared between the `write_document_local` and `apply_document_patches`
 * handlers. Both end up in the same "here's the updated doc, please confirm"
 * state; the only difference upstream is how the document text was produced.
 */
function buildConfirmChangesCommand(params: {
	state: AgentState;
	messages: BaseMessage[];
	toolCall: { id?: string; args?: Record<string, any> };
	document: string;
	baselineDocument: string;
	response: { content?: string | unknown };
	focusAnchor?: string | null;
	logMode: "write" | "patch";
	extraStateUpdate?: Record<string, unknown>;
	/**
	 * Partial-completion warning appended to the confirm follow-up message when
	 * the section-preservation guard accepted after exhausting its retries.
	 */
	sectionWarning?: string;
	/**
	 * Overrides the fixed "Patches applied." ToolMessage content, so the
	 * model sees occurrence counts (and residual-occurrence warnings) from
	 * multi-occurrence replace_text patches on its next turn.
	 */
	toolResponseContent?: string;
	/**
	 * User-visible note appended to the confirm follow-up message (e.g.
	 * "Replaced 7 occurrences in total.").
	 */
	followUpNote?: string;
}): Command {
	const {
		state,
		messages,
		toolCall,
		document,
		baselineDocument,
		response,
		focusAnchor,
		logMode,
		extraStateUpdate,
		sectionWarning,
		toolResponseContent: toolResponseContentOverride,
		followUpNote,
	} = params;
	const documentType = state.documentType || "general";

	// No-op suppression: when the produced document is normalized-identical to
	// the baseline (same predicate the save layer uses to decide "no real
	// change"), a confirm affordance would let the user "accept" a change that
	// saves nothing. Emit a plain assistant reply instead of the synthetic
	// `confirm_changes` tool call, and leave document/streamingContent/focusAnchor
	// untouched so the editor stays on the baseline.
	if (
		normalizeForComparison(document) ===
		normalizeForComparison(baselineDocument)
	) {
		const inlineToolName =
			logMode === "write"
				? "write_document_local"
				: "apply_document_patches";
		const noOpToolResponse = {
			role: "tool" as const,
			content:
				logMode === "patch" ? "Patches applied." : "Document written.",
			tool_call_id: toolCall.id,
		};
		const modelCommentary = extractTextFromContent(response.content).trim();
		const replyText =
			modelCommentary.length > 0
				? modelCommentary
				: NO_DOCUMENT_CHANGES_NOTICE;

		logger.info(
			"[Project Document Generator] Suppressing confirm for no-op document",
			{
				normalizedDocLength: normalizeForComparison(document).length,
				normalizedBaselineLength:
					normalizeForComparison(baselineDocument).length,
				usedModelCommentary: modelCommentary.length > 0,
				mode: logMode,
			},
		);

		// The inline tool ran and produced a document (it just matched the
		// baseline), so record its trace entry as completed rather than leaving
		// a stranded "awaiting confirmation" pending row — no confirm card will
		// resolve it later. Preserve any other resolved entries for this turn.
		let noOpToolTraceUpdate: Record<string, unknown> = {};
		const turnIndex = countHumanMessages(messages);
		if (turnIndex >= 1 && toolCall.id) {
			const existingForTurn = state.toolCallsByTurn?.[turnIndex] ?? [];
			const preserved = existingForTurn.filter(
				(entry) => entry.id !== toolCall.id,
			);
			noOpToolTraceUpdate = {
				toolCallsByTurn: {
					[turnIndex]: [
						...preserved,
						{
							id: toolCall.id,
							name: inlineToolName,
							status: "success" as const,
							startedAt: Date.now(),
						},
					],
				},
			};
		}

		return new Command({
			goto: END,
			update: {
				messages: [
					...messages,
					noOpToolResponse,
					new AIMessage({ content: replyText }),
				],
				error: undefined,
				retryCount: 0,
				...extraStateUpdate,
				...noOpToolTraceUpdate,
			},
		});
	}

	// Pre-stream validation (non-blocking). Skip required-section enforcement
	// when a custom system prompt is in use, since custom prompts can
	// intentionally produce documents with non-default structures.
	try {
		const hasCustomPrompt = !!state.systemPrompt?.trim();
		const requiredSections = hasCustomPrompt
			? undefined
			: getDocumentSections(documentType)
					.filter((s) => s.required)
					.map((s) => s.name);

		const validation = validateDocument(
			document,
			documentType,
			requiredSections && requiredSections.length > 0
				? requiredSections
				: undefined,
			state.ragContexts || [],
			baselineDocument,
		);

		if (!validation.isValid && validation.errors.length > 0) {
			logger.warn(
				"[Project Document Generator] Document validation failed",
				{
					errors: validation.errors,
					score: validation.score,
					summary: validation.summary,
					mode: logMode,
				},
			);
		} else {
			logger.info(
				"[Project Document Generator] Document validation passed",
				{
					score: validation.score,
					warnings: validation.warnings.length,
					summary: validation.summary,
					mode: logMode,
				},
			);
		}

		if (validation.warnings.length > 0) {
			logger.warn(
				"[Project Document Generator] Document validation warnings",
				{ warnings: validation.warnings, mode: logMode },
			);
		}
	} catch (validationError) {
		logger.warn(
			"[Project Document Generator] Validation error (non-fatal):",
			validationError,
		);
	}

	// Tool response for the original tool call.
	const toolResponseContent =
		toolResponseContentOverride ??
		(logMode === "patch" ? "Patches applied." : "Document written.");
	const toolResponse = {
		role: "tool" as const,
		content: toolResponseContent,
		tool_call_id: toolCall.id,
	};

	// Use the model's response content if available (LLM-generated contextual
	// follow-up). Only fall back to programmatic generation if empty.
	// Use extractTextFromContent so multi-block reasoning responses (Anthropic
	// thinking + text array) are flattened to plain text without mutating the
	// original response — the multi-block array MUST stay intact in state.messages
	// so its thinking-block signature can be replayed to Anthropic on follow-up
	// turns (e.g. after an external tool call).
	const modelContent = extractTextFromContent(response.content).trim();

	let followUpMessage: string;
	if (modelContent.length > 0) {
		followUpMessage = modelContent;
		logger.info(
			"[Project Document Generator] Using model-generated follow-up",
			{
				contentLength: modelContent.length,
				preview: modelContent.substring(0, 100),
				mode: logMode,
			},
		);
	} else {
		// Model returned a tool call with no commentary. A programmatic
		// follow-up generator can surface questions unrelated to the user's
		// actual intent (e.g. proposing to expand a section after a delete),
		// so emit a neutral status instead.
		followUpMessage = "Changes ready for review.";
		logger.info(
			"[Project Document Generator] Using neutral fallback (model returned empty)",
			{ mode: logMode },
		);
	}

	// AC2: append the partial-completion warning so the user sees, on the confirm
	// card, which section(s) the AI couldn't fully update after its retries.
	if (sectionWarning) {
		followUpMessage = `${followUpMessage}\n\n${sectionWarning}`;
	}

	// Multi-occurrence replacement count — makes complete-vs-partial
	// application visible on the confirm card without a manual document
	// search.
	if (followUpNote) {
		followUpMessage = `${followUpMessage}\n\n${followUpNote}`;
	}

	// Synthetic confirm_changes tool call (ag-ui-demo pattern). The frontend
	// intercepts this and renders an accept/reject modal.
	//
	// The `args.__inlineTool` field carries the ORIGINAL inline tool's
	// id + name forward so the post-confirmation branch (top of chatNode)
	// can flip the matching pending entry in `toolCallsByTurn` to success
	// or error. Without this, state.messages at re-entry contains only
	// the synthetic confirm_changes call (LangGraph's message reducer
	// drops the streamed model AIMessage's tool_calls once
	// buildConfirmChangesCommand emits its own), so there is no other
	// source from which to recover (id, name).
	//
	// Why args, not additional_kwargs: empirical diagnostics show
	// CopilotKit's wire-format normalization strips additional_kwargs
	// entirely between runs (every message re-enters with akKeys: []),
	// even when the message is constructed as an AIMessage class
	// instance. tool_call args, by contrast, are part of the standard
	// AG-UI protocol and round-trip faithfully because the frontend
	// uses them to render the confirm modal. The `__inlineTool` field
	// is namespaced with a double-underscore prefix so the frontend
	// confirm-changes renderer can safely ignore it.
	const inlineName =
		logMode === "write" ? "write_document_local" : "apply_document_patches";
	const confirmToolCall = new AIMessage({
		content: followUpMessage,
		tool_calls: [
			{
				id: uuidv4(),
				name: "confirm_changes",
				args: {
					__inlineTool: { id: toolCall.id, name: inlineName },
				},
				type: "tool_call" as const,
			},
		],
	});

	return new Command({
		goto: END,
		update: {
			messages: [...messages, toolResponse, confirmToolCall],
			document,
			streamingContent: document,
			focusAnchor: focusAnchor ?? undefined,
			error: undefined,
			retryCount: 0,
			...extraStateUpdate,
		},
	});
}

/**
 * Shared retry loop for tool calls that arrived with missing or invalid
 * arguments. Emits a corrective ToolMessage and re-enters the chat node
 * up to MAX_RETRIES, then surfaces a user-facing error and ends the run.
 * Used by both the `write_document_local` and `apply_document_patches`
 * handlers, whose failure shapes are structurally identical.
 *
 * When `truncated` is true, the retry branch is skipped entirely — a
 * corrective ToolMessage cannot fix a generation that was cut off by the
 * model's output-token limit, so retrying just burns MAX_RETRIES identical,
 * guaranteed-to-fail generations. `truncatedMessage` (falling back to
 * `exhaustedMessage`) is surfaced immediately instead.
 */
function buildInvalidToolArgsRetry(params: {
	state: AgentState;
	messages: BaseMessage[];
	toolCall: { id?: string };
	correctionContent: string;
	exhaustedMessage: string;
	truncated?: boolean;
	truncatedMessage?: string;
}): Command {
	const {
		state,
		messages,
		toolCall,
		correctionContent,
		exhaustedMessage,
		truncated,
		truncatedMessage,
	} = params;

	if (truncated) {
		const message = truncatedMessage ?? exhaustedMessage;
		logger.error(
			"[Project Document Generator] Skipping retry — model response was truncated at its output-token limit",
			{ retryCount: state.retryCount },
		);
		return new Command({
			goto: END,
			update: {
				messages: [
					...state.messages,
					{ role: "assistant" as const, content: message },
				],
				error: message,
				retryCount: 0,
			},
		});
	}

	if (state.retryCount < MAX_RETRIES) {
		const correctionMessage = new ToolMessage({
			content: correctionContent,
			tool_call_id: toolCall.id || uuidv4(),
		});

		logger.info(
			"[Project Document Generator] Retrying with corrective tool message",
			{ retryCount: state.retryCount + 1 },
		);

		return new Command({
			goto: "chat_node" as typeof END,
			update: {
				messages: [...messages, correctionMessage],
				retryCount: state.retryCount + 1,
			},
		});
	}

	logger.error(
		"[Project Document Generator] Max retries reached for invalid tool args",
		{ retryCount: state.retryCount },
	);
	return new Command({
		goto: END,
		update: {
			messages: [
				...state.messages,
				{ role: "assistant" as const, content: exhaustedMessage },
			],
			error: exhaustedMessage,
			retryCount: 0,
		},
	});
}

/**
 * Outcome of the section-preservation guard: either retry with the model, or
 * proceed to the confirm card — optionally carrying a partial-completion
 * `warning` when the retry budget was spent and sections are still dropped.
 */
type SectionGuardOutcome =
	| { action: "retry"; command: Command }
	| { action: "proceed"; warning?: string };

/**
 * Section-preservation guard. Rejects a proposed edit that dropped or gutted a
 * whole section the user did not ask to remove (e.g. an AI rewrite that
 * collapses a populated `## Acceptance Criteria` section to a one-line stub),
 * and retries with a corrective message that names the sections. The existing
 * whole-document guards miss this — markdown validation only checks
 * well-formedness and the patch content-loss guard only fires below 20% of the
 * WHOLE document.
 *
 * Returns `{ action: "retry" }` when a section was dropped and the retry budget
 * remains; `{ action: "proceed" }` otherwise (nothing dropped, guard not
 * applicable, or the retry budget is spent). When the budget is spent but a
 * section is still dropped, `proceed` carries a `warning` so the confirm card
 * can flag the partial completion rather than hard-blocking a genuinely-intended
 * removal.
 *
 * Shared by the `write_document_local` and `apply_document_patches` handlers.
 */
function evaluateSectionPreservation(params: {
	state: AgentState;
	messages: BaseMessage[];
	toolCall: { id?: string };
	baselineDocument: string;
	document: string;
	mode: "write" | "patch";
}): SectionGuardOutcome {
	const { state, messages, toolCall, baselineDocument, document, mode } =
		params;

	// Skip when there's nothing to preserve or a full rewrite is intended:
	// custom prompts intentionally produce non-default structures, regeneration
	// is an explicit full rewrite, and a first-generation document has no
	// baseline sections to protect.
	if (
		state.systemPrompt?.trim() ||
		state.isRegeneration ||
		baselineDocument.trim().length === 0
	) {
		return { action: "proceed" };
	}

	const dropped = detectDroppedSections(baselineDocument, document);
	if (dropped.length === 0) {
		return { action: "proceed" };
	}

	logger.warn(
		"[Project Document Generator] Section-preservation guard flagged dropped/gutted sections",
		{
			mode,
			retryCount: state.retryCount,
			sections: dropped.map((d) => ({
				heading: d.heading,
				reason: d.reason,
				baselineChars: d.baselineChars,
				resultChars: d.resultChars,
			})),
		},
	);

	if (state.retryCount >= MAX_RETRIES) {
		logger.warn(
			"[Project Document Generator] Section-preservation retries exhausted; accepting model output with a partial-completion warning",
			{ mode, retryCount: state.retryCount },
		);
		// AC2: the retry budget is spent but the document still drops a section.
		// Accept the model's output (never hard-block) but surface an explicit
		// partial-completion warning on the confirm card naming the section(s).
		const names = dropped.map((d) => `"${d.heading}"`).join(", ");
		const one = dropped.length === 1;
		return {
			action: "proceed",
			warning:
				`⚠️ Heads up: after several attempts the AI still didn't fully update ${one ? "this section" : "these sections"}: ${names}. ` +
				`Please review ${one ? "it" : "them"} before accepting — ${one ? "it" : "they"} may be incomplete or inconsistent with your other changes.`,
		};
	}

	const list = dropped
		.map((d) =>
			d.reason === "removed"
				? `- "${d.heading}" — the whole section is missing (it had ${d.baselineChars} characters of content).`
				: `- "${d.heading}" — its body collapsed from ${d.baselineChars} to ${d.resultChars} characters.`,
		)
		.join("\n");

	const correctionMessage = new ToolMessage({
		content:
			`Your edit dropped or gutted section(s) the user did not ask to remove:\n${list}\n\n` +
			"Re-emit the document preserving each of these sections' existing content verbatim, and make ONLY the change the user requested elsewhere. " +
			"If the user explicitly asked to delete or drastically shorten one of these sections, keep your version for it — otherwise restore it in full. " +
			"Prefer apply_document_patches so untouched sections are preserved automatically.",
		tool_call_id: toolCall.id || uuidv4(),
	});

	// Reset the working document to the baseline for the retry so the next
	// comparison — and the model's "current document" context — reflect the
	// unedited source, not a partially-streamed bad write (predict_state streams
	// write_document_local args into state.document during generation).
	return {
		action: "retry",
		command: new Command({
			goto: "chat_node" as typeof END,
			update: {
				messages: [...messages, correctionMessage],
				retryCount: state.retryCount + 1,
				document: baselineDocument,
				streamingContent: baselineDocument,
			},
		}),
	};
}

/**
 * Sanitize messages for the model API call.
 *
 * CopilotKit often sends back malformed message history:
 * - AI messages split into content-only and tool_calls-only messages
 * - Missing tool responses (e.g., write_document_local response dropped)
 * - Tool calls stripped from some AI messages
 *
 * When these malformed messages go through ChatOpenAI → Vercel Gateway → Anthropic,
 * the format conversion fails with: "toolUse.input is invalid"
 *
 * Fix: Strip tool_calls and tool messages from conversation history.
 * The model gets the current document via the system prompt, so it doesn't
 * need to see the exact tool call history.
 */
/**
 * Check if a tool message should be preserved in conversation history.
 * Preserves messages from graph tool execution (search_teams_messages)
 * and CopilotKit frontend actions (select_meetings, fetchMeetingNotes, etc.).
 */
function isRecognizedToolMessage(
	msg: any,
	recognizedToolNames: Set<string>,
): boolean {
	if (getMessageType(msg) !== "tool") {
		return false;
	}
	const name = msg.name || "";
	// Preserve tool messages with recognized names or with valid tool_call_id
	// (CopilotKit tool responses have tool_call_id matching the AI tool call)
	if (recognizedToolNames.has(name)) {
		return true;
	}
	// Also preserve if it has a tool_call_id (proper tool response, even if name
	// differs). Uses the shared reader so a camelCase-only result isn't dropped
	// here — before the bijection and orphan-conversion passes ever see it —
	// which would silently lose the result's content.
	return getToolResultId(msg) !== undefined;
}

/**
 * Check if an AI message has tool_calls for recognized tools.
 * Includes graph-internal tools and CopilotKit frontend actions.
 * These should be preserved so the model sees the full tool call → result chain.
 */
function hasRecognizedToolCalls(
	msg: any,
	recognizedToolNames: Set<string>,
): boolean {
	const toolCalls = msg.tool_calls || msg.toolCalls;
	if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
		return false;
	}
	return toolCalls.some((tc: any) =>
		recognizedToolNames.has(tc.name || tc.function?.name || ""),
	);
}

/**
 * User-facing fallback message emitted when the configured TOOL_CALLING model
 * rejects the multimodal `image_url` payload (e.g., a text-only model on a
 * tenant that hasn't upgraded its model selection). Surfaced through the
 * chat-node error path when `isVisionUnsupportedError(err) === true`.
 *
 * The exact wording is contractual — exported so the regression test can lock
 * the copy without a full chat-node graph integration.
 */
export const VISION_UNSUPPORTED_USER_MESSAGE =
	"The current AI model doesn't support image input. Remove the attached images, or ask an admin to configure a vision-capable model (e.g., Claude Sonnet or GPT-4o) for tool-calling before retrying.";

/**
 * User-facing message for a turn that returned nothing because the model hit
 * its output-token limit before emitting a single visible token, twice in a
 * row — once on the original budget and once on the escalated retry (issue
 * #2976). Exported so the regression test can lock the copy.
 *
 * Says what happened, that nothing was changed, and what to do differently.
 * The user's next attempt is otherwise identical and fails identically.
 */
export const TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE =
	"The AI model ran out of output budget before it could write anything — it spent the whole response on internal reasoning, and a retry with a larger budget hit the same limit. Your document has not been changed. Try a narrower request (one section at a time works well), start a fresh conversation so there's less history to reason over, or ask an admin to configure a model with a larger output limit.";

/**
 * User-facing message for a turn that spent its whole research budget and then
 * kept trying to research instead of writing, right through the finalize
 * guard's retries and its terminal fallback (issue #2999). The only thing that
 * response contained was the rejected call; removing it leaves nothing, so
 * there is no answer to return.
 *
 * Without this the run would end on the ordinary "no tool call" branch with
 * `error: undefined` — reported as a success while the document was never
 * touched. Says what happened, that nothing changed, and what to do next.
 * Exported so the regression test can lock the copy.
 */
export const FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE =
	"The AI model used up the research budget for this request and kept asking for more information instead of writing the document, so nothing was produced. Your document has not been changed. Try a narrower request (one section at a time works well), or start a fresh conversation so the model has less to search through before it writes.";

/**
 * The upload pipeline encodes uploaded images as
 * `[Uploaded Image: name]\n![name](data:image/...;base64,…)` entries inside
 * `state.ragContexts` so the markdown survives the readable + state channels.
 * That string-shaped envelope is fine for text-only models, but a
 * vision-capable model needs the data URL surfaced as an `image_url` content
 * part on a `HumanMessage` — otherwise the model sees raw base64 in the
 * system prompt and answers "I can't read the image".
 *
 * `splitRagContextImages` peels every `data:image/...` data URL out of each
 * rag-context entry and returns:
 *   - `textOnlyContexts`: the same entries with the data-URL portion of
 *     each image stripped, leaving the human-readable label so the prompt
 *     builder can still reference the file by name.
 *   - `images`: `{ filename, dataUrl }[]` ready to attach as `image_url` parts.
 *
 * Exported for tests; mirrors the same helper in `document_generator/chat-node.ts`.
 */
const IMAGE_DATA_URL_RE =
	/!\[([^\]]*)\]\((data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+)\)/g;

export function splitRagContextImages(
	ragContexts: readonly string[] | undefined,
): {
	textOnlyContexts: string[];
	images: Array<{ filename: string; dataUrl: string }>;
} {
	const images: Array<{ filename: string; dataUrl: string }> = [];
	const textOnlyContexts: string[] = [];
	if (!ragContexts || ragContexts.length === 0) {
		return { textOnlyContexts, images };
	}
	for (const ctx of ragContexts) {
		IMAGE_DATA_URL_RE.lastIndex = 0;
		// Replace the markdown image syntax with a non-markdown placeholder so
		// that if the model echoes this token into document output (via
		// write_document_local / apply_document_patches), it renders as plain
		// text in the persisted UserStory.description / acceptanceCriteria
		// instead of a broken-image link. Defense-in-depth alongside the
		// system-prompt instruction.
		const cleaned = ctx.replace(IMAGE_DATA_URL_RE, (_, name, dataUrl) => {
			images.push({ filename: name || "image", dataUrl });
			return `[attached image: ${name || "image"}]`;
		});
		textOnlyContexts.push(cleaned);
	}
	return { textOnlyContexts, images };
}

/** Exported for tests. */
/**
 * Convert an orphaned tool-result's content into plain user-message text so the
 * user's answer survives when its tool_use was stripped. CopilotKit / the
 * LangGraph reducer can drop the synthetic `ask_clarifying_question` tool_use
 * between runs, leaving the result orphaned — which Anthropic rejects ("tool_result
 * ... must have a corresponding tool_use block"). Recognizes the
 * `{ answered, answer }` payload the clarifying-question card resolves with.
 */
function orphanedToolResultToText(content: unknown): string {
	const text =
		typeof content === "string"
			? content
			: extractTextFromContent(content || "");
	const trimmed = text.trim();
	if (!trimmed) {
		return "";
	}
	try {
		const obj = JSON.parse(trimmed) as {
			answered?: boolean;
			answer?: unknown;
			dismissed?: boolean;
		};
		if (obj && typeof obj === "object") {
			if (obj.dismissed === true || obj.answered === false) {
				return "I dismissed the clarifying question — note it as an open question and proceed with a reasonable default.";
			}
			if (typeof obj.answer === "string" && obj.answer.trim()) {
				return `My answer to your clarifying question: ${obj.answer.trim()}`;
			}
		}
	} catch {
		// Not JSON — fall through to the raw text.
	}
	return trimmed;
}

/**
 * Read a tool_call's id. Messages reach this file in several shapes —
 * LangChain class instances, AG-UI `type`-tagged objects, and OpenAI
 * `role`-tagged wire objects round-tripped through CopilotKit — so the id can
 * arrive under any of these keys. Both orphan passes MUST use these two
 * readers; deriving ids independently is how they previously disagreed.
 */
function getToolUseId(toolCall: unknown): string | undefined {
	const tc = toolCall as {
		id?: unknown;
		toolCallId?: unknown;
		tool_call_id?: unknown;
		function?: { id?: unknown };
	};
	const id = tc?.id ?? tc?.toolCallId ?? tc?.tool_call_id ?? tc?.function?.id;
	return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

/** Read a tool result's originating tool_call id. See {@link getToolUseId}. */
function getToolResultId(message: unknown): string | undefined {
	const m = message as {
		tool_call_id?: unknown;
		toolCallId?: unknown;
		additional_kwargs?: { tool_call_id?: unknown; toolCallId?: unknown };
	};
	const id =
		m?.tool_call_id ??
		m?.toolCallId ??
		m?.additional_kwargs?.tool_call_id ??
		m?.additional_kwargs?.toolCallId;
	return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

export function sanitizeMessagesForModel(
	messages: BaseMessage[],
	recognizedToolNames: Set<string>,
	_providerConfig?: ProviderConfig,
): BaseMessage[] {
	const result: BaseMessage[] = [];

	for (const msg of messages) {
		const msgType = getMessageType(msg);

		// Remove system messages (we prepend our own)
		if (msgType === "system" || msg instanceof SystemMessage) {
			continue;
		}

		// Preserve tool messages from recognized tools (graph tools + CopilotKit actions)
		// Strip unknown tool messages which may be malformed CopilotKit artifacts
		if (msgType === "tool") {
			if (isRecognizedToolMessage(msg, recognizedToolNames)) {
				result.push(msg);
			}
			continue;
		}

		// For AI messages: preserve those with recognized tool calls, strip empty artifacts
		if (msgType === "ai") {
			// If this AI message has recognized tool calls, preserve it as-is
			if (hasRecognizedToolCalls(msg, recognizedToolNames)) {
				result.push(msg);
				continue;
			}

			const content =
				typeof msg.content === "string"
					? msg.content
					: extractTextFromContent(msg.content || "");

			// Skip empty AI messages (from CopilotKit splits)
			if (content.trim().length === 0) {
				continue;
			}

			// Merge with previous AI message if consecutive
			// (Anthropic requires strictly alternating user/assistant messages)
			const lastResult =
				result.length > 0 ? result[result.length - 1] : null;
			if (lastResult && getMessageType(lastResult) === "ai") {
				const lastContent =
					typeof lastResult.content === "string"
						? lastResult.content
						: "";
				result[result.length - 1] = new AIMessage({
					content: `${lastContent}\n\n${content}`,
				});
			} else {
				result.push(new AIMessage({ content }));
			}
			continue;
		}

		// Human message handling.
		//
		// We always preserve array-shaped multimodal content (text +
		// `image_url` parts) end-to-end. The tenant's configured model is
		// the source of truth — if it does not accept image content, the
		// LLM API will surface a clear error which propagates back to the
		// frontend as a toast. We never second-guess the model with a
		// hardcoded whitelist.
		const rawContent: MessageContent = msg.content;
		const contentIsArray = Array.isArray(rawContent);
		const preserveMultimodalArray = contentIsArray;

		if (preserveMultimodalArray) {
			// Merge consecutive human messages
			// (Anthropic requires strictly alternating user/assistant messages)
			const lastHumanResult =
				result.length > 0 ? result[result.length - 1] : null;
			if (
				lastHumanResult &&
				getMessageType(lastHumanResult) === "human"
			) {
				const lastContent: MessageContent = lastHumanResult.content;
				const lastAsArray = Array.isArray(lastContent)
					? lastContent
					: [{ type: "text" as const, text: lastContent }];
				result[result.length - 1] = new HumanMessage({
					content: [...lastAsArray, ...rawContent],
				});
			} else {
				result.push(msg);
			}
			continue;
		}

		// Merge consecutive human messages
		// (Anthropic requires strictly alternating user/assistant messages)
		const humanContent =
			typeof rawContent === "string"
				? rawContent
				: String(rawContent || "");
		const lastHumanResult =
			result.length > 0 ? result[result.length - 1] : null;
		if (lastHumanResult && getMessageType(lastHumanResult) === "human") {
			const lastContent =
				typeof lastHumanResult.content === "string"
					? lastHumanResult.content
					: "";
			result[result.length - 1] = new HumanMessage({
				content: `${lastContent}\n\n${humanContent}`,
			});
		} else {
			result.push(msg);
		}
	}

	// Post-process: remove AI messages with tool calls that have no following tool_result.
	// This happens when CopilotKit doesn't include tool results in the conversation history,
	// which causes Anthropic API to reject with "tool_use ids without tool_result blocks".
	//
	// Validation is by tool_call_id over the ADJACENT result batch, not by
	// position. One assistant turn routinely emits several parallel tool_calls,
	// and the provider requires a tool_result for every one of them, all
	// contiguous with the turn that requested them. Two weaker tests were tried
	// and both admit histories the provider rejects with an empty-body 400:
	//   - "is result[i+1] a tool message?" is satisfied by the first result
	//     alone, so a 2-call turn missing one result passes.
	//   - "does every id appear somewhere in history?" accepts
	//     AI(A,B) Tool(A) Human Tool(B), which is out of order.
	// Requiring a contiguous run whose ids exactly match the call ids (no
	// missing, duplicate, or empty ids) is the only check that matches what the
	// provider actually enforces.
	//
	// There is deliberately NO positional fallback for id-less tool_calls: a
	// mixed-id or id-less parallel turn cannot be proven valid, and stripping
	// its tool calls degrades gracefully (any surviving results are converted
	// to user text by the second pass, preserving their content).
	const pairedToolResults = new Set<BaseMessage>();

	const cleaned: BaseMessage[] = [];
	for (let i = 0; i < result.length; i++) {
		const msg = result[i];
		const msgType = getMessageType(msg);

		if (msgType === "ai") {
			const toolCalls = (msg as any).tool_calls || (msg as any).toolCalls;
			if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
				// The contiguous run of tool results immediately following.
				const adjacent: BaseMessage[] = [];
				for (
					let j = i + 1;
					j < result.length && getMessageType(result[j]) === "tool";
					j++
				) {
					adjacent.push(result[j]);
				}

				const callIds = toolCalls.map(getToolUseId);
				const resultIds = adjacent.map(getToolResultId);
				const callIdSet = new Set(callIds);
				const resultIdSet = new Set(resultIds);

				const hasMatchingResults =
					callIds.every((id): id is string => id !== undefined) &&
					callIdSet.size === toolCalls.length &&
					resultIds.every((id): id is string => id !== undefined) &&
					resultIdSet.size === adjacent.length &&
					adjacent.length === toolCalls.length &&
					callIds.every(
						(id) => id !== undefined && resultIdSet.has(id),
					);

				if (hasMatchingResults) {
					// Remember the exact result objects that satisfied this
					// turn, so the second pass keys off identity rather than
					// re-deriving ids with a different shape lookup (which
					// previously let the two passes disagree and convert a
					// paired result into a user message).
					for (const toolResult of adjacent) {
						pairedToolResults.add(toolResult);
					}
				} else {
					// Orphaned tool_use — keep text content only, drop tool calls
					const content =
						typeof msg.content === "string"
							? msg.content
							: extractTextFromContent(msg.content || "");
					if (content.trim().length > 0) {
						cleaned.push(new AIMessage({ content }));
					}
					continue;
				}
			}
		}

		cleaned.push(msg);
	}

	// Second pass: convert orphaned tool_results (a tool message whose tool_use was
	// dropped above, or stripped by the reducer / CopilotKit wire-format between
	// runs — as happens to the synthetic ask_clarifying_question tool_use) into a
	// plain user message. Otherwise Anthropic rejects the turn ("tool_result ...
	// must have a corresponding tool_use block"). Converting (not dropping)
	// preserves the user's answer so the model can continue with it.
	// Keyed on object identity via `pairedToolResults` (populated by the first
	// pass) rather than on a second, independently-derived id lookup. The two
	// passes previously read different id shapes — the first accepted
	// `toolCallId`, the second only `tool_call_id` — so a camelCase result
	// could satisfy an AI turn in pass one and then be converted to a user
	// message here, re-orphaning the tool call the first pass just preserved.
	const finalMessages: BaseMessage[] = [];
	for (const msg of cleaned) {
		if (getMessageType(msg) === "tool") {
			if (!pairedToolResults.has(msg)) {
				const humanText = orphanedToolResultToText(msg.content);
				if (humanText) {
					const last =
						finalMessages.length > 0
							? finalMessages[finalMessages.length - 1]
							: null;
					// Merge into a preceding human turn — Anthropic requires
					// strictly alternating user/assistant messages.
					if (last && getMessageType(last) === "human") {
						const lastContent = last.content;
						if (typeof lastContent === "string") {
							finalMessages[finalMessages.length - 1] =
								new HumanMessage({
									content: `${lastContent}\n\n${humanText}`,
								});
						} else if (Array.isArray(lastContent)) {
							finalMessages[finalMessages.length - 1] =
								new HumanMessage({
									content: [
										...lastContent,
										{ type: "text", text: humanText },
									],
								});
						} else {
							finalMessages.push(
								new HumanMessage({ content: humanText }),
							);
						}
					} else {
						finalMessages.push(
							new HumanMessage({ content: humanText }),
						);
					}
				}
				continue;
			}
		}
		finalMessages.push(msg);
	}

	// Third pass: Claude refuses a history that ends on an assistant turn ("This
	// model does not support assistant message prefill. The conversation must end
	// with a user message."). Neither pass above can produce that deliberately —
	// it falls out of stripping the tool results that followed a final assistant
	// turn, which then becomes the last message. Observed in production on
	// 2026-08-06: `inputCount: 13, outputCount: 10`, tail `…'human','ai'`, and
	// every subsequent call on that thread 400'd until the user typed again.
	const { messages: shaped, dropped: droppedTurns } =
		shapeHistoryForModel(finalMessages);
	if (droppedTurns > 0) {
		logger.warn(
			"[Project Document Generator] Dropped trailing assistant turn(s)",
			{ dropped: droppedTurns },
		);
	}

	logger.info("[Project Document Generator] Sanitized messages for model", {
		inputCount: messages.length,
		outputCount: shaped.length,
		outputTypes: shaped.map((m) => getMessageType(m)),
	});

	return shaped;
}

/**
 * Chat node for project document generation following ag-ui-demo pattern
 *
 * Flow:
 * 1. Build system prompt with project context and RAG contexts
 * 2. Invoke model with write_document_local tool
 * 3. Model streams document via predictive state AND generates summary in content
 * 4. Add tool response and confirm_changes tool call
 * 5. Return to END - frontend handles confirmation locally
 *
 * @param state - Current agent state
 * @param config - Runnable configuration
 * @returns Command to update state and route to end
 */
/**
 * Detect a clarifying question the model emitted as a structured block instead
 * of calling the (HITL) `ask_clarifying_question` tool. This agent's model only
 * emits `write_document_local`; like the synthetic `confirm_changes` tool call,
 * we parse the model's `clarifying-question` JSON block and synthesize the tool
 * call ourselves so the frontend renders the interactive card.
 *
 * Lenient: accepts a fenced ```clarifying-question / ```json block (or a bare
 * JSON object), requires a non-empty `question`, and caps `options` at 3.
 * Returns null when the text is not a clarifying-question block (normal chat).
 */
export function extractClarifyingQuestion(
	text: string,
): { question: string; options: string[] } | null {
	if (!text) {
		return null;
	}
	const candidates: string[] = [];
	const fenceRe = /```[a-zA-Z-]*\s*([\s\S]*?)```/g;
	let m: RegExpExecArray | null = fenceRe.exec(text);
	while (m !== null) {
		candidates.push(m[1]);
		m = fenceRe.exec(text);
	}
	candidates.push(text); // bare-JSON fallback
	for (const raw of candidates) {
		const trimmed = raw.trim();
		if (!trimmed.startsWith("{")) {
			continue;
		}
		try {
			const obj = JSON.parse(trimmed) as {
				question?: unknown;
				options?: unknown;
			};
			const question =
				typeof obj.question === "string" ? obj.question.trim() : "";
			if (!question) {
				continue;
			}
			const options = Array.isArray(obj.options)
				? obj.options
						.filter(
							(o): o is string =>
								typeof o === "string" && o.trim() !== "",
						)
						.map((o) => o.trim())
						.slice(0, 3)
				: [];
			return { question, options };
		} catch {
			// Not valid JSON — try the next candidate.
		}
	}
	return null;
}

export async function chatNode(
	state: AgentState,
	config?: RunnableConfig,
): Promise<Command> {
	// Snapshot the pre-edit document before any LLM call so `stripToolDefinitions`
	// has a stable baseline even if `predict_state` later streams model output
	// into `state.document` during the same node invocation.
	//
	// Defensive scrub of any `<fabric_source_document>` wrapper-tag pollution
	// inherited from a prior leak. Without this, a once-poisoned document would
	// keep round-tripping the literal tag (or its sanitized `_` variant) into
	// every subsequent edit's baseline and re-emerging in the saved output.
	const preEditDocument = (
		typeof state.document === "string" ? state.document : ""
	).replace(FABRIC_SOURCE_DOC_TAG_RE, "");
	// The RAW node-entry document, before that scrub. `preEditDocument` is the
	// right baseline for prompt building and edit processing, but it is NOT what
	// "your document has not been changed" means: restoring it would silently
	// strip a literal `<fabric_source_document>` token from a document that
	// legitimately contains one. Only a path that promises the document is
	// untouched should use this — currently the truncated-empty terminal branch
	// (issue #2976). Note `state.document` may be undefined for a brand-new
	// document; the state reducer is `(x, y) => y ?? x`, so writing undefined
	// back is a no-op rather than a clear, which matches the pre-existing
	// behaviour of that branch.
	const nodeEntryDocument = state.document;
	// `attemptedImageCount` is hoisted above the try-block so the catch
	// branch can report it in the vision-unsupported telemetry log
	// (`feature_assistant_vision_unsupported`).
	let attemptedImageCount = 0;
	// Shape of the last message array actually sent to the model, hoisted so
	// the catch branch can log it on failure — see `summarizeMessagesForLogging`.
	let lastRequestShape: RequestMessageShapeSummary[] | undefined;
	try {
		const generationStart = Date.now();
		logger.info("[Project Document Generator] Starting chat node", {
			messageCount: state.messages.length,
			documentType: state.documentType,
			projectName: state.projectContext.name,
			ragContextCount: state.ragContexts.length,
			hasCustomPrompt: !!state.systemPrompt,
		});

		// =====================================================================
		// POST-CONFIRMATION HANDLING
		// =====================================================================
		// After user clicks Accept/Reject, CopilotKit sends a tool response back.
		// We detect this and return a simple acknowledgment WITHOUT calling tools.
		// This prevents the infinite confirm_changes loop.
		const confirmationStatus = isAfterConfirmation(state.messages);
		if (confirmationStatus.isAfter) {
			logger.info(
				"[Project Document Generator] Handling post-confirmation",
				{
					accepted: confirmationStatus.accepted,
				},
			);

			// Resolve any pending inline-tool entry
			// (write_document_local / apply_document_patches) on the
			// current turn so the trace doesn't stay "awaiting
			// confirmation" forever after the user accepts/rejects.
			//
			// Two paths, in priority order:
			//
			// 1) IN-PLACE FLIP from state.toolCallsByTurn — preserves the
			//    original startedAt so durationMs reflects the real
			//    review window. Works when the unified-server / agent
			//    runtime checkpoints `toolCallsByTurn` between runs.
			//
			// 2) RECONSTRUCT from state.messages — fallback for runtimes
			//    where Annotation defaults wipe `toolCallsByTurn` on
			//    re-entry (observed with the CopilotKit unified-server
			//    where each agent run rehydrates state from `messages`
			//    plus reducer defaults — `toolCallsByTurn` reducer's
			//    `default: () => ({})` yields an empty record, even
			//    though the frontend sent its local copy in the request
			//    body). The inline AIMessage carrying the original
			//    tool_call survives in `state.messages`, so we synthesize
			//    a resolved entry from it. We lose the original
			//    `startedAt`/`durationMs` in this branch and omit
			//    `durationMs` entirely so the renderer shows just the
			//    status icon + name without a misleading "0.0s".
			//
			// Without either path, the UI's "awaiting confirmation"
			// affordance (ReasoningCollapsible AWAITING_CONFIRMATION_TOOLS)
			// persists after the decision is made, masking rejected
			// edits as unresolved and accepted edits as still in-review.
			const POST_CONFIRMATION_INLINE_TOOLS = new Set([
				"write_document_local",
				"apply_document_patches",
			]);
			let postConfirmToolCallsUpdate: Record<string, unknown> = {};
			let resolutionPath: "in-place" | "reconstruct" | "none" = "none";
			const turnIndexForResolve = countHumanMessages(state.messages);
			if (turnIndexForResolve >= 1) {
				const now = Date.now();
				const existingEntries =
					state.toolCallsByTurn?.[turnIndexForResolve] ?? [];

				// Path 1: in-place flip preserves original startedAt.
				const reconciledFromExisting = existingEntries.map((entry) => {
					if (entry.status !== "pending") {
						return entry;
					}
					if (!POST_CONFIRMATION_INLINE_TOOLS.has(entry.name)) {
						return entry;
					}
					return confirmationStatus.accepted
						? {
								...entry,
								status: "success" as const,
								durationMs: Math.max(0, now - entry.startedAt),
							}
						: {
								...entry,
								status: "error" as const,
								durationMs: Math.max(0, now - entry.startedAt),
								errorMessage:
									"User rejected the proposed changes",
							};
				});
				const existingFlipped = reconciledFromExisting.some(
					(entry, idx) => entry !== existingEntries[idx],
				);

				if (existingFlipped) {
					postConfirmToolCallsUpdate = {
						toolCallsByTurn: {
							[turnIndexForResolve]: reconciledFromExisting,
						},
					};
					resolutionPath = "in-place";
				} else {
					// Path 2: reconstruct from state.messages by reading
					// the `__inlineTool` marker embedded in the synthetic
					// `confirm_changes` AIMessage's tool_call args (see
					// `buildConfirmChangesCommand`). The original AI
					// message that carried the inline tool_call is NOT
					// preserved in state.messages at post-confirmation
					// re-entry — LangGraph's message reducer drops the
					// streamed model AIMessage's tool_calls once the
					// synthetic confirm_changes one is emitted, so the
					// confirm_changes call is the only carrier we have
					// for the (id, name) pair.
					//
					// CopilotKit's wire format strips
					// `additional_kwargs` between runs, but tool_call
					// args are standard AG-UI protocol fields and
					// round-trip faithfully.
					//
					// CORRELATION BY tool_call_id: the answering
					// ToolMessage at the tail of state.messages carries
					// `tool_call_id` pointing at the EXACT
					// `confirm_changes` call the user just
					// accepted/rejected. Walking backward to "the most
					// recent AI with a marker" is insufficient — if the
					// thread contains multiple confirm_changes calls
					// (legacy thread rehydration, modal double-emission,
					// or a stale ToolMessage interleaving), the most
					// recent marker can belong to a DIFFERENT
					// confirmation than the one being resolved. We
					// instead select the AI/tool_call whose id matches
					// the answering ToolMessage's tool_call_id, then
					// extract the marker from THAT specific call.
					const lastToolMsg = state.messages[
						state.messages.length - 1
					] as unknown as {
						tool_call_id?: string;
						additional_kwargs?: { tool_call_id?: string };
					};
					const answeringToolCallId =
						lastToolMsg?.tool_call_id ??
						lastToolMsg?.additional_kwargs?.tool_call_id;

					let inlineToolCall:
						| { id: string; name: string }
						| undefined;
					if (typeof answeringToolCallId === "string") {
						outer: for (
							let i = state.messages.length - 1;
							i >= 0;
							i--
						) {
							const msg = state.messages[i] as unknown as {
								tool_calls?: Array<{
									id?: string;
									name?: string;
									args?: Record<string, unknown>;
								}>;
							};
							const msgType = getMessageType(msg);
							if (msgType !== "ai") {
								continue;
							}
							const calls = msg.tool_calls;
							if (!Array.isArray(calls) || calls.length === 0) {
								continue;
							}
							for (const c of calls) {
								if (
									c?.id !== answeringToolCallId ||
									c?.name !== "confirm_changes"
								) {
									continue;
								}
								const marker = (c?.args as any)?.__inlineTool as
									| { id?: unknown; name?: unknown }
									| undefined;
								if (
									marker &&
									typeof marker.id === "string" &&
									typeof marker.name === "string" &&
									POST_CONFIRMATION_INLINE_TOOLS.has(
										marker.name,
									)
								) {
									inlineToolCall = {
										id: marker.id,
										name: marker.name,
									};
								}
								// Whether or not the marker validated,
								// stop searching — we found the
								// confirm_changes call being answered;
								// anything else is unrelated.
								break outer;
							}
						}
					}
					if (!inlineToolCall) {
						logger.warn(
							"[Project Document Generator] Post-confirmation reconstruct could not find inline tool_call marker",
							{
								messageCount: state.messages.length,
								answeringToolCallId,
								hint: "Expected an AI message with a confirm_changes tool_call whose id === answeringToolCallId and whose args.__inlineTool was set by buildConfirmChangesCommand",
							},
						);
					}
					if (inlineToolCall) {
						// Synthesized entry intentionally omits
						// `durationMs` — we don't know the original
						// startedAt, and emitting `now - now = 0` would
						// render misleading "0.0s" in the UI. The
						// ReasoningCollapsible renderer drops the
						// duration text when `durationMs` is undefined.
						const synthesized = confirmationStatus.accepted
							? {
									id: inlineToolCall.id,
									name: inlineToolCall.name,
									status: "success" as const,
									startedAt: now,
								}
							: {
									id: inlineToolCall.id,
									name: inlineToolCall.name,
									status: "error" as const,
									startedAt: now,
									errorMessage:
										"User rejected the proposed changes",
								};
						// Preserve any other entries that legitimately survived
						// rehydration for this turn (e.g. a successful
						// `search_teams_messages` recorded earlier in the
						// same multi-tool turn). Drop entries that collide
						// with the synthesized one by id, plus any leftover
						// `pending` rows — they would otherwise leave a
						// phantom spinner in the trace next to the
						// now-resolved row.
						const preserved = existingEntries.filter(
							(e) =>
								e.id !== synthesized.id &&
								e.status !== "pending",
						);
						postConfirmToolCallsUpdate = {
							toolCallsByTurn: {
								[turnIndexForResolve]: [
									...preserved,
									synthesized,
								],
							},
						};
						resolutionPath = "reconstruct";
					}
				}

				// Unconditional log so the "none" failure mode is observable
				// in production. Searching for "Post-confirmation tool trace
				// reconciliation" surfaces every reconcile attempt;
				// `resolutionPath` tells you which branch (or "none") ran.
				logger.info(
					"[Project Document Generator] Post-confirmation tool trace reconciliation",
					{
						turnIndex: turnIndexForResolve,
						accepted: confirmationStatus.accepted,
						resolutionPath,
					},
				);
			}

			// Create a simple acknowledgment message (no tool calls!)
			const acknowledgment = confirmationStatus.accepted
				? "Changes have been applied to the document."
				: "Changes have been discarded. The document remains unchanged.";

			const ackMessage = new AIMessage({ content: acknowledgment });

			return new Command({
				goto: END,
				update: {
					messages: [...state.messages, ackMessage],
					error: undefined,
					...postConfirmToolCallsUpdate,
				},
			});
		}

		// Build system prompt using async version for Fabric AI integration.
		// Use `preEditDocument` (the wrapper-scrubbed baseline) for both the
		// presence check and the prompt body, so any `<fabric_source_document>`
		// pollution from a prior leak doesn't reach the model.
		const hasExistingDocument = preEditDocument.trim().length > 0;

		// CRITICAL: When regenerating, do NOT pass existing document to prompt builder.
		// Passing it triggers editing/preservation mode which tells the model to preserve
		// the old format and suppress template structure reminders. Regeneration should
		// produce a fresh document from the prompt template, not edit the old one.
		const existingDocForPrompt = state.isRegeneration
			? undefined
			: preEditDocument || undefined;

		// When editing, exclude the document body from the system prompt.
		// The document content is injected as a user message instead, keeping
		// the system prompt small (~5-8K) and cacheable. The system prompt
		// still includes editing rules and section headings for guidance.
		const isEditing = !!existingDocForPrompt;

		// Bind `apply_document_patches` for edits on existing documents at or
		// above the threshold. Full rewrites remain the path for new documents,
		// regeneration (intentional full rewrite), small documents, and
		// headingless documents (where there's nothing for the model to anchor
		// patches against — every patch would fail with anchor_not_found).
		const patchModeAvailable =
			isEditing &&
			!state.isRegeneration &&
			preEditDocument.length >= PATCH_MODE_MIN_DOC_CHARS &&
			listAnchorPaths(preEditDocument).length > 0;

		// Tool budget for this human turn — mirrors shouldContinue's backstop
		// (agent.ts) but acts earlier: once the budget is exhausted, this node
		// directs the model to finalize and rejects any further research call
		// itself, instead of relying on shouldContinue's hard __end__ force,
		// which would end the run with a dangling tool call and no document.
		const toolRounds = countToolRoundsSinceLastHuman(state.messages);
		const finalizeMode = toolRounds >= MAX_TOOL_ITERATIONS;
		if (finalizeMode) {
			logger.warn(
				"[Project Document Generator] Tool budget exhausted — directing the model to finalize",
				{ toolRounds, maxToolIterations: MAX_TOOL_ITERATIONS },
			);
		}

		// Strip image data URLs out of the rag-contexts so we feed the prompt
		// builder text-only entries (still labeled with the filename so the
		// model can reference the file by name). The extracted data URLs are
		// re-attached below as `image_url` content parts on the user message
		// for vision-capable tenant models — see fix follow-up to PR #724
		// where the image arrived at the agent but was treated as base64 text.
		const {
			textOnlyContexts: ragContextsForPrompt,
			images: pendingImages,
		} = splitRagContextImages(state.ragContexts);
		// Record the image count for the outer-scope hoisted counter so the
		// catch branch can report it if the provider rejects vision input.
		attemptedImageCount = pendingImages.length;

		let contextualPrompt = await buildSystemPromptAsync(
			state.systemPrompt,
			state.documentType,
			state.projectContext,
			ragContextsForPrompt,
			existingDocForPrompt,
			{
				excludeDocumentBody: isEditing,
				toolMode: patchModeAvailable ? "patch" : "write",
				activeSkill: state.activeSkill,
			},
		);

		// Patch mode also binds write_document_local as an escape hatch. The
		// system prompt above teaches patches; add a short note so the model
		// knows when to switch tools instead of grinding the patch path into
		// the excessive_content_loss guard.
		if (patchModeAvailable) {
			contextualPrompt += `

---

## Escape Hatch: Full Rewrites

\`apply_document_patches\` is the default and preferred tool. **However**, when the user's request requires *restructuring most of the document* (e.g. stage transitions like Active Analysis → Sanity Check, switching document types, or any change where >50% of the existing content no longer applies), call \`write_document_local\` with the complete new document instead.

Signs you should use \`write_document_local\`:
- The existing section structure no longer applies (most sections will be removed or replaced).
- A patch sequence would trigger \`excessive_content_loss\` (>80% of body removed).
- The user explicitly asks for a "rewrite", "transform", "restructure", or to switch the document to a different stage/type.

Otherwise, prefer \`apply_document_patches\` — it produces clean diffs, costs less, and preserves untouched content verbatim.`;
		}

		// Append Teams tool instructions when Teams chats are linked
		if (state.hasTeamsIntegration) {
			contextualPrompt += `

---

## Microsoft Teams Integration

This project has linked Microsoft Teams chats and/or channels. You have tools to query them directly:

- **list_linked_chats**: Lists all Teams chats/channels linked to this project with their IDs. Use this FIRST to discover what's available.
- **get_chat_messages**: Get recent messages from a **group chat** (has chatId). Use for items from list_linked_chats that have a chatId.
- **get_teams_channel_messages**: Get recent messages from a **channel** (has teamId + channelId). Use for items from list_linked_chats that have teamId/channelId.
- **search_teams_messages**: Search across ALL linked chats/channels by keyword (KQL search). Best for finding messages about a specific topic.
- **get_full_message**: Get untruncated content of a specific message.
- **list_message_replies**: Get threaded replies under a channel message.
- **get_message_hosted_content**: Get images (screenshots, diagrams) embedded in a message. Returns base64 image data you can analyze.

### When to use which tool:
- **"Show latest messages"** → list_linked_chats first, then get_chat_messages (for group chats with chatId) or get_teams_channel_messages (for channels with teamId/channelId)
- **"Find discussions about X"** → search_teams_messages with relevant keywords

**IMPORTANT**: NEVER ask the user for a chat ID or channel ID. Use list_linked_chats to discover them.`;
		}

		// Append Slack tool instructions when Slack channels are linked
		if (state.hasSlackIntegration) {
			contextualPrompt += `

---

## Slack Integration

This project has linked Slack channels. You have tools to query them directly:

- **list_linked_channels**: Lists all Slack channels linked to this project with their IDs. Use this FIRST to discover available channels.
- **get_channel_messages**: Get the most recent messages from a specific channel. Requires a channelId from list_linked_channels. Each message includes a threadTs when it sits in a thread.
- **search_slack_messages**: Search across all linked Slack channels by keyword. Best for finding messages about a specific topic. Supports Slack search modifiers (from:@user, in:#channel, before:/after: dates, has:link, has:file) — combine them to filter server-side. Returns clickable permalinks; cite them in your responses.
- **get_thread_replies**: Get replies under a Slack thread. Use this AFTER a search/browse result with a threadTs — Slack discussions and decisions often live in threads, not top-level messages.
- **get_shared_files**: List files shared in a channel (images, PDFs, attachments). Returns Slack permalinks the user can click. Filter by Slack file types via the 'types' arg ('images,pdfs', etc.).

### When to use which tool:
- **"Show latest messages" / "What's new in Slack"** → call list_linked_channels first, then get_channel_messages for each channel
- **"Find discussions about X"** → call search_slack_messages with relevant keywords + modifiers
- **"Read the full discussion / thread"** → call get_thread_replies with the channelId + threadTs from a prior result
- **"What files were shared / show me the diagram in Slack"** → call get_shared_files

**IMPORTANT**: NEVER ask the user for a channel ID. Use list_linked_channels to discover them. When citing Slack content, include the permalink so the user can click through. Tool results carry bracketed metadata like \`[messageId: ..., channelId: ..., threadTs: ...]\` — that metadata is for your own follow-up tool calls only. Never include it in user-facing prose; quote the message and link via permalink instead.`;

			// When Slack is the ONLY linked chat context, treat it as primary
			// project signal. With Teams also linked, the agent splits attention
			// between both — but Slack-only means there is no Teams fallback,
			// so failing to consult Slack leaves the agent answering blind.
			if (!state.hasTeamsIntegration) {
				contextualPrompt += `

### Slack is the only chat context for this project

There is no Microsoft Teams integration linked — Slack is the sole live chat source. Treat it as the primary signal for project status, recent decisions, blockers, and "what's happening" questions. **Before answering anything that could be informed by recent team discussion, proactively call \`search_slack_messages\` (with relevant keywords from the user's question) or \`get_channel_messages\` (for "latest" / status-style questions). Don't wait to be asked.** Skip this only for purely structural edits where Slack context is irrelevant (e.g., "rewrite this title", "fix the markdown").`;
			}
		}

		// Append code search tool instructions when repository is connected
		if (state.hasRepoIntegration) {
			contextualPrompt += `

---

## Repository Code Search

This project has a connected code repository. You MUST use these tools to search and understand the codebase whenever the user asks about code, implementation details, architecture, or technical questions.

**IMPORTANT**: When the user asks about how something is implemented, what code exists, or any question that could be answered by looking at the source code, you SHOULD proactively use these tools rather than guessing or relying only on project documents. Always ground your answers in actual code when possible.

### Available tools:
- **search_repository_code**: Search for code matching a query. Returns file paths and matched snippets. Use specific terms like function names, class names, or patterns.
- **get_repository_file**: Fetch the full content of a specific file by path. Use after search to read the full source of a relevant file.
- **list_repository_structure**: List the directory tree of the repository. Use to understand the project structure before searching.

### When to use which tool:
- **"How is authentication implemented?"** → search_repository_code for "auth middleware", then get_repository_file to read the relevant files
- **"Show me the user model"** → search_repository_code for "user model" or "User class", then get_repository_file for the result
- **"What's the project structure?"** → list_repository_structure to see the directory tree
- **"Read src/auth/middleware.ts"** → get_repository_file directly with the path
- **"What features are built?"** → list_repository_structure first, then search_repository_code for key areas
- **"Generate a tech spec for feature X"** → search_repository_code to understand existing implementation, then generate the spec grounded in actual code`;
		}

		// Diagram (Excalidraw) routing — surfaced when a managed-default MCP
		// tool has reached this agent via `state.copilotkit.actions`. Without
		// this section the LLM treats `create_view` as one tool among many
		// and the document-editing-heavy system prompt above biases it
		// toward `write_document_local` even when the user explicitly asks
		// for a diagram (observed in prod F-052 — see PR #892 follow-up).
		//
		// We key off the action NAME rather than `_isMCPTool` because the
		// AG-UI marshaling between the CopilotKit runtime and the LangGraph
		// agent flattens action objects to `{name, description, parameters}`
		// — extra metadata like `_isMCPTool` doesn't survive the wire.
		// Today's only managed-default MCP App is Excalidraw, so a single
		// name match is sufficient. Add more when new defaults ship.
		const hasExcalidrawCreateView = (state.copilotkit?.actions ?? []).some(
			(a: { name?: string }) => a?.name === "create_view",
		);
		if (hasExcalidrawCreateView) {
			// The persisted `<excalidraw-embed>` must carry the active org id so
			// the document/feature editor can resolve the (org-scoped) Excalidraw
			// MCP config when it later fetches the scene via `read_checkpoint`.
			// Without it, the reload-time lookup runs in personal context
			// (`organizationId: null`) and the org's config isn't found → 404
			// "Couldn't display this diagram". The LLM can't derive the org from
			// the `create_view` result, so we inject the concrete value here. In
			// personal context we omit the attr entirely — the personal-scoped
			// config resolves without it.
			const embedOrgIdAttr = state.organizationId
				? ` data-organization-id="${state.organizationId}"`
				: "";
			contextualPrompt += `

---

## Diagrams (Excalidraw)

\`create_view\` (from the Excalidraw MCP server) is available. It renders
an interactive diagram inline in the chat. The diagram appears as a
canvas the user can pan, zoom, and edit.

### Tool selection — when to call which

- **User asks for a diagram, drawing, visualization, chart, flowchart,
  architecture diagram, or mentions Excalidraw explicitly** → call
  \`create_view\`. The canvas renders inline in the chat.

- **User asks for textual content (description, criteria, summary,
  feature size, etc.)** → call \`write_document_local\` (or
  \`apply_document_patches\`) as usual. Do NOT call \`create_view\`.

- **User's message is conversational** — a question, an answer to your
  question, status/progress discussion, feedback, an opinion or a
  preference between options ("I think option #1 is best"), an
  acknowledgement, or anything that does not explicitly request a
  visual → do NOT call \`create_view\`. Reply in text. When in doubt
  whether the user wants a diagram, do NOT call \`create_view\` — ask,
  or answer in text.

- **A diagram would merely help explain content you are writing INTO
  the document** (no explicit user request for an interactive diagram)
  → put a \`mermaid\` code block in the document body via
  \`write_document_local\` / \`apply_document_patches\`.
  \`create_view\` is reserved for an explicit user request for an
  interactive (pan/zoom/edit) diagram in the chat.

- **User asks for BOTH a diagram AND text** (e.g., "draw onion
  architecture and add a description to the doc") → call BOTH tools in
  the same turn: \`create_view\` for the canvas, and
  \`write_document_local\` / \`apply_document_patches\` for the prose.
  When you do both, write the prose to describe what the diagram shows
  — the user is looking at the diagram in the chat, so the document
  text should complement it, not duplicate the visual content.

- **User asks for the diagram to be PLACED IN THE DOCUMENT** (e.g.,
  "put it in the doc", "add this diagram to the document"):

  You MAY emit \`<excalidraw-embed>\` HTML inline in your
  \`write_document_local\` (or \`apply_document_patches\`) output
  whenever you have just called \`create_view\` AND you are writing or
  updating a document body where the diagram belongs inline. Use this
  exact template. Fill \`resourceUri\`, \`mcpConfigId\`, and
  \`checkpointId\` from the \`create_view\` tool result; the
  \`data-organization-id\` below is already filled in for you — copy it
  verbatim (it is required so the saved diagram can be re-loaded from the
  correct tenant on reload):
  \`<excalidraw-embed data-resource-uri="\${resourceUri}" data-config-id="\${mcpConfigId}" data-checkpoint-id="\${checkpointId}"${embedOrgIdAttr}></excalidraw-embed>\`
  The TipTap editor renders this as an interactive Excalidraw canvas
  inside the document. The UI also surfaces an "Insert into <Doc>"
  fallback button on the chat message for ad-hoc cases (Nexus / Loom /
  cases where you didn't write the doc); do NOT also call the
  diagram-insert API yourself — emitting the embed is enough. If you
  have already emitted \`<excalidraw-embed>\` for a given
  \`checkpointId\` in this conversation, do NOT emit it again
  (dedup-by-checkpointId — the UI button detects the existing embed and
  becomes a scroll-to action).

### Critical: do NOT mix tools when the user only wants a diagram

When the user's request is **purely** "draw / make / show me a diagram"
with no request for document text, call ONLY \`create_view\`. Do NOT
also call \`write_document_local\` — that would dump unrelated content
into the user's feature/document and surface a \`Confirm Changes\`
dialog the user didn't ask for. This is the most common failure mode
we observed; default to the narrower tool selection.

### Parameter guidance for \`create_view\`

\`elements\` must be a **JSON-encoded string** of a **non-empty** array
of Excalidraw element objects — pass \`JSON.stringify(elements)\`,
exactly as the tool schema says. Never call the tool with an empty
array: if you have no elements to draw, do not call it at all. Each
element needs roughly 20 fields (id, type, x, y, width,
height, angle, strokeColor, backgroundColor, fillStyle, strokeWidth,
strokeStyle, roughness, opacity, groupIds, frameId, roundness, seed,
versionNonce, isDeleted, boundElements, updated, link, locked). If you
omit required fields the server returns a validation error you'll
have to retry.

The \`create_view\` tool's own description in your tool spec lists the
exact schema. Read it before invoking.`;
		}

		// NOTE: finalize mode deliberately adds NOTHING to the system prompt.
		// The system message is message 0 of the request and therefore the head
		// of the provider's cacheable prefix; changing it on the final turn
		// invalidates the cache on the single largest call of the run. The
		// finalize instruction rides in an ephemeral trailing HumanMessage
		// instead — see `buildFinalizeDirectiveMessage` and its use at the
		// invocation site.

		logger.info("[Project Document Generator] System prompt built", {
			promptLength: contextualPrompt.length,
			hasExistingDocument,
			isEditing,
			documentBodyInUserMessage: isEditing,
			documentLength: existingDocForPrompt?.length || 0,
			isRegeneration: state.isRegeneration,
			documentType: state.documentType,
			hasTeamsIntegration: state.hasTeamsIntegration,
			hasSlackIntegration: state.hasSlackIntegration,
			hasRepoIntegration: state.hasRepoIntegration,
		});

		// Extract provider config from runtime config
		const providerConfig = extractProviderConfig(config);

		// maxTokens computation: in patch mode we ALSO bind write_document_local
		// as an escape hatch for legitimate full rewrites (e.g. stage transitions
		// where the existing document's structure no longer applies). Either tool
		// could fire, so the budget must accommodate the larger one. Unused budget
		// has no per-token cost — patches still output ~2-6K, write outputs the
		// full doc. ~3 chars/token is conservative for markdown; 4K headroom
		// covers new content. Clamped to 16K floor / 48K ceiling (models like
		// GPT-4o still cap at 16K output).
		//
		// On reasoning-capable models (issue #2781), invisible thinking tokens
		// are billed against the same `max_tokens` cap as the visible tool-call
		// output — the reproduction estimate below leaves no headroom for them,
		// so a large full-document rewrite can truncate mid-tool-call before any
		// visible output is written. The allowance for that CANNOT be computed
		// here: `providerConfig` is extracted from the runtime config up front,
		// but `getAgentModelAsync` can still substitute a different model before
		// building the client — a task-specific-preference override or an
		// API-fallback-resolved config this node never sees — so a
		// pre-resolution allowance would silently apply to the wrong model, or
		// not apply at all when there was no runtime config to extract. Instead
		// `maxTokensForConfig` below is evaluated by `createProviderModel`
		// against the FINAL resolved config; `baseMaxTokens` is passed as
		// `maxTokens` only as a fallback for the (currently theoretical) case
		// where `maxTokensForConfig` is unset.
		let baseMaxTokens: number;
		{
			const existingDocChars = preEditDocument.length;
			const estimatedReproduceTokens = Math.ceil(existingDocChars / 3);
			baseMaxTokens = Math.max(16000, estimatedReproduceTokens + 4000);
			logger.info(
				"[Project Document Generator] Document tool maxTokens",
				{
					existingDocChars,
					estimatedReproduceTokens,
					baseMaxTokens,
					fallbackMaxTokens: Math.min(
						NORMAL_OUTPUT_TOKEN_CEILING,
						baseMaxTokens,
					),
					mode: patchModeAvailable ? "patch+write-fallback" : "write",
					note: "reasoning allowance (issue #2781) is applied post-resolution against the final model — see the langchain-models 'maxTokensForConfig applied' log for the effective maxTokens",
				},
			);
		}

		// Create model with provider config
		const model = await getAgentModelAsync(config, {
			temperature: 0.5,
			maxTokens: Math.min(NORMAL_OUTPUT_TOKEN_CEILING, baseMaxTokens),
			maxTokensForConfig: (resolvedConfig: ProviderConfig) =>
				Math.min(
					NORMAL_OUTPUT_TOKEN_CEILING,
					baseMaxTokens +
						reasoningOutputAllowanceForConfig(resolvedConfig),
				),
			retryCount: state.retryCount,
			taskType: "TOOL_CALLING",
		});

		logger.info(
			"[Project Document Generator] Using model:",
			providerConfig?.model || "(API fallback)",
		);

		// Configure runnable with predict_state for streaming
		const runnableConfig = config || {
			recursionLimit: DEFAULT_RECURSION_LIMIT,
		};

		if (!runnableConfig.metadata) {
			runnableConfig.metadata = {};
		}

		// predict_state streams document deltas into state.document for a live
		// diff. The config keys on `tool: "write_document_local"`, so when the
		// model picks apply_document_patches it simply doesn't fire — patches
		// have no `document` arg to extract. Setting it always means the live
		// preview works for the write_document_local escape hatch in patch mode.
		runnableConfig.metadata.predict_state = getPredictStateConfig();

		if (!model.bindTools) {
			throw new Error(
				"[Project Document Generator] Model does not support tool binding",
			);
		}

		// In patch mode, bind BOTH tools and let the model choose:
		// - apply_document_patches (preferred): targeted edits that preserve
		//   the document's structure. Cheap, fast, deterministic diffs.
		// - write_document_local (escape hatch): legitimate full rewrites where
		//   the existing structure no longer applies (e.g. stage transitions
		//   like Active Analysis → Sanity Check, where ~80% of content
		//   legitimately drops). Without this, the model gets stuck fighting
		//   the excessive_content_loss guard with no way out.
		// Outside patch mode (new doc, regeneration, headingless, small) only
		// write_document_local is bound — patches add nothing there.
		// Do NOT use tool_choice to force a tool: the model needs freedom to
		// respond without tools when handling confirmation replies.
		const copilotKitActions = state.copilotkit?.actions || [];
		const copilotKitTools =
			convertActionsToDynamicStructuredTools(copilotKitActions);
		const documentTools = patchModeAvailable
			? [APPLY_DOCUMENT_PATCHES_TOOL, WRITE_DOCUMENT_TOOL]
			: [WRITE_DOCUMENT_TOOL];
		// Inline tools handled by chat_node itself (never routed to
		// tool_node). This is also the allow-list the post-invoke finalize
		// guard enforces once the tool budget is spent: any server-side tool
		// pushed onto `tools` after this point is outside the set and is
		// therefore rejected in finalize mode automatically — no per-tool
		// guard to remember.
		const inlineTools: any[] = [...copilotKitTools, ...documentTools];
		const inlineToolNames = [
			...copilotKitActions.map((a: any) => a.name || "unknown"),
			...documentTools.map((t) => t.function.name),
		];
		const tools: any[] = [...inlineTools];
		const boundToolNames = [...inlineToolNames];

		// search_project_knowledge: Always available — searches all embedded project context
		// (meeting transcripts, uploaded docs, codebase analysis, integration content)
		tools.push({
			type: "function",
			function: {
				name: "search_project_knowledge",
				description: `Search the project's knowledge base for relevant information.
This searches all embedded project context including meeting transcripts, uploaded documents,
codebase analysis, and integration content using semantic similarity.

Use this tool when you need to:
- Find what was discussed in meetings (meeting transcripts are embedded here)
- Look up information from uploaded documents or PRDs
- Find relevant codebase context
- Search for any project-specific knowledge

Examples:
- "meeting April 3rd features discussed"
- "authentication requirements from PRD"
- "database schema decisions"`,
				parameters: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description:
								"Search query — use specific terms related to what you're looking for",
						},
						topK: {
							type: "number",
							description:
								"Maximum number of results to return (default: 10, max: 20)",
						},
					},
					required: ["query"],
				},
			},
		});
		boundToolNames.push("search_project_knowledge");

		if (state.hasTeamsIntegration) {
			// Add Teams tool schemas (execution handled by tool_node)
			// list_linked_chats: Discover linked Teams chats/channels and their IDs
			tools.push({
				type: "function",
				function: {
					name: "list_linked_chats",
					description: `List all Microsoft Teams chats and channels linked to this project.
Returns chat IDs, names, and types so you can then use get_chat_messages to fetch recent messages.
Use this FIRST when the user asks about recent/latest Teams messages, before calling get_chat_messages.`,
					parameters: {
						type: "object",
						properties: {},
						required: [],
					},
				},
			});
			boundToolNames.push("list_linked_chats");
			// search_teams_messages: KQL-powered search across project Teams chats
			tools.push({
				type: "function",
				function: {
					name: "search_teams_messages",
					description: `Search for messages in Microsoft Teams chats that are linked to this project.
Use this tool when you need to find relevant context from team discussions, decisions, or conversations.
The search will only look in chats that have been configured for this project.

Returns up to ~16 relevance-ranked excerpts (≤ 400 chars each). Each excerpt includes
messageId plus either chatId (group chats) or teamId/channelId (channels) so you can
drill in with get_full_message or list_message_replies.

Supply 'alternateQuery' when the topic has obvious synonyms or the stage prompt
points to a different phrasing than your literal keywords — the server runs both
queries in parallel and merges the deduplicated excerpts.

Examples of when to use:
- "Search for discussions about authentication requirements"
- "Find messages mentioning the API design"
- "Look for any decisions made about the database schema"`,
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Primary search query — keywords, phrases, or topics",
							},
							alternateQuery: {
								type: "string",
								description:
									"Optional second search query. Supply when the topic has synonyms, a different phrasing in the stage prompt, or two facets worth searching separately. The server runs both queries in parallel and merges deduplicated excerpts.",
							},
							limit: {
								type: "number",
								description:
									"Maximum raw Graph messages per pass before relevance filtering (default: 15, max: 50)",
							},
						},
						required: ["query"],
					},
				},
			});
			// get_chat_messages: Browse recent messages from a specific linked chat
			tools.push({
				type: "function",
				function: {
					name: "get_chat_messages",
					description: `Get recent messages from a specific Microsoft Teams chat linked to this project.
Use this when you want to browse recent messages in a particular chat rather than search by keywords.
You need the chatId which you can find from search results or from the project's linked chats.

Optional 'query' switches the response to a bounded set of relevance-ranked excerpts
(≤ 8, ≤ 400 chars each) filtered against the active stage prompt. Prefer this when
you're looking for something specific; omit it only for chronological browsing.`,
					parameters: {
						type: "object",
						properties: {
							chatId: {
								type: "string",
								description:
									"The Teams chat ID to fetch messages from",
							},
							query: {
								type: "string",
								description:
									"Optional relevance query. When provided, returns relevance-filtered excerpts rather than raw recent messages.",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of messages to return (default: 20, max: 50)",
							},
						},
						required: ["chatId"],
					},
				},
			});
			// get_teams_channel_messages: Browse recent messages from a Teams channel
			tools.push({
				type: "function",
				function: {
					name: "get_teams_channel_messages",
					description: `Get recent messages from a Microsoft Teams channel linked to this project.
Use this for channels (which have teamId/channelId). For group chats (which have chatId), use get_chat_messages instead.
Get the teamId and channelId from list_linked_chats.

Optional 'query' switches the response to a bounded set of relevance-ranked excerpts
(≤ 8, ≤ 400 chars each) filtered against the active stage prompt.`,
					parameters: {
						type: "object",
						properties: {
							teamId: {
								type: "string",
								description:
									"The Team ID from list_linked_chats",
							},
							channelId: {
								type: "string",
								description:
									"The Channel ID from list_linked_chats",
							},
							query: {
								type: "string",
								description:
									"Optional relevance query. When provided, returns relevance-filtered excerpts rather than raw recent messages.",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of messages to return (default: 20, max: 50)",
							},
						},
						required: ["teamId", "channelId"],
					},
				},
			});
			boundToolNames.push("get_teams_channel_messages");
			// get_full_message: Get untruncated content of a specific message
			tools.push({
				type: "function",
				function: {
					name: "get_full_message",
					description: `Get the full, untruncated content of a specific Microsoft Teams message.
Use this when search results show a truncated message and you need to see the complete text.
Requires the messageId and either a chatId (for group chats) or teamId+channelId (for channels).`,
					parameters: {
						type: "object",
						properties: {
							messageId: {
								type: "string",
								description:
									"The ID of the message to retrieve",
							},
							chatId: {
								type: "string",
								description:
									"Chat ID if the message is from a group chat",
							},
							teamId: {
								type: "string",
								description:
									"Team ID if the message is from a channel",
							},
							channelId: {
								type: "string",
								description:
									"Channel ID if the message is from a channel",
							},
						},
						required: ["messageId"],
					},
				},
			});
			// list_message_replies: Follow threaded discussions in channels
			tools.push({
				type: "function",
				function: {
					name: "list_message_replies",
					description: `Get replies in a thread under a specific Microsoft Teams channel message.
Use this to follow threaded discussions when you find a relevant message in a channel.
Requires teamId, channelId, and the parent messageId.

Optional 'query' switches the response to relevance-ranked excerpts (≤ 8, ≤ 400 chars each)
filtered against the active stage prompt.`,
					parameters: {
						type: "object",
						properties: {
							teamId: {
								type: "string",
								description: "The Team ID",
							},
							channelId: {
								type: "string",
								description: "The Channel ID",
							},
							messageId: {
								type: "string",
								description:
									"The parent message ID to get replies for",
							},
							query: {
								type: "string",
								description:
									"Optional relevance query. When provided, returns relevance-filtered excerpts rather than raw replies.",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of replies to return (default: 25)",
							},
						},
						required: ["teamId", "channelId", "messageId"],
					},
				},
			});
			// get_message_hosted_content: Fetch images from a Teams message
			tools.push({
				type: "function",
				function: {
					name: "get_message_hosted_content",
					description: `Get images (screenshots, diagrams, photos) embedded in a Microsoft Teams message.
Use this when a message has image attachments you need to view or describe.
Returns image data the model can analyze. You MUST provide messageId AND either chatId (for group chats) or both teamId+channelId (for channels). Get these from search_teams_messages, get_chat_messages, or list_linked_chats results.`,
					parameters: {
						type: "object",
						properties: {
							messageId: {
								type: "string",
								description:
									"The ID of the message containing images",
							},
							chatId: {
								type: "string",
								description:
									"Chat ID (required for group chat messages)",
							},
							teamId: {
								type: "string",
								description:
									"Team ID (required for channel messages, with channelId)",
							},
							channelId: {
								type: "string",
								description:
									"Channel ID (required for channel messages, with teamId)",
							},
						},
						required: ["messageId"],
					},
				},
			});
			boundToolNames.push(
				"search_teams_messages",
				"get_chat_messages",
				"get_full_message",
				"list_message_replies",
				"get_message_hosted_content",
			);
		}

		// Slack integration tools (search and browse Slack channels)
		if (state.hasSlackIntegration) {
			// list_linked_channels: Discover linked Slack channels and their IDs
			tools.push({
				type: "function",
				function: {
					name: "list_linked_channels",
					description: `List all Slack channels linked to this project.
Returns channel IDs and names so you can then use get_channel_messages to fetch recent messages.
Use this FIRST when the user asks about recent/latest Slack messages, before calling get_channel_messages.`,
					parameters: {
						type: "object",
						properties: {},
						required: [],
					},
				},
			});
			boundToolNames.push("list_linked_channels");
			// search_slack_messages: Search across project Slack channels
			tools.push({
				type: "function",
				function: {
					name: "search_slack_messages",
					description: `Search for messages in Slack channels that are linked to this project.
The query is passed verbatim to Slack's search.messages API, so combine free text with Slack's
search modifiers to filter server-side: from:@user, in:#channel, before:YYYY-MM-DD,
after:YYYY-MM-DD, has:link, has:file. Each result includes a clickable permalink and (when the
matched message is in a thread) a threadTs — pass that to get_thread_replies to read the full thread.

Examples:
- "rollout plan from:@alice has:link"
- "incident in:#sre after:2026-04-01"
- "design review before:2026-05-01"`,
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Slack search query — supports modifiers like from:@user, in:#channel, before:/after:YYYY-MM-DD, has:link, has:file",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of messages to return (default: 15, max: 50)",
							},
						},
						required: ["query"],
					},
				},
			});
			// get_channel_messages: Browse recent messages from a specific linked Slack channel
			tools.push({
				type: "function",
				function: {
					name: "get_channel_messages",
					description: `Get recent messages from a specific Slack channel linked to this project.
Use this when you want to browse recent messages chronologically rather than searching by keyword
— for topic-specific lookups, prefer search_slack_messages with its modifiers.
You need the channelId from list_linked_channels. Each returned message includes a threadTs when
it participates in a thread; call get_thread_replies with that to read the full discussion.`,
					parameters: {
						type: "object",
						properties: {
							channelId: {
								type: "string",
								description:
									"The Slack channel ID to fetch messages from",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of messages to return (default: 20, max: 50)",
							},
						},
						required: ["channelId"],
					},
				},
			});
			tools.push({
				type: "function",
				function: {
					name: "get_thread_replies",
					description: `Get replies under a Slack message thread. Use AFTER a prior search/browse
result returns a threadTs — Slack discussions and decisions frequently live in threads, not in the
top-level message. Pass the channelId + threadTs from that earlier result.`,
					parameters: {
						type: "object",
						properties: {
							channelId: {
								type: "string",
								description:
									"The Slack channel ID containing the thread",
							},
							threadTs: {
								type: "string",
								description:
									"The thread parent timestamp (thread_ts) from a prior search/browse result",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of replies to return (default: 50, max: 200)",
							},
						},
						required: ["channelId", "threadTs"],
					},
				},
			});
			tools.push({
				type: "function",
				function: {
					name: "get_shared_files",
					description: `List files shared in a specific Slack channel linked to this project.
Use this for screenshots, PDFs, diagrams, or other attachments the user references.
Returns Slack permalinks the user can click. Filter by file type via the 'types' arg
(comma-separated Slack file types like 'images,pdfs,snippets').`,
					parameters: {
						type: "object",
						properties: {
							channelId: {
								type: "string",
								description:
									"The Slack channel ID to list files from",
							},
							limit: {
								type: "number",
								description:
									"Maximum number of files to return (default: 20, max: 100)",
							},
							types: {
								type: "string",
								description:
									"Optional comma-separated Slack file types filter (e.g. 'images,pdfs')",
							},
						},
						required: ["channelId"],
					},
				},
			});
			boundToolNames.push(
				"search_slack_messages",
				"get_channel_messages",
				"get_thread_replies",
				"get_shared_files",
			);
		}

		// Code search tools (search code, fetch files, list repo structure)
		if (state.hasRepoIntegration) {
			tools.push({
				type: "function",
				function: {
					name: "search_repository_code",
					description: `Search the project's repository for code matching a query. Returns file paths, matched snippets, and relevance scores.

Use this tool when you need to:
- Find specific functions, classes, or patterns in the codebase
- Understand how something is implemented
- Locate relevant source files for a feature or component

Examples:
- "authentication middleware"
- "getUserById function"
- "database migration schema"`,
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Search query — use specific terms, function names, or patterns",
							},
							path: {
								type: "string",
								description:
									"Filter results to a specific directory path (e.g., 'src/auth')",
							},
							language: {
								type: "string",
								description:
									"Filter by programming language (e.g., 'typescript', 'python')",
							},
							maxResults: {
								type: "number",
								description:
									"Maximum number of results (default: 10, max: 30)",
							},
						},
						required: ["query"],
					},
				},
			});
			tools.push({
				type: "function",
				function: {
					name: "get_repository_file",
					description: `Fetch the full content of a specific file from the project's repository. Use after search_repository_code to read the full source of a relevant file.`,
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description:
									"File path relative to repository root (e.g., 'src/auth/middleware.ts')",
							},
							branch: {
								type: "string",
								description:
									"Branch name (defaults to the repository's default branch)",
							},
						},
						required: ["path"],
					},
				},
			});
			tools.push({
				type: "function",
				function: {
					name: "list_repository_structure",
					description: `List the directory tree of the project's repository. Useful for understanding the project structure before searching for specific files.`,
					parameters: {
						type: "object",
						properties: {
							directory: {
								type: "string",
								description:
									"Filter to a specific directory (e.g., 'src/components'). Omit for full tree.",
							},
						},
						required: [],
					},
				},
			});
			boundToolNames.push(
				"search_repository_code",
				"get_repository_file",
				"list_repository_structure",
			);
		}

		// write_document_asset: persist a non-markdown artifact (HTML diagram,
		// SVG, etc.) produced by an active Anthropic Agent Skill as a
		// ProjectDocumentAsset. Execution handled server-side by tool_node.
		if (state.activeSkill && state.documentId) {
			tools.push({
				type: "function",
				function: {
					name: "write_document_asset",
					description: `Save a non-markdown artifact (HTML, SVG, binary) as a file attached to the current document. Use this ONLY when the active skill produces non-markdown output (for example, the architecture-diagram skill produces a self-contained HTML file).

After saving, reference the artifact in the markdown body with: <!-- asset:<filename> -->`,
					parameters: {
						type: "object",
						properties: {
							filename: {
								type: "string",
								description:
									"Artifact filename with extension, e.g. 'architecture-diagram.html'",
							},
							contentType: {
								type: "string",
								description:
									"MIME type, e.g. 'text/html', 'image/svg+xml'",
							},
							content: {
								type: "string",
								description:
									"Full file body. utf-8 text unless encoding is 'base64'.",
							},
							encoding: {
								type: "string",
								enum: ["utf-8", "base64"],
								description:
									"Content encoding. Defaults to utf-8 for text artifacts.",
							},
						},
						required: ["filename", "contentType", "content"],
					},
				},
			});
			boundToolNames.push("write_document_asset");
		}

		// NOTE: finalize mode deliberately does NOT rebind a reduced tool set
		// here. Tool definitions serialize ahead of the messages, inside the
		// provider's cacheable prefix, and `boundToolNames` also seeds
		// `recognizedToolNames` below — dropping tools would reshape the
		// sanitized history as well, so the final (largest) call of the run
		// would miss the cache twice over. The budget is enforced after the
		// invoke instead: see the finalize guard below, which rejects any call
		// outside `inlineToolNames` and only falls back to unbinding when the
		// model refuses to comply.

		// Eager-routing: deterministically force `create_view` when the
		// latest user message contains an explicit Excalidraw mention.
		//
		// Background: the project_document_generator's system prompt is
		// heavily biased toward document editing (PRD/Feature templates,
		// strict content-preservation rules). Even with the dedicated
		// "Diagrams (Excalidraw)" section appended above, in production
		// the LLM kept choosing `write_document_local` for prompts like
		// "Draw me onion architecture excalidraw diagram" — surfacing
		// `Confirm Changes` instead of the canvas (PR #897 follow-up
		// after the prompt nudge proved insufficient).
		//
		// This mirrors `applyDefaultMcpEagerRouting` in
		// `packages/temporal/src/workflows/orchestrator/phases/iterative-execution.ts`:
		// case-insensitive substring match on the user message, deterministic
		// `tool_choice` override. We only override when:
		//   (a) `create_view` is actually in the bound tools — guards against
		//       a misconfigured tenant where the action didn't reach this
		//       run via `state.copilotkit.actions`, and
		//   (b) the latest human message string-matches "excalidraw" —
		//       unambiguous intent signal. Other diagram synonyms ("draw",
		//       "chart", "flowchart") are intentionally NOT eager-matched
		//       here: they're too ambiguous (could refer to an inline
		//       Mermaid block, an explanation, or a sketch). For those,
		//       the system-prompt section above does the bias.
		//
		// The trade-off: when we force `create_view`, this turn produces
		// only the diagram — no concurrent `write_document_local`. The
		// agent's next turn (or a user follow-up) handles any document
		// updates the user also wanted. This is the right shape for the
		// reported failure mode where the user wants the diagram first.
		// Eager-routing for "excalidraw" prompts is now PROMPT-DRIVEN ONLY,
		// not tool_choice-forced.
		//
		// History:
		//   - PR #897 nudged the LLM toward `create_view` via the system
		//     prompt — insufficient at the time, so we added a deterministic
		//     `tool_choice` force when the user's latest message contained
		//     "excalidraw".
		//   - PR #1177 / #1183 then fought a series of compatibility issues
		//     with the force across providers:
		//       * Anthropic Direct: { thinking: enabled } + forced
		//         tool_choice returns HTTP 400 "Thinking may not be enabled
		//         when tool_choice forces tool use."
		//       * Vercel Gateway / Azure AI Foundry routing Claude (via
		//         ChatOpenAI / AzureChatOpenAI wrapper classes) hits the
		//         same Anthropic API rejection upstream.
		//       * OpenAI o-series + gpt-5 (reasoning families in
		//         `MODEL_FAMILIES` at `@repo/agent-core/services/
		//         langchain-models.ts:424-482`) don't 400 outright but
		//         forcing a tool bypasses their reasoning value-add and
		//         occasionally trips edge-case parallel_tool_calls or
		//         tool-choice validation.
		//
		// Rather than maintain a per-provider compatibility matrix that
		// has to be kept in sync with vendor API changes, drop the
		// `tool_choice` force entirely:
		//   1. The agent system prompt at lines ~1535-1542 above
		//      explicitly instructs the model to emit `<excalidraw-embed>`
		//      via `write_document_local` after `create_view` returns —
		//      that's a strong enough nudge for modern Claude / GPT-5 /
		//      o-series reasoning models.
		//   2. The `create_view` tool description in the bound tools array
		//      is unambiguous about WHEN to call it.
		//   3. The force was always a heuristic over substring "excalidraw"
		//      anyway — modern reasoning models pick the right tool from
		//      the prompt + tool descriptions without needing the override.
		//
		// We still walk the message history below to detect whether the
		// LLM has already produced output for this turn (the original
		// infinite-loop guard from PR #897). That guard is now informational
		// only — emitted in the log so we can tell from production traces
		// whether the prompt routing is doing the right thing on its own.
		const hasCreateViewTool = boundToolNames.includes("create_view");
		let alreadyToolCalledForCurrentTurn = false;
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const msg = state.messages[i];
			if (msg instanceof HumanMessage) {
				break;
			}
			const type =
				(msg as { _getType?: () => string })._getType?.() ??
				(msg as { type?: string }).type;
			if (
				type === "tool" ||
				type === "ai" ||
				type === "assistant" ||
				type === "function"
			) {
				alreadyToolCalledForCurrentTurn = true;
				break;
			}
		}

		let userMentionedExcalidraw = false;
		if (hasCreateViewTool && !alreadyToolCalledForCurrentTurn) {
			for (let i = state.messages.length - 1; i >= 0; i--) {
				const msg = state.messages[i];
				if (!(msg instanceof HumanMessage)) {
					continue;
				}
				const content = msg.content;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.map((c) =>
										typeof c === "object" &&
										c !== null &&
										"text" in c &&
										typeof (c as { text?: unknown })
											.text === "string"
											? (c as { text: string }).text
											: "",
									)
									.join(" ")
							: "";
				userMentionedExcalidraw = text
					.toLowerCase()
					.includes("excalidraw");
				break;
			}
		}

		if (userMentionedExcalidraw) {
			logger.info(
				"[Project Document Generator] Excalidraw mention detected — relying on prompt routing (no tool_choice force)",
				{
					hasCreateViewTool,
					model: providerConfig?.model,
					reason: "prompt-only-routing-supersedes-tool-choice-force",
				},
			);
		}

		// Bind tools WITHOUT a tool_choice force — see the long-form
		// explanation above for why. Briefly: per-provider compatibility
		// of forced tool_choice with reasoning toggles (Claude thinking,
		// OpenAI reasoning) is too fragile to maintain. The prompt is
		// authoritative. `parallel_tool_calls: false` is preserved because
		// it's a no-op for non-Anthropic providers and a sensible default
		// for Claude (we never want parallel calls in this orchestration).
		const modelWithTools = model.bindTools(tools, {
			parallel_tool_calls: false,
		} as Record<string, unknown>);

		logger.info("[Project Document Generator] Invoking model", {
			messageCount: state.messages.length,
			documentLength: state.document?.length || 0,
			documentType: state.documentType,
			retryCount: state.retryCount,
			boundTools: boundToolNames,
			hasTeamsIntegration: state.hasTeamsIntegration,
			hasSlackIntegration: state.hasSlackIntegration,
			model: providerConfig?.model || "(API fallback)",
		});

		// Build set of recognized tool names (graph tools + CopilotKit actions)
		// so sanitization preserves their tool call/response messages in history
		const recognizedToolNames = new Set(boundToolNames);

		// Sanitize messages: strip unknown tool artifacts, merge consecutive AI
		// messages to prevent Anthropic 400 errors from malformed CopilotKit history.
		// `providerConfig` (resolved at line ~1049) lets the sanitizer preserve
		// multimodal `HumanMessage` content for vision-capable tenant models
		// without changing behavior on text-only models.
		const filteredMessages = sanitizeMessagesForModel(
			state.messages,
			recognizedToolNames,
			providerConfig,
		);

		// Build message array: system prompt (instructions only) + optional document context + conversation
		const modelMessages: BaseMessage[] = [
			new SystemMessage({ content: contextualPrompt }),
		];

		// When editing, inject the document as a user message rather than
		// embedding it in the system prompt. This keeps the system prompt
		// small and cacheable, and puts data where it belongs — in user context.
		//
		// We wrap the body in a unique <fabric_source_document> tag rather than
		// a generic <document> tag, and we defensively neutralize any literal
		// occurrences of that tag inside the document body. Without this guard,
		// a document containing the literal closing tag would terminate the
		// wrapper early and leak its tail content into the instruction context.
		//
		// `documentContextMessageCount` records how many messages this block
		// contributes so `applyInputBudgetGate` can pin them: the document body
		// is the one thing in the history the model cannot do its job without,
		// and it sits at the FRONT — exactly where the gate's summarizer starts.
		let documentContextMessageCount = 0;
		if (isEditing && existingDocForPrompt) {
			const SOURCE_DOC_TAG = "fabric_source_document";
			const sanitizedDocument = existingDocForPrompt
				.replaceAll(`<${SOURCE_DOC_TAG}>`, `<${SOURCE_DOC_TAG}_>`)
				.replaceAll(`</${SOURCE_DOC_TAG}>`, `</${SOURCE_DOC_TAG}_>`);
			modelMessages.push(
				new HumanMessage({
					content: `Here is the current document you are editing:\n\n<${SOURCE_DOC_TAG}>\n${sanitizedDocument}\n</${SOURCE_DOC_TAG}>`,
				}),
			);
			modelMessages.push(
				new AIMessage({
					content:
						"I have the current document. I will make only the targeted changes you request while preserving all other content.",
				}),
			);
			documentContextMessageCount = 2;
		}

		// If we extracted any image data URLs above, swap the last HumanMessage
		// for a multimodal one carrying both the user's original text and
		// `image_url` content parts for each image. We do NOT gate on a model
		// whitelist here — the tenant's configured model is the source of
		// truth, and a non-vision model will surface a clear API error rather
		// than silently dropping the image (which is what was happening
		// before this change). Most modern provider/model combinations the
		// platform supports accept `image_url` content parts.
		const messagesWithImages: BaseMessage[] = [...filteredMessages];
		if (pendingImages.length > 0) {
			let lastHumanIdx = -1;
			for (let i = messagesWithImages.length - 1; i >= 0; i--) {
				if (getMessageType(messagesWithImages[i]) === "human") {
					lastHumanIdx = i;
					break;
				}
			}
			const baseText =
				lastHumanIdx >= 0
					? typeof messagesWithImages[lastHumanIdx].content ===
						"string"
						? (messagesWithImages[lastHumanIdx].content as string)
						: ""
					: "";
			const multimodal = new HumanMessage({
				content: [
					{
						type: "text",
						text: baseText || "(see attached images)",
					},
					...pendingImages.map((img) => ({
						type: "image_url" as const,
						image_url: { url: img.dataUrl },
					})),
				],
			});
			if (lastHumanIdx >= 0) {
				messagesWithImages[lastHumanIdx] = multimodal;
			} else {
				messagesWithImages.push(multimodal);
			}
		}

		modelMessages.push(...messagesWithImages);

		if (pendingImages.length > 0) {
			// Filenames are user-supplied and may contain customer/ticket
			// context — keep this log to non-sensitive fields only.
			logger.info("[Project Document Generator] Image attachment", {
				imagesAttached: pendingImages.length,
				modelId: providerConfig?.model || "(unset)",
			});
		}

		// Safety net: if the assembled prompt is too large (e.g. many tool
		// calls each returning the max excerpt payload), compress older
		// tool exchanges via the SIMPLE-task model before invocation.
		const gatedMessages = await applyInputBudgetGate(
			modelMessages,
			runnableConfig,
			{ pinnedPrefixCount: documentContextMessageCount },
		);

		// Finalize mode carries its instruction here, appended AFTER both the
		// sanitizer and the input-budget gate so neither pass can trim or
		// reshape it, and only onto this local array — never onto
		// `state.messages` (see `buildFinalizeDirectiveMessage`). Everything
		// ahead of it — tool definitions, system message, full history — is
		// byte-identical to the previous round, which is the point: this is
		// the largest call of the run and it has to hit the provider's prompt
		// cache (issue #2999).
		const finalizeDirective = finalizeMode
			? buildFinalizeDirectiveMessage({ toolRounds, patchModeAvailable })
			: undefined;
		const invokeMessages: BaseMessage[] = finalizeDirective
			? [...gatedMessages, finalizeDirective]
			: gatedMessages;

		lastRequestShape = summarizeMessagesForLogging(invokeMessages);

		// Invoke the model. Provider errors propagate as-is; the frontend
		// interceptor (CopilotFetchErrorInterceptor) surfaces them as toasts.
		const turnStart = Date.now();
		let response = await modelWithTools.invoke(
			invokeMessages,
			runnableConfig,
		);
		await logAgentUsageFromRunnableConfig(runnableConfig, response, {
			taskType: "TOOL_CALLING",
			agentId: "project_document_generator",
			latencyMs: Date.now() - generationStart,
			projectId: state.projectId || undefined,
		});

		// Lift the gateway's stop/finish reason out of the raw response envelope
		// (before `stripRawResponseEnvelope` removes it further down) so both the
		// truncation-recovery retry immediately below and the `finishReason`
		// logged after it see it even on gateways whose `response_metadata` omits
		// it — see `hoistRawStopReason` in @repo/agent-core/output-truncation.
		hoistRawStopReason(response);

		// === Finalize guard (issue #2999) ===
		// Keeping the full tool set bound above preserves the prompt cache, but
		// it also leaves the research tools physically callable on the turn
		// whose whole point is that the budget is gone. Unchecked, such a call
		// would reach `shouldContinue`, which counts one round past the budget
		// and forces __end__ — ending the run with a dangling tool call and no
		// document. Enforce the budget here instead: reject the call, hand the
		// model an error result, and let it spend the turn writing.
		//
		// The rejection transcript is EPHEMERAL. Only the finally accepted
		// response is returned from this node, so a refused attempt never
		// reaches `state.messages` and never becomes history for a later turn.
		//
		// Set when a terminal finalize invocation produced nothing but a call it
		// had to strip — read by the terminal error branch far below, which
		// cannot re-derive it once the offending call is gone.
		let finalizeGuardLeftNothing = false;
		const allowedFinalizeTools = new Set(inlineToolNames);
		const disallowedIn = (candidate: AIMessage): string[] =>
			disallowedToolCallNames(candidate, allowedFinalizeTools);

		// The treatment every TERMINAL finalize invocation gets — the guard's
		// inline-only fallback below, and the truncation-recovery retry, which
		// also binds inline tools only and also replaces `response` with no
		// further round trip available.
		//
		// Strips unconditionally (a no-op on a clean response, so it cannot
		// depend on detection having fired), and if that leaves nothing at all,
		// flags the terminal error rather than letting an empty response fall
		// through to the ordinary "no tool call" branch, which would end the run
		// reporting success with the document never written.
		const applyFinalizeTerminalGuard = (source: string): void => {
			const hallucinated = disallowedIn(response);
			if (hallucinated.length > 0) {
				logger.warn(
					"[Project Document Generator] Finalize guard — terminal invocation returned a tool that was not bound; stripping the call before it is persisted",
					{ source, strippedTools: hallucinated, toolRounds },
				);
			}
			response = stripDisallowedToolCalls(
				response,
				allowedFinalizeTools,
			) as typeof response;

			if (hallucinated.length > 0 && isEmptyModelResponse(response)) {
				logger.error(
					"[Project Document Generator] Finalize guard — terminal invocation produced nothing but a rejected tool call; ending the run with a user-facing error",
					{
						source,
						strippedTools: hallucinated,
						stopReason: resolveStopReason(response),
						toolRounds,
					},
				);
				finalizeGuardLeftNothing = true;
			}
		};

		if (finalizeMode) {
			let guardMessages: BaseMessage[] = invokeMessages;
			let guardAttempts = 0;

			while (
				disallowedIn(response).length > 0 &&
				guardAttempts < MAX_FINALIZE_GUARD_RETRIES
			) {
				const disallowed = disallowedIn(response);
				const shapes = readToolCallShapes(response);
				const attemptedCalls = shapes.normalized;

				// The transcript retry replays the assistant message and answers
				// each of its calls with a `ToolMessage` addressed by
				// `tool_call_id`. It is only safe when EVERY call the replayed
				// message carries, in any shape, can be answered — an
				// unanswered call, or a result addressed to an id that is not
				// there, is a 400 on both wire shapes, and that request would
				// fail before the fallback ever ran.
				//
				// Three conditions, checked by call IDENTITY rather than by
				// name — two raw-lane calls can share a name while only one is
				// mirrored into `tool_calls`, and answering that one leaves the
				// other dangling:
				//   1. every disallowed NAME also appears among the normalized
				//      calls (nothing disallowed lives only in a raw or content
				//      lane, where there is no normalized call to address);
				//   2. every normalized call carries a usable id, since each
				//      gets a result;
				//   3. every raw-/content-lane call id is one of those
				//      normalized usable ids — the ordinary mirroring case,
				//      where a provider populates two shapes for ONE call,
				//      passes; an extra or id-less mirrored call does not.
				// Any failure means fall back instead, which sends no tool
				// results at all and is therefore always safe.
				const normalizedDisallowedNames = new Set(
					attemptedCalls
						.map(readToolCallName)
						.filter((name) => !allowedFinalizeTools.has(name)),
				);
				const mirroredCalls = [...shapes.raw, ...shapes.contentBlocks];
				const unaddressableNames = mirroredCalls
					.map(readToolCallName)
					.filter(
						(name) =>
							!allowedFinalizeTools.has(name) &&
							!normalizedDisallowedNames.has(name),
					);
				const hasUnusableId = attemptedCalls.some(
					(tc) => !hasUsableToolCallId(tc.id),
				);
				const normalizedCallIds = new Set(
					attemptedCalls
						.map((tc) => tc.id)
						.filter(hasUsableToolCallId),
				);
				const unmirroredCallIds = mirroredCalls
					.map((call) => call.id)
					.filter(
						(id) =>
							!hasUsableToolCallId(id) ||
							!normalizedCallIds.has(id),
					);
				if (
					unaddressableNames.length > 0 ||
					hasUnusableId ||
					unmirroredCallIds.length > 0
				) {
					logger.warn(
						"[Project Document Generator] Finalize guard — rejected call cannot be answered with a tool result; skipping the retry transcript and falling back directly",
						{
							disallowedTools: disallowed,
							unaddressableTools: unaddressableNames,
							hasUnusableId,
							unmirroredCallCount: unmirroredCallIds.length,
							attemptedToolCount: attemptedCalls.length,
							toolRounds,
						},
					);
					break;
				}
				const identifiedCalls = attemptedCalls as unknown as Array<{
					id: string;
					name: string;
				}>;

				guardAttempts++;

				logger.warn(
					"[Project Document Generator] Finalize guard — rejecting research tool call made after the tool budget was spent",
					{
						attempt: guardAttempts,
						maxAttempts: MAX_FINALIZE_GUARD_RETRIES,
						disallowedTools: disallowed,
						toolRounds,
					},
				);

				// Every call in the response needs a result, not just the
				// disallowed ones: an AI tool_call left unanswered is a 400 on
				// both the Anthropic and OpenAI-compatible wire shapes.
				const rejectionResults = identifiedCalls.map(
					(tc) =>
						new ToolMessage({
							content: allowedFinalizeTools.has(tc.name)
								? `Error: not executed — this turn was rejected because it also called ${disallowed[0] ?? "an unavailable tool"}, which is no longer available. Re-issue this call on its own, without any research tools.`
								: `Error: ${tc.name} is no longer available — the research budget for this turn is exhausted. Produce the final document now using only information already gathered.`,
							tool_call_id: tc.id,
							name: tc.name,
							status: "error",
						}),
				);

				guardMessages = [
					...guardMessages,
					response,
					...rejectionResults,
					// Re-state the directive after the error results so it is
					// again the last thing the model reads.
					buildFinalizeDirectiveMessage({
						toolRounds,
						patchModeAvailable,
					}),
				];

				lastRequestShape = summarizeMessagesForLogging(guardMessages);
				response = await modelWithTools.invoke(
					guardMessages,
					runnableConfig,
				);
				await logAgentUsageFromRunnableConfig(
					runnableConfig,
					response,
					{
						taskType: "TOOL_CALLING",
						agentId: "project_document_generator:finalize_guard",
						latencyMs: Date.now() - generationStart,
						projectId: state.projectId || undefined,
					},
				);
				hoistRawStopReason(response);
			}

			// Still disobedient after the retry budget (or the call could not be
			// answered with a tool result): fall back to making the research
			// tools physically
			// unavailable — bind the inline set only and say so in the system
			// message. That request has a different prefix and is billed
			// uncached, which is exactly the cost this change exists to avoid;
			// it is paid only on the rare turn where a model refuses to
			// finalize, instead of on every run.
			//
			// This reproduces the OLD finalize path's binding and system prompt,
			// but deliberately NOT its history: the old path also re-sanitized
			// the messages against the inline-only tool set, which stripped
			// tool_calls off earlier AI turns and folded their orphaned results
			// into human text. That reshaping was itself one of the three
			// cache-invalidation vectors this change removes, and it buys
			// nothing on the wire — a historical tool call paired with its
			// result is valid on both the Anthropic and OpenAI-compatible
			// shapes whether or not that tool is currently bound. So the
			// full-set-sanitized history is sent as-is.
			if (disallowedIn(response).length > 0) {
				logger.warn(
					"[Project Document Generator] Finalize guard exhausted — falling back to an inline-tools-only invocation",
					{
						disallowedTools: disallowedIn(response),
						guardAttempts,
						toolRounds,
					},
				);

				const fallbackModelWithTools = model.bindTools(inlineTools, {
					parallel_tool_calls: false,
				} as Record<string, unknown>);
				const fallbackMessages: BaseMessage[] = [
					new SystemMessage({
						content: `${contextualPrompt}\n\n---\n\n## Research Budget Exhausted\n\nYou have used your available tool-calling budget for this turn (${toolRounds} rounds). Search, browse, and lookup tools are no longer available. Do NOT attempt to call them. Produce your final ${patchModeAvailable ? "edit (apply_document_patches or write_document_local)" : "document (write_document_local)"} now using only the information you have already gathered.`,
					}),
					...gatedMessages.slice(1),
				];

				lastRequestShape =
					summarizeMessagesForLogging(fallbackMessages);
				response = await fallbackModelWithTools.invoke(
					fallbackMessages,
					runnableConfig,
				);
				await logAgentUsageFromRunnableConfig(
					runnableConfig,
					response,
					{
						taskType: "TOOL_CALLING",
						agentId:
							"project_document_generator:finalize_guard_fallback",
						latencyMs: Date.now() - generationStart,
						projectId: state.projectId || undefined,
					},
				);
				hoistRawStopReason(response);

				// The fallback is terminal — there is no further re-invoke to
				// make. If the model called a research tool anyway, that call
				// is dropped rather than persisted (a dangling call is what
				// ends the run without a document); whatever text or allowed
				// call came with it still stands.
				applyFinalizeTerminalGuard("guard_fallback");
			}
		}

		// === Truncation recovery (issue #2976) ===
		// A reasoning-capable model served through a gateway bills its invisible
		// thinking against the same output budget as the visible answer. After a
		// long tool loop the accumulated input is large, thinking scales with it,
		// and the budget can be gone before a single visible token is emitted:
		// the turn comes back truncated with no content AND no tool calls. Left
		// alone that falls through to the "no tool call" branch far below, which
		// ends the run reporting success while the document is untouched.
		//
		// Retry ONCE, changing both sides of the squeeze — a same-budget retry is
		// deterministic and reproduces the same truncation (reproduced twice in
		// production on consecutive attempts):
		//   1. Roughly double the output budget, above the normal ceiling.
		//      `resolveOutputTokenBudget` still clamps to the model's catalog cap.
		//   2. Force the input-budget gate so the accumulated tool-result history
		//      is summarized down, pinning the document body. Less input is less
		//      invisible thinking, which is the term that overflowed.
		//   3. Bind only the inline tools (the same set finalize mode uses), so
		//      the model spends the retry writing the document instead of opening
		//      another round of repository exploration it cannot afford.
		//
		// The FAILED attempt's reasoning trace is extracted before `response` is
		// replaced. That trace is the only record of what the model spent its
		// entire budget thinking about — precisely the evidence this incident
		// class needs — and the response object holding it is discarded here,
		// never appended to `messages`. `carriedReasoningUpdate` feeds the main
		// capture below as prior in-turn context, so the two attempts coalesce
		// into one entry instead of the second overwriting the first.
		let carriedReasoningUpdate: ReturnType<typeof buildReasoningUpdate> =
			{};
		if (isEmptyModelResponse(response) && isOutputTruncated(response)) {
			carriedReasoningUpdate = buildReasoningUpdate({
				response,
				existingByTurn: state.reasoningByTurn,
				stateMessages: state.messages,
				turnStart,
				loggerLabel: "[Project Document Generator]",
			});

			const retryBaseMaxTokens = baseMaxTokens * 2;
			logger.warn(
				"[Project Document Generator] Empty truncated response — retrying once with an escalated output budget and compressed history",
				{
					stopReason: resolveStopReason(response),
					previousBaseMaxTokens: baseMaxTokens,
					previousCeiling: NORMAL_OUTPUT_TOKEN_CEILING,
					retryBaseMaxTokens,
					retryCeiling: TRUNCATION_RETRY_OUTPUT_TOKEN_CEILING,
					usage: response.usage_metadata,
					messageCount: state.messages.length,
				},
			);

			const retryModel = await getAgentModelAsync(config, {
				temperature: 0.5,
				maxTokens: Math.min(
					TRUNCATION_RETRY_OUTPUT_TOKEN_CEILING,
					retryBaseMaxTokens,
				),
				maxTokensForConfig: (resolvedConfig: ProviderConfig) =>
					Math.min(
						TRUNCATION_RETRY_OUTPUT_TOKEN_CEILING,
						retryBaseMaxTokens +
							reasoningOutputAllowanceForConfig(resolvedConfig) *
								2,
					),
				retryCount: state.retryCount,
				taskType: "TOOL_CALLING",
			});
			if (!retryModel.bindTools) {
				throw new Error(
					"[Project Document Generator] Model does not support tool binding",
				);
			}
			const retryModelWithTools = retryModel.bindTools(inlineTools, {
				parallel_tool_calls: false,
			} as Record<string, unknown>);

			// Same instruction finalize mode appends when the research budget is
			// spent — the retry binds the same reduced tool set, so the model has
			// to be told the search tools are gone rather than discovering it.
			const retryMessages = await applyInputBudgetGate(
				[
					new SystemMessage({
						content: `${contextualPrompt}\n\n---\n\n## Output Budget Exceeded — Finalize Now\n\nYour previous response was cut off by the output-token limit before it produced anything. Search, browse, and lookup tools are no longer available for this turn. Do NOT attempt to call them. Produce your final ${patchModeAvailable ? "edit (apply_document_patches or write_document_local)" : "document (write_document_local)"} now using only the information you have already gathered, and keep any accompanying prose short.`,
					}),
					...modelMessages.slice(1),
				],
				runnableConfig,
				{
					force: true,
					pinnedPrefixCount: documentContextMessageCount,
				},
			);

			lastRequestShape = summarizeMessagesForLogging(retryMessages);
			response = await retryModelWithTools.invoke(
				retryMessages,
				runnableConfig,
			);
			await logAgentUsageFromRunnableConfig(runnableConfig, response, {
				taskType: "TOOL_CALLING",
				agentId: "project_document_generator:truncation_retry",
				latencyMs: Date.now() - generationStart,
				projectId: state.projectId || undefined,
			});
			hoistRawStopReason(response);

			logger.warn(
				"[Project Document Generator] Truncation-recovery retry completed",
				{
					stopReason: resolveStopReason(response),
					recovered: !isEmptyModelResponse(response),
					toolCallCount: response.tool_calls?.length || 0,
					messagesSent: retryMessages.length,
					usage: response.usage_metadata,
				},
			);

			// On a finalize turn this retry REPLACED the response the guard
			// above already vetted, and it is itself terminal — no further
			// round trip is available. It binds the inline tools only, but a
			// bound tool list is a request and not a schema, so give the
			// replacement the same terminal treatment the guard's fallback
			// gets. Without this a research call the retry hallucinated would
			// be persisted unchecked: `shouldContinue` counts round 21 and
			// force-ends with a dangling call and no document, and a call
			// carried only in the raw lane would slip through to the "no tool
			// call" branch as a silent success. Non-finalize turns are
			// untouched — there is no budget to enforce on them.
			if (finalizeMode) {
				applyFinalizeTerminalGuard("truncation_retry");
			}
		}

		// This agent's model only emits write_document_local, so it signals a
		// clarifying question as a structured `clarifying-question` block in its
		// text content rather than calling the HITL ask_clarifying_question tool.
		// Synthesize the tool call ONTO the model's response here so it flows
		// through the exact same external frontend-tool path as select_meetings /
		// confirm_changes below (no goto; shouldContinue routes to END and
		// CopilotKit renders the card and *waits*). Emitting it instead from the
		// no-tool-call branch with goto:END made CopilotKit re-invoke the agent
		// while the card was pending, producing duplicate cards.
		if (!response.tool_calls || response.tool_calls.length === 0) {
			const clarifying = extractClarifyingQuestion(
				extractTextFromContent(response.content),
			);
			if (clarifying) {
				(response as { tool_calls?: unknown }).tool_calls = [
					{
						id: uuidv4(),
						name: "ask_clarifying_question",
						args: {
							question: clarifying.question,
							options: clarifying.options,
						},
						type: "tool_call" as const,
					},
				];
				// The card fully represents the question; drop the raw block text
				// so it is not also shown as message content above the card.
				(response as { content?: unknown }).content = "";
				logger.info(
					"[Project Document Generator] Synthesized ask_clarifying_question tool call from model clarifying-question block",
					{ optionCount: clarifying.options.length },
				);
			}
		}

		// Deterministically stamp the active org id onto any `<excalidraw-embed>`
		// the model emitted in an inline document tool call. The persisted
		// document content IS these tool-call args, and the editor's later scene
		// fetch (`read_checkpoint`) is tenant-scoped — without `data-organization-id`
		// it runs in personal context and 404s ("Couldn't display this diagram").
		// The system prompt asks the model to copy the org id, but this guarantees
		// it regardless of model behavior. No-op in personal context
		// (organizationId undefined) and idempotent when the model already wrote
		// a correct id.
		if (state.organizationId && Array.isArray(response.tool_calls)) {
			for (const toolCall of response.tool_calls) {
				if (
					(toolCall.name === "write_document_local" ||
						toolCall.name === "apply_document_patches") &&
					toolCall.args
				) {
					toolCall.args = injectOrgIdIntoToolArgs(
						toolCall.args,
						state.organizationId,
					);
				}
			}
		}

		// The gateway's stop/finish reason was already lifted out of the raw
		// response envelope right after each invocation above (the
		// truncation-recovery retry has to read it before this point), so the
		// `finishReason` field logged below and the truncation checks later in
		// this node see it even on gateways whose `response_metadata` omits it.
		// See hoistRawStopReason in @repo/agent-core/output-truncation.
		logger.info("[Project Document Generator] Model response received", {
			hasToolCalls:
				!!response.tool_calls && response.tool_calls.length > 0,
			toolCallCount: response.tool_calls?.length || 0,
			toolNames: response.tool_calls?.map((tc: any) => tc.name) || [],
			hasContent: !!response.content,
			contentPreview:
				typeof response.content === "string"
					? response.content.substring(0, 200)
					: JSON.stringify(response.content)?.substring(0, 200),
			// A turn with no content and no tool calls is otherwise
			// indistinguishable from one whose call was truncated at the
			// output-token cap — LangChain parks a cut-off call in
			// `invalid_tool_calls`, which nothing else here reads.
			//
			// `resolveStopReason` is the shared reader — it already knows the
			// three provider shapes (Anthropic `stop_reason`, Chat Completions
			// `finish_reason`, Responses-API `incomplete_details.reason`) and is
			// the same helper the truncation fail-fast below uses, so the logged
			// reason and the retry decision can never disagree.
			//
			// `responseMetadataKeys` stays because a real turn on the Databricks
			// gateway came back with `response_metadata` holding only
			// `model_provider` and `usage` — no stop reason under any of those
			// names. When the reason is absent this names what the provider did
			// return, so the next person reads a log instead of deploying again.
			finishReason: resolveStopReason(response),
			responseMetadataKeys: Object.keys(response.response_metadata ?? {}),
			usage: response.usage_metadata,
			invalidToolCallCount: response.invalid_tool_calls?.length || 0,
			invalidToolCallNames:
				response.invalid_tool_calls?.map((tc: any) => tc.name) || [],
		});

		// Update messages with response (includes any summary in response.content).
		// NOTE: `response` is appended by reference — any mutation below (e.g. the
		// __raw_response cleanup after extraction) also propagates into this array.
		const messages = [...state.messages, response];

		// === Reasoning capture ===
		// Single-call helper from `@repo/agent-core/reasoning-trace` — reads
		// thinking/reasoning blocks from response.content first
		// (ANTHROPIC_DIRECT + OPENAI_DIRECT shapes), falls back to
		// additional_kwargs.__raw_response.choices[0].{message,delta}.reasoning
		// (Vercel Gateway shape, both non-streaming and streaming converter
		// shapes — see langchain-models.ts GATEWAY_PROVIDERS branch which sets
		// __includeRawResponse: true for Claude 4.x via Vercel gateways), then
		// coalesces with any prior in-turn reasoning text. Returns `{}` when
		// there's nothing to emit, so the spread is a no-op at the 4 sites
		// below.
		//
		// Ordering matters: buildReasoningUpdate MUST run BEFORE
		// stripRawResponseEnvelope — see protocol P1 in emit.ts JSDoc.
		//
		// `existingByTurn` carries the truncation-recovery retry's discarded
		// first attempt (see `carriedReasoningUpdate` above) so its reasoning is
		// prepended rather than lost. When the retry emits no reasoning of its
		// own, `buildReasoningUpdate` returns `{}` — fall back to the carried
		// update so the failed attempt's trace still reaches the UI. Both are
		// `{}` on an ordinary turn, so this is a no-op there.
		const responseReasoningUpdate = buildReasoningUpdate({
			response,
			existingByTurn:
				carriedReasoningUpdate.reasoningByTurn ?? state.reasoningByTurn,
			stateMessages: state.messages,
			turnStart,
			loggerLabel: "[Project Document Generator]",
		});
		const reasoningByTurnUpdate = responseReasoningUpdate.reasoningByTurn
			? responseReasoningUpdate
			: carriedReasoningUpdate;
		stripRawResponseEnvelope(response);

		if (reasoningByTurnUpdate.reasoningByTurn) {
			const turnIndex = countHumanMessages(state.messages);
			const entry = reasoningByTurnUpdate.reasoningByTurn[turnIndex];
			logger.info("[Project Document Generator] Reasoning emitted", {
				turnIndex,
				textLength: entry?.text.length ?? 0,
				durationMs: entry?.durationMs ?? 0,
				model: providerConfig?.model || "(unset)",
			});
		}
		// === End reasoning capture ===
		// `reasoningByTurnUpdate` is now in scope for Sites A, B, and the
		// buildConfirmChangesCommand call sites below.

		// === Tool-call trace capture (follow-up to F-1171) ===
		// Build a per-turn tool-call delta keyed by the same turnIndex used for
		// reasoningByTurn. Empty object when nothing changes so it spreads
		// cleanly into Command.update with no effect.
		//
		// Logic (see chat-node-tools.ts `reconcileToolCalls`):
		//   1. Resolve any existing pending entries whose matching ToolMessage
		//      now lives in state.messages (set status, durationMs, errorMessage).
		//   2. Append a new pending entry for every tool_call on the freshly
		//      returned AIMessage (deduped by id against existing entries).
		//
		// Note: reconcile reads from state.messages (the incoming snapshot,
		// pre-response) — NOT from the local `messages` variable which already
		// includes the new response. Pending entries match ToolMessages that
		// arrived from the previous tool_node hop; new pending entries reflect
		// the model's intent in THIS response.
		let toolCallsByTurnUpdate: Record<string, unknown> = {};
		{
			const turnIndexForTools = countHumanMessages(state.messages);
			if (turnIndexForTools >= 1) {
				const existingForTurn =
					state.toolCallsByTurn?.[turnIndexForTools];
				// Track only the FIRST tool call from the response. chat-node
				// asks the model for parallel_tool_calls: false (line ~2092)
				// and only branches on response.tool_calls[0] below. Inline
				// tools (write_document_local, apply_document_patches) route
				// through buildConfirmChangesCommand which synthesizes a
				// matching ToolMessage only for [0] — entries for [1..n]
				// would never reach a resolution path and would stay
				// permanently pending as phantom rows in the UI trace.
				// External (server-side) parallel calls are extremely rare
				// under parallel_tool_calls: false; losing trace fidelity
				// for that niche degenerate case is the right tradeoff
				// vs the user-visible "spinner forever" symptom.
				const callsToTrack = response.tool_calls?.slice(0, 1);
				const now = Date.now();
				const reconciled = reconcileToolCalls(
					existingForTurn,
					state.messages,
					callsToTrack,
					now,
				);
				// NOTE: do NOT flip inline tools (write_document_local /
				// apply_document_patches) to `success` here. The design
				// intent — covered by the chat-node test
				// "flows toolCallsByTurnUpdate through
				// buildConfirmChangesCommand on write_document_local
				// (extraStateUpdate spread)" — is that the entry stays
				// `pending` until the user accepts the confirm_changes
				// modal. Pre-resolving here would lie about state: a
				// green check would appear before the user has approved
				// (or rejected) the proposed changes.
				//
				// Resolution happens in the POST-CONFIRMATION HANDLING
				// branch at the top of `chatNode` (~L1018): when
				// chat-node re-enters with the confirm_changes
				// ToolMessage already in state.messages, that branch
				// updates the same `toolCallsByTurn[turnIndex]` entry
				// to `success` (accepted) or `error` with errorMessage
				// "User rejected the proposed changes" (rejected),
				// keeping the trace honest end-to-end.
				//
				// The UI render side (ReasoningCollapsible.tsx) treats
				// `pending` for these two tool names specially — static
				// Clock icon + "awaiting" trailing text + tooltip "name
				// — awaiting your confirmation" — so the user sees the
				// correct affordance during the review window instead
				// of a spinning Loader2 that implies in-flight work.
				if (reconciled.length > 0) {
					toolCallsByTurnUpdate = {
						toolCallsByTurn: {
							[turnIndexForTools]: reconciled,
						},
					};
					logger.info(
						"[Project Document Generator] Tool-call trace emitted",
						{
							turnIndex: turnIndexForTools,
							totalEntries: reconciled.length,
							pendingCount: reconciled.filter(
								(e) => e.status === "pending",
							).length,
							successCount: reconciled.filter(
								(e) => e.status === "success",
							).length,
							errorCount: reconciled.filter(
								(e) => e.status === "error",
							).length,
						},
					);
				}
			}
		}
		// === End tool-call trace capture ===

		// Handle tool calls
		if (response.tool_calls && response.tool_calls.length > 0) {
			const toolCall = response.tool_calls[0];

			// Intercept a model-initiated bare `confirm_changes` call. The
			// legitimate synthetic confirm is produced only by
			// buildConfirmChangesCommand — on the write/patch dispatch path,
			// never here on the raw model-response path — and always stamps
			// `args.__inlineTool`. A `confirm_changes` arriving here was emitted
			// by the model itself (no `__inlineTool` marker) without ever writing
			// a document, so letting it through would render an accept/reject
			// card for changes that never happened; accepting it saves the
			// unchanged baseline (a silent no-op). Reply in plain text and end
			// the run instead. `response` is intentionally dropped from the
			// returned messages so its `confirm_changes` tool call never enters
			// state — the transport emits frontend tool calls by scanning
			// state.messages, so the card would otherwise still render. The
			// model's own commentary is preserved as the reply text.
			//
			// This is distinct from the post-confirmation re-entry handling at
			// the top of chatNode: that branch fires before any model call and
			// processes the confirm *result* after a real user decision. This
			// interception fires only on a fresh model response that *emits* the
			// call.
			if (
				toolCall.name === "confirm_changes" &&
				!toolCall.args?.__inlineTool
			) {
				const modelCommentary = extractTextFromContent(
					response.content,
				).trim();
				const replyText =
					modelCommentary.length > 0
						? modelCommentary
						: NO_DOCUMENT_CHANGES_NOTICE;
				logger.info(
					"[Project Document Generator] Intercepted model-initiated confirm_changes (suppressed frontend card)",
					{
						usedModelCommentary: modelCommentary.length > 0,
						replyLength: replyText.length,
					},
				);
				return new Command({
					goto: END,
					update: {
						messages: [
							...state.messages,
							new AIMessage({ content: replyText }),
						],
						error: undefined,
						...reasoningByTurnUpdate,
					},
				});
			}

			if (toolCall.name === "write_document_local") {
				if (!toolCall.args || !toolCall.args.document) {
					const truncated = isOutputTruncated(response);
					logger.error(
						"[Project Document Generator] Invalid tool call arguments",
						{
							toolCall,
							retryCount: state.retryCount,
							stopReason: resolveStopReason(response),
						},
					);
					return buildInvalidToolArgsRetry({
						state,
						messages,
						toolCall,
						correctionContent:
							'ERROR: Your write_document_local call had empty arguments. You MUST include the "document" parameter with the full document content as a markdown string. Please try again and include the document content.',
						exhaustedMessage:
							"The AI model was unable to generate the document after multiple attempts. Please try again or use a different model.",
						truncated,
						truncatedMessage:
							"The document is too large for the AI model's output limit, so it could not return the full content. Try asking for a smaller, targeted edit, or switch to a model with a larger output limit.",
					});
				}

				// Strip any tool definitions that may have leaked into the document.
				// CopilotKit's internal tool format sometimes gets echoed by the model.
				// Passing the pre-edit baseline lets stripToolDefinitions distinguish
				// user-authored strikethrough (already in the baseline, preserved) from
				// model "deletion marker" strikethrough (new, stripped).
				//
				// IMPORTANT: use `preEditDocument` (snapshotted at node entry), NOT
				// `state.document`, because `predict_state` may have streamed the
				// model's tool args into `state.document` by now.
				const rawDocument = toolCall.args.document;
				// Repair the structural markdown degradations models produce in
				// lower sections under heavy context — flattened sub-bullets,
				// sentence continuations split into their own bullets, a bold
				// marker split across a bullet boundary, glued labels, split
				// Open Questions. Deterministic and behaviour-preserving; runs
				// before validation so the model isn't retried for damage the
				// repair already fixed.
				const document = repairDegradedMarkdown(
					stripToolDefinitions(rawDocument, preEditDocument),
				);

				// Structural sanity check on the whole document, backed by an
				// mdast AST traversal. Catches: literal `**` in text nodes
				// (any bold malformation — odd parity, no-word content,
				// internal whitespace, end-of-line markers, cross-paragraph
				// spans), unclosed code fences, unbalanced inline backticks,
				// orphan list markers, stray `)` / `]` / `}` on their own
				// line, severed sentences (`;,:?!` leading a line), bold
				// followed by uppercase word with no separator, and mixed
				// list markers (`- 2. ...`). Without this, write-mode
				// silently accepts malformed markdown that patch-mode would
				// have rejected.
				const structureDefect = validateMarkdownStructure(document);
				if (structureDefect) {
					const truncated = isOutputTruncated(response);
					logger.warn(
						"[Project Document Generator] write_document_local content rejected",
						{
							code: structureDefect.code,
							detail: structureDefect.detail,
							documentLength: document.length,
							retryCount: state.retryCount,
							stopReason: resolveStopReason(response),
						},
					);
					// A truncated generation also produces structure defects like
					// unclosed code fences — retrying is equally futile here.
					return buildInvalidToolArgsRetry({
						state,
						messages,
						toolCall,
						correctionContent:
							`Your write_document_local document is malformed: ${structureDefect.detail}.\n\n` +
							"Re-emit the entire document with: every `**` paired around word content on a single paragraph (e.g. `**Bold**`, not `** Bold **`, `**Bold**Body`, or `User **\\nStory**`); every ``` code fence closed; every inline backtick paired; no orphan list markers (a line that is only `- ` or `1. `); no stray closing bracket on its own line; no line beginning with `;`, `,`, `:`, `?`, or `!` (those signal split prose — join the punctuation back to the previous sentence).",
						exhaustedMessage:
							"The AI model produced malformed markdown after multiple attempts. Please try again or use a different model.",
						truncated,
						truncatedMessage:
							"The document is too large for the AI model's output limit, so it could not return the full content. Try asking for a smaller, targeted edit, or switch to a model with a larger output limit.",
					});
				}

				logger.info("[Project Document Generator] Document written", {
					documentLength: document.length,
					mode: "write",
				});

				// Reject-and-retry if the rewrite dropped or gutted a section the
				// user didn't ask to remove (whole-document guards above miss a
				// single collapsed section). On retry-exhaustion it proceeds with
				// a partial-completion warning.
				const writeSectionGuard = evaluateSectionPreservation({
					state,
					messages,
					toolCall,
					baselineDocument: preEditDocument,
					document,
					mode: "write",
				});
				if (writeSectionGuard.action === "retry") {
					return writeSectionGuard.command;
				}

				return buildConfirmChangesCommand({
					state,
					messages,
					toolCall,
					document,
					baselineDocument: preEditDocument,
					response,
					focusAnchor: toolCall.args.focusAnchor,
					logMode: "write",
					sectionWarning: writeSectionGuard.warning,
					extraStateUpdate: {
						...reasoningByTurnUpdate,
						...toolCallsByTurnUpdate,
					},
				});
			}

			if (toolCall.name === "apply_document_patches") {
				const patches = toolCall.args?.patches as
					| DocumentPatch[]
					| undefined;

				if (!Array.isArray(patches) || patches.length === 0) {
					const truncated = isOutputTruncated(response);
					logger.error(
						"[Project Document Generator] apply_document_patches called with empty patches",
						{
							toolCall,
							retryCount: state.retryCount,
							stopReason: resolveStopReason(response),
						},
					);
					return buildInvalidToolArgsRetry({
						state,
						messages,
						toolCall,
						correctionContent:
							'ERROR: Your apply_document_patches call had an empty or missing "patches" array. You MUST include at least one patch operation. Each patch needs "op" and "anchor" (a full heading path like "## Overview") at minimum. Please try again.',
						exhaustedMessage:
							"The AI model was unable to generate document edits after multiple attempts. Please try again or use a different model.",
						truncated,
						truncatedMessage:
							"The document is too large for the AI model's output limit, so it could not return the full content. Try asking for a smaller, targeted edit, or switch to a model with a larger output limit.",
					});
				}

				const sanitizeContent = (content: string) =>
					stripToolDefinitions(content, preEditDocument);

				const {
					success,
					result,
					errors,
					appliedCount,
					availableAnchorPaths,
					replaceTextStats,
				} = applyPatches(preEditDocument, patches, { sanitizeContent });

				if (!success) {
					logger.warn(
						"[Project Document Generator] Patch application failed",
						{
							errorCount: errors.length,
							errors: errors.map((e) => ({
								patchIndex: e.patchIndex,
								code: e.code,
								anchor: e.anchor,
							})),
							retryCount: state.retryCount,
						},
					);

					const errorSummary = errors
						.map((e) => {
							const suggestionLine = e.suggestions?.length
								? `\n  Did you mean: ${e.suggestions.slice(0, 3).join(", ")}`
								: "";
							return `- patch[${e.patchIndex}] (${e.op}, anchor="${e.anchor}"): ${e.message}${suggestionLine}`;
						})
						.join("\n");
					const anchorPathsBlock = (availableAnchorPaths ?? [])
						.slice(0, 20)
						.map((p) => `- \`${p}\``)
						.join("\n");

					// Detect the "model anchored to its rename target instead of
					// the existing heading" pattern (observed when transitioning
					// e.g. Passive Analysis → Active Analysis). When detected,
					// prepend a top-of-message hint with concrete fix-up code so
					// the model has a single clear path forward instead of
					// re-emitting the same wrong anchors.
					const renameIntent = detectRenameIntent(
						preEditDocument,
						errors,
					);
					let intentHint = "";
					if (renameIntent) {
						const oldText = renameIntent.currentAnchor.replace(
							/^#+\s+/,
							"",
						);
						const newText = renameIntent.proposedAnchor.replace(
							/^#+\s+/,
							"",
						);
						const hashes = "#".repeat(renameIntent.level);
						logger.warn(
							"[Project Document Generator] Rename intent detected on patch failure",
							{
								currentAnchor: renameIntent.currentAnchor,
								proposedAnchor: renameIntent.proposedAnchor,
							},
						);
						intentHint =
							`RENAME INTENT DETECTED — your patches anchor to "${renameIntent.proposedAnchor}", but the document currently has "${renameIntent.currentAnchor}". ` +
							"Anchors resolve against the CURRENT document baseline, not against the post-rename result. Fix in two steps within the SAME apply_document_patches call:\n" +
							`1. In every patch you've written, replace the anchor's leading "${renameIntent.proposedAnchor}" with "${renameIntent.currentAnchor}".\n` +
							"2. Add ONE more patch to perform the actual rename:\n" +
							"```json\n" +
							`{"op":"replace_text","anchor":"${renameIntent.currentAnchor}","find":"${hashes} ${oldText}","replace":"${hashes} ${newText}"}\n` +
							"```\n" +
							"All patches resolve independently against the baseline, so the rename and the body edits compose correctly.\n\n";
					} else {
						const overlapIntent = diagnoseOverlap(
							preEditDocument,
							errors,
						);
						if (overlapIntent) {
							logger.warn(
								"[Project Document Generator] Overlap intent detected on patch failure",
								{
									dominantPatchIndex:
										overlapIntent.dominantPatchIndex,
									dominantCoveragePercent:
										overlapIntent.dominantCoveragePercent,
									subsumedPatchIndexes:
										overlapIntent.subsumedPatchIndexes,
									kind: overlapIntent.kind,
								},
							);
							const dom = overlapIntent.dominantPatchIndex;
							const rangeStr = formatLineRange(
								overlapIntent.dominantRange,
							);
							const others = overlapIntent.subsumedPatchIndexes
								.map((i) => `[${i}]`)
								.join(", ");
							const subsumeNote =
								overlapIntent.kind === "whole-document"
									? `covers ~${overlapIntent.dominantCoveragePercent}% of the document body and structurally subsumes the other patch(es)`
									: `(${rangeStr}, ~${overlapIntent.dominantCoveragePercent}% of the body) overlaps with the other patch(es)`;
							intentHint =
								`OVERLAP DETECTED — patch[${dom}] (${rangeStr}) ${subsumeNote}. All anchors resolve against the baseline, so a wide patch on a root heading cannot coexist with narrower patches anchored under it in the same apply_document_patches call.\n` +
								"\nPick ONE recovery path:\n" +
								"1. PREFERRED for full rebuilds (stage transitions / >50% restructures): drop this apply_document_patches call entirely and call write_document_local once with the complete new document.\n" +
								`2. Single-patch rebuild via apply_document_patches: keep ONLY patch[${dom}] and put the full new body into its \`content\` (fold the content of patch(es) ${others || "(the narrower ones)"} into it).\n` +
								`3. Surgical sections only: drop patch[${dom}]; keep only the narrower patch(es) ${others || "(the non-dominant ones)"}. The dominant heading stays unchanged.\n\n`;
						}
					}

					return buildInvalidToolArgsRetry({
						state,
						messages,
						toolCall,
						correctionContent:
							intentHint +
							`Your apply_document_patches call failed:\n${errorSummary}\n\n` +
							`Valid anchor paths in this document (first 20):\n${anchorPathsBlock}\n\n` +
							"Retry with corrected anchors. Use the full heading path including parent headings " +
							'(e.g. "## Requirements > ### Must Have"). Copy an anchor from the list verbatim.',
						exhaustedMessage:
							"Failed to apply document patches after multiple attempts. The document is unchanged. Please try rephrasing your request.",
					});
				}

				// Repair structural markdown degradation the patched result may
				// carry (flattened sub-bullets, split bold/questions, glued
				// labels) before it reaches the confirm card. Deterministic and
				// behaviour-preserving.
				const document = repairDegradedMarkdown(result);

				logger.info("[Project Document Generator] Patches applied", {
					patchCount: patches.length,
					appliedCount,
					beforeLength: preEditDocument.length,
					afterLength: document.length,
					replaceTextStats,
					mode: "patch",
				});

				// Occurrences of a replaceAll find that survived outside the
				// anchored scope are not an error, but they are exactly the
				// "silently skipped replacement" a user can't see — keep them
				// loud in the logs.
				const residualStats = (replaceTextStats ?? []).filter(
					(stat) => stat.residualOccurrences > 0,
				);
				if (residualStats.length > 0) {
					logger.warn(
						"[Project Document Generator] replaceAll left residual occurrences outside the anchored scope",
						{ residualStats },
					);
				}

				// Reject-and-retry if the patches dropped or gutted a section the
				// user didn't ask to remove (a replace_section/delete_section can
				// collapse one section while total loss stays under the 20% floor).
				// On retry-exhaustion it proceeds with a partial-completion warning.
				const patchSectionGuard = evaluateSectionPreservation({
					state,
					messages,
					toolCall,
					baselineDocument: preEditDocument,
					document,
					mode: "patch",
				});
				if (patchSectionGuard.action === "retry") {
					return patchSectionGuard.command;
				}

				return buildConfirmChangesCommand({
					state,
					messages,
					toolCall,
					document,
					baselineDocument: preEditDocument,
					response,
					focusAnchor: toolCall.args?.focusAnchor,
					logMode: "patch",
					sectionWarning: patchSectionGuard.warning,
					toolResponseContent:
						buildPatchToolResponseContent(replaceTextStats),
					followUpNote: buildReplaceAllFollowUpNote(replaceTextStats),
					extraStateUpdate: {
						...reasoningByTurnUpdate,
						...toolCallsByTurnUpdate,
					},
				});
			}

			// External tool call (e.g., search_teams_messages)
			// Return state update WITHOUT goto - lets shouldContinue route to tool_node
			logger.info(
				"[Project Document Generator] External tool call, routing to tool_node",
				{
					toolName: toolCall.name,
					toolCallCount: response.tool_calls.length,
				},
			);

			return new Command({
				update: {
					messages: messages,
					error: undefined,
					...reasoningByTurnUpdate,
					...toolCallsByTurnUpdate,
				},
			});
		}

		// Nothing at all came back AND the generation was cut off at its
		// output-token limit (issue #2976). The escalated retry above has
		// already run and come back the same way, so there is no second thing
		// to try. This is a FAILED run, not a quiet one: falling through to the
		// plain "no tool call" branch below would end it with `error: undefined`
		// and leave the user staring at the generic "I wasn't able to generate a
		// response" fallback, with no hint that the document was left untouched
		// or what to do differently. `error` on a terminal state IS surfaced —
		// unified-server emits it as the assistant turn (see the terminal-error
		// branch in `packages/agent-core/src/unified-server.ts`).
		if (isEmptyModelResponse(response) && isOutputTruncated(response)) {
			logger.error(
				"[Project Document Generator] Empty truncated response after retry — ending run with a user-facing error",
				{
					stopReason: resolveStopReason(response),
					documentLength: state.document?.length || 0,
					messageCount: state.messages.length,
				},
			);
			return new Command({
				goto: END,
				update: {
					messages: [
						...state.messages,
						{
							role: "assistant" as const,
							content: TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE,
						},
					],
					// Make the message above true. `predict_state` streams partial
					// `write_document_local` arguments straight into
					// `state.document` as they arrive, so a call that was cut off
					// mid-arguments — parked in `invalid_tool_calls`, which
					// `isEmptyModelResponse` deliberately ignores — can already
					// have overwritten the document with a fragment. Restoring the
					// node-entry snapshot is what actually leaves it unchanged.
					// The RAW snapshot, not `preEditDocument` — the latter has
					// the wrapper-tag scrub applied, so restoring it would
					// silently modify a document that legitimately contains
					// that literal token.
					document: nodeEntryDocument,
					error: TRUNCATED_EMPTY_RESPONSE_USER_MESSAGE,
					retryCount: 0,
					...reasoningByTurnUpdate,
					...toolCallsByTurnUpdate,
				},
			});
		}

		// The finalize guard's terminal fallback returned nothing but a research
		// call it had to strip (issue #2999). Same shape as the truncated-empty
		// branch above and for the same reason: without an explicit `error` the
		// branch below would end the run reporting success while the document
		// was never written.
		if (finalizeGuardLeftNothing) {
			return new Command({
				goto: END,
				update: {
					messages: [
						...state.messages,
						{
							role: "assistant" as const,
							content: FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE,
						},
					],
					// `predict_state` streams partial write_document_local args
					// straight into state.document, so restore the node-entry
					// snapshot to make "has not been changed" true. Same
					// reasoning as the truncated-empty branch above.
					document: nodeEntryDocument,
					error: FINALIZE_GUARD_EMPTY_RESPONSE_USER_MESSAGE,
					retryCount: 0,
					...reasoningByTurnUpdate,
					...toolCallsByTurnUpdate,
				},
			});
		}

		// No tool call - return current state with messages
		logger.warn("[Project Document Generator] No tool call in response");
		return new Command({
			goto: END,
			update: {
				messages: messages,
				error: undefined,
				...reasoningByTurnUpdate,
				...toolCallsByTurnUpdate,
			},
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error occurred";
		const isJsonError = error instanceof Error && isJsonParseError(error);
		const isContextError =
			error instanceof Error && isContextLengthError(error);
		const isVisionError =
			error instanceof Error && isVisionUnsupportedError(error);

		const errorProviderConfig = extractProviderConfig(config);

		const errorDetails: Record<string, unknown> = {};
		if (error instanceof Error) {
			if ((error as any).cause) {
				errorDetails.cause = String((error as any).cause);
			}
			if ((error as any).response) {
				const resp = (error as any).response;
				errorDetails.responseStatus = resp.status;
				errorDetails.responseStatusText = resp.statusText;
			}
			if ((error as any).status) {
				errorDetails.httpStatus = (error as any).status;
			}
			if ((error as any).code) {
				errorDetails.errorCode = (error as any).code;
			}
			errorDetails.errorKeys = Object.keys(error);
		}

		logger.error("[Project Document Generator] Error in chat node", {
			error: errorMessage,
			errorType:
				error instanceof Error ? error.constructor.name : typeof error,
			errorStack:
				error instanceof Error
					? error.stack?.split("\n").slice(0, 5).join("\n")
					: undefined,
			errorDetails,
			isJsonParseError: isJsonError,
			isContextLengthError: isContextError,
			retryCount: state.retryCount,
			documentType: state.documentType,
			provider: errorProviderConfig?.provider,
			model: errorProviderConfig?.model,
			baseUrl: errorProviderConfig?.baseUrl,
			// Shape (not content) of the message array actually sent — the one
			// seam that still shows what triggered a schema-rejection 400 with
			// an empty response body.
			requestMessageShape: lastRequestShape,
		});

		// Fail-fast on deterministic "this model does not accept images"
		// errors. The tenant's TOOL_CALLING model is text-only; retrying
		// with the same multimodal payload is guaranteed to fail. Surface
		// a clear, actionable message instead of the raw provider error.
		if (isVisionError) {
			logger.error(
				"[Project Document Generator] Fail-fast on vision-unsupported model",
				{
					retryCount: state.retryCount,
					provider: errorProviderConfig?.provider,
					model: errorProviderConfig?.model,
				},
			);
			// attemptedImageCount covers story- AND chat-attached images:
			// the web tier (`StoryWorkspace`) calls
			// `projects.stories.resolveMediaForAgent` and pushes the resulting
			// base64-data-URL markdown into the `rag context` readable, so by
			// the time `splitRagContextImages` runs here both attachment
			// channels live in `ragContexts`.
			logger.info(
				"[chat-node] Vision-unsupported response served to user",
				{
					event: "feature_assistant_vision_unsupported",
					provider: errorProviderConfig?.provider ?? "unknown",
					model: errorProviderConfig?.model ?? "unknown",
					attemptedImageCount,
				},
			);
			const userFacingError = VISION_UNSUPPORTED_USER_MESSAGE;
			return new Command({
				goto: END,
				update: {
					messages: [
						...state.messages,
						{
							role: "assistant" as const,
							content: userFacingError,
						},
					],
					error: userFacingError,
					retryCount: 0,
				},
			});
		}

		// Fail-fast on deterministic "prompt too long" errors. Retrying with
		// the same oversized payload is guaranteed to fail and burns a full
		// round-trip's tokens per attempt. Surface a targeted user message
		// instead so they can narrow the scope.
		if (isContextError) {
			logger.error(
				"[Project Document Generator] Fail-fast on context_length_exceeded",
				{
					retryCount: state.retryCount,
					provider: errorProviderConfig?.provider,
					model: errorProviderConfig?.model,
				},
			);
			const userFacingError =
				"The AI request exceeded the model's context window. Try narrowing the scope — for example, ask about a single feature or a specific stage — or remove unrelated document sections before retrying.";
			return new Command({
				goto: END,
				update: {
					messages: [
						...state.messages,
						{
							role: "assistant" as const,
							content: userFacingError,
						},
					],
					error: userFacingError,
					retryCount: 0,
				},
			});
		}

		// Fail-fast when the provider rejected the request because the account
		// has no credit left. This is deterministic in exactly the way the HTTP
		// 400 case below is — the payload is fine, the account cannot pay for it
		// — but it arrives as 402, so it used to fall through to the retry loop
		// and burn MAX_RETRIES guaranteed-to-fail provider calls per user
		// action. That retry multiplication is why a single exhausted balance
		// produced tens of thousands of log events, and the user only ever saw
		// the generic "failed to generate" copy with no hint that the cause was
		// billing rather than their request.
		//
		// Rate limits and overload stay on the retry path on purpose: those are
		// transient and a backoff genuinely clears them.
		const limitSignal = classifyLimitError(error);
		if (limitSignal?.kind === "provider_quota") {
			logger.error(
				"[Project Document Generator] Fail-fast on exhausted provider credit",
				{
					retryCount: state.retryCount,
					provider:
						limitSignal.provider ?? errorProviderConfig?.provider,
					model: errorProviderConfig?.model,
					limitKind: limitSignal.kind,
				},
			);
			const userFacingError =
				"The AI provider account has run out of credit, so the request was rejected. An administrator needs to top up the provider account before the assistant can respond — retrying will not help until then.";
			return new Command({
				goto: END,
				update: {
					messages: [
						...state.messages,
						{
							role: "assistant" as const,
							content: userFacingError,
						},
					],
					error: userFacingError,
					retryCount: 0,
				},
			});
		}

		// Fail-fast on any other deterministic provider HTTP 400. Retries in
		// this catch block never modify `state.messages` (only `retryCount`
		// changes below), so a request-schema rejection fails the same way on
		// every attempt. Retrying just makes up to 5 redundant provider calls
		// (11.5s of scheduled backoff, plus provider latency) before surfacing
		// the same raw error, and a 400 with an empty body (no `error.message`
		// / `error.code` from the provider) gives `isVisionUnsupportedError`
		// nothing to pattern-match on, so it falls through to here uncaught
		// otherwise.
		//
		// JSON-parse errors are excluded: they come from a malformed
		// tool-call argument in the MODEL's own generation, not a rejected
		// HTTP request, and a fresh generation attempt can genuinely
		// self-correct (see MAX_JSON_RETRIES). isVisionError/isContextError
		// are handled above and never reach here.
		// Some providers/wrappers expose the status only on the nested
		// response (the diagnostic block above already reads both), so check
		// each — otherwise a deterministic 400 still burns all 5 retries.
		const directStatus = (error as any)?.status;
		const responseStatus = (error as any)?.response?.status;
		const httpStatus: number | undefined =
			typeof directStatus === "number"
				? directStatus
				: typeof responseStatus === "number"
					? responseStatus
					: undefined;
		if (httpStatus === 400 && !isJsonError) {
			logger.error(
				"[Project Document Generator] Fail-fast on non-retryable HTTP 400",
				{
					retryCount: state.retryCount,
					provider: errorProviderConfig?.provider,
					model: errorProviderConfig?.model,
					requestMessageShape: lastRequestShape,
				},
			);
			const userFacingError = `Failed to generate document: ${errorMessage}`;
			return new Command({
				goto: END,
				update: {
					messages: [
						...state.messages,
						{
							role: "assistant" as const,
							content: userFacingError,
						},
					],
					error: userFacingError,
					retryCount: 0,
				},
			});
		}

		// Determine max retries based on error type
		const maxRetries = isJsonError ? MAX_JSON_RETRIES : MAX_RETRIES;

		if (state.retryCount < maxRetries) {
			const nextRetryCount = state.retryCount + 1;
			const delayMs = calculateRetryDelay(state.retryCount);

			logger.info(
				"[Project Document Generator] Retrying with backoff...",
				{
					retryCount: nextRetryCount,
					maxRetries,
					delayMs,
					isJsonParseError: isJsonError,
				},
			);

			await sleep(delayMs);

			return new Command({
				goto: "chat_node" as typeof END,
				update: {
					retryCount: nextRetryCount,
				},
			});
		}

		// Max retries reached - provide user-friendly error
		logger.error("[Project Document Generator] Max retries reached", {
			retryCount: state.retryCount,
			maxRetries,
			isJsonParseError: isJsonError,
		});

		let userFacingError: string;
		if (isJsonError) {
			userFacingError =
				"The AI model encountered difficulty generating the document. This can happen with complex content. Please try again with a simpler request, or try regenerating the document.";
		} else {
			userFacingError = `Failed to generate document: ${errorMessage}`;
		}

		const errorResponse = {
			role: "assistant" as const,
			content: userFacingError,
		};

		return new Command({
			goto: END,
			update: {
				messages: [...state.messages, errorResponse],
				error: userFacingError,
				retryCount: 0,
			},
		});
	}
}
