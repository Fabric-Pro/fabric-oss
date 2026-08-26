import type { BaseMessage } from "@langchain/core/messages";
import { hoistRawStopReason } from "../output-truncation";
import {
	countHumanMessages,
	extractReasoningFromMessage,
	extractReasoningTokens,
} from "./extract";
import type { ReasoningTurnEntry } from "./state";

export type ReasoningByTurnUpdate = {
	reasoningByTurn?: Record<number, ReasoningTurnEntry>;
};

export interface BuildReasoningUpdateArgs {
	/** AIMessage returned from `await model.invoke(...)` — never an in-flight chunk. */
	response: unknown;
	/** Existing per-turn reasoning entries from agent state, for in-turn coalescing. */
	existingByTurn: Record<number, ReasoningTurnEntry> | undefined;
	/**
	 * LangGraph `state.messages` — NOT the model's input array. Some agents
	 * construct synthetic HumanMessages purely as model input (e.g. task_planner
	 * analyze.ts) which would inflate `countHumanMessages` if accidentally fed in.
	 */
	stateMessages: BaseMessage[];
	/** `Date.now()` captured BEFORE `model.invoke()` — used for `durationMs`. */
	turnStart: number;
	/** Optional prefix for log lines, e.g. `"[Backlog Updater]"`. */
	loggerLabel?: string;
}

/**
 * Build the `reasoningByTurn` slice of a Command.update for a single
 * model.invoke() result. Returns an EMPTY object when there is no
 * reasoning to emit, so callers can always do `{ ...existing, ...result }`
 * without conditional spread sites.
 *
 * **NOT pure** — calls `Date.now()` to compute `durationMs` and `completedAt`.
 *
 * Strict caller protocol (read carefully):
 *
 *   **P1.** Caller MUST invoke `buildReasoningUpdate` BEFORE
 *   {@link stripRawResponseEnvelope}. Stripping first would silently empty
 *   the gateway-path reasoning extraction. The pure-function shape obscures
 *   this ordering requirement — call sites should reference this JSDoc.
 *
 *   **P2.** Caller MUST pass `state.messages` (LangGraph state), NOT the
 *   model invocation argument array. Some agents construct synthetic
 *   HumanMessages purely as model input which would inflate
 *   `countHumanMessages` if accidentally fed in. See e.g.
 *   project-document-generator chat-node.ts where `state.messages` is the
 *   captured snapshot at the top of the node body.
 *
 *   **P3.** `turnStart = Date.now()` MUST be captured BEFORE
 *   `model.invoke()`. Capturing after invocation makes `durationMs` always
 *   ≈ 0.
 *
 * Telemetry: when `usage_metadata.output_token_details.reasoning > 0` but
 * extracted text is empty, emits a `console.warn` so billing-vs-text drift
 * is visible in production logs.
 */
export function buildReasoningUpdate(
	args: BuildReasoningUpdateArgs,
): ReasoningByTurnUpdate {
	const reasoningText = extractReasoningFromMessage(args.response);
	const reasoningTokens = extractReasoningTokens(args.response);

	if (reasoningText.length === 0) {
		if (reasoningTokens > 0) {
			console.warn(
				`${args.loggerLabel ?? "[reasoning-trace]"} billing-vs-text drift: ` +
					"usage_metadata.output_token_details.reasoning > 0 but extracted text empty. " +
					"Check gateway shape (reasoning_content vs reasoning) and converter version.",
				{ reasoningTokens },
			);
		}
		return {};
	}

	const turnIndex = countHumanMessages(args.stateMessages);
	if (turnIndex < 1) {
		console.warn(
			`${args.loggerLabel ?? "[reasoning-trace]"} reasoning extracted but no human ` +
				"message found in state — dropping update.",
			{ textLength: reasoningText.length },
		);
		return {};
	}

	const existing = args.existingByTurn?.[turnIndex];
	const mergedText = (existing?.text ?? "") + reasoningText;
	const startedAt = existing?.startedAt ?? args.turnStart;

	// Two independent Date.now() samples — preserves the pre-refactor behavior
	// of the in-tree implementation in project-document-generator chat-node.ts
	// (which the PR 1 spec promised to keep as a pure refactor). The two
	// samples can differ by a few microseconds; a single sample would tighten
	// telemetry by ~µs but is a tiny behavior change. Keeping two preserves
	// strict identity vs. the original.
	return {
		reasoningByTurn: {
			[turnIndex]: {
				text: mergedText,
				durationMs: Date.now() - startedAt,
				startedAt,
				completedAt: Date.now(),
			},
		},
	};
}

/**
 * Strip the bulky raw API envelope from an AIMessage AFTER reasoning has
 * been extracted. The envelope is only needed for the single
 * {@link extractReasoningFromMessage} call; persisting it would bloat
 * checkpointer storage and SSE state payloads.
 *
 * Before deleting, calls {@link hoistRawStopReason} to lift the envelope's
 * stop/finish reason into `response_metadata` — on gateway providers that
 * omit it there, the envelope is the only place it exists, and it would
 * otherwise be lost along with the rest of the raw payload.
 *
 * Idempotent — safe to call when `additional_kwargs` or `__raw_response`
 * are absent. Mutates `response` in place; because LangGraph appends
 * messages by reference, this also cleans up the array entry in
 * `state.messages`.
 *
 * Protocol: call AFTER `buildReasoningUpdate`. See {@link buildReasoningUpdate}
 * protocol P1.
 */
export function stripRawResponseEnvelope(response: unknown): void {
	hoistRawStopReason(response);
	if (!response || typeof response !== "object") {
		return;
	}
	const ak = (response as { additional_kwargs?: unknown }).additional_kwargs;
	if (!ak || typeof ak !== "object") {
		return;
	}
	if ((ak as { __raw_response?: unknown }).__raw_response !== undefined) {
		delete (ak as { __raw_response?: unknown }).__raw_response;
	}
}
