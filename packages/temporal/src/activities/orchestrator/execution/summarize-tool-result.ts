/**
 * Summarize Large Tool Results
 *
 * When a tool returns a result larger than the context limit (e.g., 336KB meeting transcript),
 * this activity uses a fast/cheap LLM to intelligently condense it while preserving
 * information relevant to the user's query.
 *
 * This replaces blind truncation with context-aware summarization.
 *
 * Two call paths, both of which fall back to truncation when this throws:
 *   1. In-process inside the `reportAgentLoop` activity (shares that activity's
 *      context, so `heartbeat()` here counts against ITS heartbeat timeout).
 *   2. As its own Temporal activity proxied from the orchestrator workflow
 *      (startToClose 5 min, heartbeatTimeout 1 min).
 *
 * Bug #2288: the summarization LLM returning 429 used to collapse straight to
 * blind truncation, because the AI SDK's own 3 attempts run back-to-back inside
 * a couple of seconds. Rate limits are now ridden out with Retry-After-aware
 * backoff, under a shared wait budget so this can never eat the whole
 * startToClose timeout.
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { classifyLimitError } from "@repo/ai/limits";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { generateText } from "ai";

export interface SummarizeToolResultInput {
	toolName: string;
	toolResult: string;
	userQuery: string;
	maxOutputLength: number;
	userId: string;
	organizationId?: string;
}

/**
 * Timing seams, injected only by tests. Deliberately a SECOND parameter and not
 * a field on {@link SummarizeToolResultInput}: functions do not survive the
 * Temporal payload converter, which is exactly how the previous `onProgress`
 * heartbeat callback vanished on the path-2 activity boundary (#2288).
 * Temporal only ever passes the input, so the defaults always apply in prod.
 */
export interface SummarizeToolResultDeps {
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	random: () => number;
}

const defaultDeps: SummarizeToolResultDeps = {
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
	random: () => Math.random(),
};

/** ~30K tokens per chunk, safe for most model context windows. */
const CHUNK_LIMIT = 120000;
/**
 * Path 2's input is bounded only by Temporal's ~2MB payload limit, which is up
 * to 17 chunks + a final pass = 18 sequential LLM calls against a 5-minute
 * startToCloseTimeout. Cap the work instead of guaranteeing a timeout.
 */
const MAX_CHUNKS = 6;
const MAX_INPUT_CHARS = CHUNK_LIMIT * MAX_CHUNKS;

/** Attempts per LLM call site, including the first. */
const MAX_ATTEMPTS = 3;
/** Total time this invocation may spend sleeping on provider limits. */
const RETRY_BUDGET_MS = 45_000;
/** ~70% of path 2's 5-minute startToCloseTimeout — a timeout is worse than truncation. */
const RETRY_DEADLINE_MS = 210_000;
/** Cap on honoring a provider's Retry-After. */
const MAX_RETRY_AFTER_MS = 60_000;
const BACKOFF_BASE_MS = 10_000;
const MAX_BACKOFF_BASE_MS = 45_000;
/** Must stay well under path 2's 1-minute heartbeatTimeout. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Wait budget + deadline shared by EVERY LLM call in one invocation (all chunks). */
interface RetryState {
	budgetMs: number;
	deadlineAt: number;
}

const SYSTEM_PROMPT = `You are a tool result summarizer. Your job is to condense large tool outputs while preserving all key information relevant to the user's query.

Rules:
- Preserve ALL names, dates, numbers, IDs, URLs, and actionable details
- Preserve key decisions, action items, and conclusions
- Remove redundant or repeated information
- Remove verbose formatting, boilerplate, and metadata that isn't relevant
- Output as structured, readable text
- If the data contains a list of items, preserve the count and key details of each
- Never fabricate information - only include what's in the original data
- Start directly with the content - no preamble like "Here is a summary"`;

export async function summarizeLargeToolResult(
	input: SummarizeToolResultInput,
	deps: SummarizeToolResultDeps = defaultDeps,
): Promise<string> {
	const {
		toolName,
		toolResult,
		userQuery,
		maxOutputLength,
		userId,
		organizationId,
	} = input;

	// Heartbeat on a fixed interval for the WHOLE invocation, started before
	// model resolution (which does DB work) so no phase can starve the timeout.
	// Called with NO details: on path 1 this shares the parent reportAgentLoop
	// activity's context, and details would clobber its structured heartbeat
	// payload (cf. run-agent-iteration.ts's OrchestratorHeartbeatDetails).
	const hb = setInterval(() => {
		try {
			heartbeat();
		} catch {
			/* heartbeat called outside an activity context (tests) — ignore */
		}
	}, HEARTBEAT_INTERVAL_MS);

	const state: RetryState = {
		budgetMs: RETRY_BUDGET_MS,
		deadlineAt: deps.now() + RETRY_DEADLINE_MS,
	};

	try {
		const { model } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{ userId, organizationId },
		);

		let source = toolResult;
		if (source.length > MAX_INPUT_CHARS) {
			console.log(
				`[SummarizeToolResult] ${toolName}: input ${source.length} chars exceeds the ${MAX_INPUT_CHARS}-char cap, dropping ${source.length - MAX_INPUT_CHARS} chars before chunking`,
			);
			source = source.slice(0, MAX_INPUT_CHARS);
		}

		// For extremely large results (>CHUNK_LIMIT chars), chunk and summarize each chunk
		if (source.length > CHUNK_LIMIT) {
			const chunks: string[] = [];
			for (let i = 0; i < source.length; i += CHUNK_LIMIT) {
				chunks.push(source.slice(i, i + CHUNK_LIMIT));
			}

			const chunkSummaries: string[] = [];
			for (const chunk of chunks) {
				const result = await callWithRateLimitRetry(
					() =>
						generateText({
							model,
							system: SYSTEM_PROMPT,
							prompt: `Tool: ${toolName}\nUser's query: ${userQuery}\n\nCondense this chunk of tool output (part of a larger result). Preserve all key information relevant to the query.\n\n${chunk}`,
							maxOutputTokens: Math.floor(
								maxOutputLength / chunks.length / 4,
							), // ~4 chars per token
							temperature: 0.2,
							maxRetries: 1,
							// Caps a call started just before the deadline. An
							// abort is a non-limit error → immediate rethrow →
							// the caller's truncation fallback.
							abortSignal: deadlineSignal(state, deps),
						}),
					state,
					deps,
				);
				chunkSummaries.push(result.text);
			}

			// If combined summaries still fit, return them concatenated
			const combined = chunkSummaries.join("\n\n---\n\n");
			if (combined.length <= maxOutputLength) {
				return combined;
			}

			// Otherwise, do a final summarization pass on the combined summaries
			const finalResult = await callWithRateLimitRetry(
				() =>
					generateText({
						model,
						system: SYSTEM_PROMPT,
						prompt: `Tool: ${toolName}\nUser's query: ${userQuery}\n\nCondense these partial summaries into a single coherent summary:\n\n${combined}`,
						maxOutputTokens: Math.floor(maxOutputLength / 4),
						temperature: 0.2,
						maxRetries: 1,
						abortSignal: deadlineSignal(state, deps),
					}),
				state,
				deps,
			);

			return finalResult.text;
		}

		// Single-pass summarization for results that fit in context
		const result = await callWithRateLimitRetry(
			() =>
				generateText({
					model,
					system: SYSTEM_PROMPT,
					prompt: `Tool: ${toolName}\nUser's query: ${userQuery}\n\nCondense this tool output while preserving all information relevant to the query:\n\n${source}`,
					maxOutputTokens: Math.floor(maxOutputLength / 4),
					temperature: 0.2,
					maxRetries: 1,
					abortSignal: deadlineSignal(state, deps),
				}),
			state,
			deps,
		);

		return result.text;
	} finally {
		clearInterval(hb);
	}
}

/**
 * Run one LLM call, riding out transient provider rate limits. `maxRetries: 1`
 * on the call itself keeps a cheap SDK-level retry for transient network/5xx
 * (which the limit classifier deliberately does not cover) without letting the
 * SDK's nested attempts multiply against these.
 */
async function callWithRateLimitRetry<T>(
	fn: () => Promise<T>,
	state: RetryState,
	deps: SummarizeToolResultDeps,
): Promise<T> {
	// Bounds the chunked path: slow but SUCCESSFUL calls never reach the retry
	// logic below, so without this a long chunk sequence would keep starting new
	// LLM calls until path 2's startToCloseTimeout killed the activity outright.
	if (deps.now() >= state.deadlineAt) {
		throw ApplicationFailure.create({
			message:
				"Tool-result summarization exceeded its invocation deadline before completing",
			type: "SummarizeToolResultDeadlineExceeded",
			nonRetryable: true,
		});
	}

	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			const signal = classifyLimitError(error);
			// Only a transient limit is worth waiting out. `provider_quota` is
			// terminal — billing exhaustion will not clear by waiting — and
			// everything else is a generic failure. Same split as
			// `verdictFromLimitSignal` in security-scan/adaptive-concurrency.ts,
			// inlined rather than imported across domains.
			if (
				signal?.kind !== "provider_rate_limit" &&
				signal?.kind !== "provider_overloaded"
			) {
				throw error;
			}

			const provider = signal.provider ?? "unknown";
			const waitMs = computeWaitMs(signal.retryAfterMs, attempt, deps);
			const giveUpReason =
				attempt >= MAX_ATTEMPTS
					? "attempts exhausted"
					: // Test the deadline against the END of the sleep, not the
						// start: a 10s wait beginning at 205s elapsed would
						// otherwise be scheduled and overshoot to 215s.
						deps.now() + waitMs >= state.deadlineAt
						? "invocation deadline reached"
						: waitMs > state.budgetMs
							? "wait budget exhausted"
							: null;

			if (giveUpReason) {
				console.log(
					`[SummarizeToolResult] giving up on provider limit (kind=${signal.kind}, provider=${provider}) after attempt ${attempt}/${MAX_ATTEMPTS}: ${giveUpReason} (next wait ${waitMs}ms, budget left ${state.budgetMs}ms)`,
				);
				// Non-retryable so path 2 does not burn 3 more full activity runs
				// re-summarizing every chunk against a provider we just proved is
				// rate-limited. Both call paths already fall back to truncation.
				throw ApplicationFailure.create({
					message: `Tool-result summarization hit a provider limit (kind=${signal.kind}, provider=${provider}) and stopped retrying: ${giveUpReason}`,
					type: "SummarizeToolResultProviderLimit",
					nonRetryable: true,
					cause: error instanceof Error ? error : undefined,
				});
			}

			console.log(
				`[SummarizeToolResult] provider limit (kind=${signal.kind}, provider=${provider}), attempt ${attempt}/${MAX_ATTEMPTS}, waiting ${waitMs}ms (budget left ${state.budgetMs}ms)`,
			);
			state.budgetMs -= waitMs;
			await deps.sleep(waitMs);
		}
	}
}

/**
 * Hard wall-clock bound on a single in-flight LLM call. The retry logic only
 * runs between calls, so without this a provider that accepts the request and
 * then stalls would sail past the deadline unchecked.
 */
function deadlineSignal(
	state: RetryState,
	deps: SummarizeToolResultDeps,
): AbortSignal {
	return AbortSignal.timeout(Math.max(1, state.deadlineAt - deps.now()));
}

function computeWaitMs(
	retryAfterMs: number | undefined,
	attempt: number,
	deps: SummarizeToolResultDeps,
): number {
	if (retryAfterMs && retryAfterMs > 0) {
		return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
	}
	// Equal jitter — de-synchronizes concurrent summarizations hitting the same
	// provider window, which deterministic backoff would retry in lockstep.
	const base = Math.min(
		BACKOFF_BASE_MS * 3 ** (attempt - 1),
		MAX_BACKOFF_BASE_MS,
	);
	return Math.round(base / 2 + deps.random() * (base / 2));
}
