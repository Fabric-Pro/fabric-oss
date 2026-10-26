import { planConversationTurnReservation } from "@repo/database/prisma/queries/lib/conversation-turn-room";
import { isFabricOwnedRead } from "./fabric-catalog-access";
import {
	assessToolCallRisk,
	type AutonomyLevel,
	type RiskAssessmentOptions,
} from "./risk-assessment";
import { TOOL_RESULTS } from "./orchestrator-config";
import { PAGED_BODY_READ_TOOLS } from "./tool-result-progression";
import type { IterativeMessage } from "./types";
import { measureSerializedBytes } from "../../lib/payload-size-guard";
const PROTECTED_HISTORY_TOOLS = new Set([
	"load_skill",
	"read_skill_file",
	"fabric_get_frame",
	...PAGED_BODY_READ_TOOLS,
]);

export const BOUNDED_HISTORY_PATCH = "orch-bounded-history-v1";
export function boundedHistoryEnabled(
	input: { turnId?: string; historyRetention?: "bounded" },
	marker: boolean,
): boolean {
	return (
		marker && Boolean(input.turnId) && input.historyRetention === "bounded"
	);
}
export const HISTORY_BYTE_CAP = 512 * 1024;
export interface IterationRequestShape {
	conversationHistory: unknown[];
	systemPrompt: string;
	availableTools: Record<string, unknown>;
	turnNotice?: string;
}
/** ASCII uses the ledger's chars/3 rule; non-ASCII code points count as one token before headroom. */
export function estimateIterationInputTokens(
	request: IterationRequestShape,
): number {
	const serialized = JSON.stringify({
		system: request.systemPrompt,
		tools: request.availableTools,
		messages: request.conversationHistory,
		notice: request.turnNotice,
	});
	let ascii = 0;
	let nonAscii = 0;
	for (const character of serialized) {
		if (character.charCodeAt(0) <= 0x7f) {
			ascii++;
		} else {
			nonAscii++;
		}
	}
	return (
		Math.ceil((ascii / 3 + nonAscii) * 1.25) +
		64 +
		(request.conversationHistory.length +
			1 +
			(request.turnNotice ? 1 : 0)) *
			8
	);
}
export function boundedHistoryDecision<T extends IterationRequestShape>(input: {
	request: T;
	contextWindow?: number;
	extraInputTokens?: number;
	allowance: number;
	spent: number;
	finalizationReserve: number;
}) {
	const softCap = Math.min(
		32_000,
		input.contextWindow && input.contextWindow > 0
			? Math.floor(0.6 * input.contextWindow)
			: 32_000,
	);
	const tokens =
		estimateIterationInputTokens(input.request) +
		(input.extraInputTokens ?? 0);
	const bytes = measureSerializedBytes(input.request);
	const room = Math.max(
		0,
		input.allowance - input.spent - input.finalizationReserve,
	);
	const reason =
		bytes > HISTORY_BYTE_CAP
			? "bytes"
			: tokens > softCap
				? "tokens"
				: tokens + 16_384 > room
					? "allowance"
					: undefined;
	return {
		prune: reason !== undefined,
		reason,
		tokens,
		bytes,
		softCap,
		targetTokens: Math.min(
			Math.floor(softCap / 2),
			Math.max(0, room - 16_384),
		),
		targetBytes: HISTORY_BYTE_CAP / 2,
	};
}

export const BOUNDED_HISTORY_V2_PATCH = "orch-bounded-history-v2";
export const WEIGHTED_ALLOWANCE_PATCH = "orch-cache-weighted-allowance-v1";
export const HISTORY_CLEAR_AT_LEAST = 20_000;

interface BoundedHistoryV2Input<T extends IterationRequestShape> {
	request: T;
	/** False when no turn ledger exists to enforce allowance admission. */
	hasTurnLedger?: boolean;
	contextWindow?: number;
	extraInputTokens?: number;
	allowance: number;
	/** Charged measured usage plus outstanding reservations. */
	spent: number;
	finalizationReserve: number;
	calibrationFactor?: number;
}

/** S is calibrated on the whole prompt; R retains the ledger's uncalibrated input. */
export function measureBoundedHistoryV2Request<T extends IterationRequestShape>(
	input: BoundedHistoryV2Input<T>,
) {
	const estimate =
		estimateIterationInputTokens(input.request) +
		(input.extraInputTokens ?? 0);
	const tokens = Math.ceil(estimate * (input.calibrationFactor ?? 1));
	const bytes = measureSerializedBytes(input.request);
	const room = Math.max(
		0,
		input.allowance - input.spent - input.finalizationReserve,
	);
	const softCap = Math.min(
		100_000,
		input.contextWindow && input.contextWindow > 0
			? Math.floor(input.contextWindow * 0.6)
			: 100_000,
	);
	// Only this pure leaf is imported into the sandbox, not the database entry point.
	// The 1,024 output floor is pinned against TURN_BUDGET_ESTIMATE by the parity test.
	const plan = planConversationTurnReservation({
		totals: {
			allowance: input.allowance,
			measured: input.spent,
			outstanding: 0,
			finalizationReserve: input.finalizationReserve,
		},
		kind: "EXPLORATION",
		inputEstimate: estimate,
		requestedOutputTokens: 1_024,
		minOutputTokens: 1_024,
		enforced: true,
	});
	const reservation =
		plan.outcome === "fits" ? plan.reservedTokens : plan.needed;
	const hardLimits = {
		bytes: bytes > HISTORY_BYTE_CAP,
		context:
			input.contextWindow !== undefined && tokens > input.contextWindow,
		allowance_refused: input.hasTurnLedger !== false && reservation > room,
	};
	const softLimits = {
		tokens: tokens > softCap,
		allowance:
			input.hasTurnLedger !== false &&
			reservation <= room &&
			reservation + 16_384 > room,
	};
	return {
		tokens,
		reservation,
		bytes,
		room,
		softCap,
		hardLimits,
		softLimits,
		softLimit: Object.values(softLimits).some(Boolean),
		hardLimit: Object.values(hardLimits).some(Boolean),
	};
}

type HistoryReason =
	| "within_limits"
	| "consecutive_rewrite"
	| "insufficient_savings"
	| "bytes"
	| "context"
	| "allowance"
	| "allowance_refused"
	| "tokens";

/**
 * The no-trigger return preserves history below both soft and hard limits.
 * The soft-only guards enforce a gap after a rewrite and a 20k savings floor;
 * that branch cannot select compaction. Refused reservations bypass these
 * guards, but the fit check rejects a reset that cannot rescue admission.
 * The reset loop clears all eligible results through its protection guards,
 * creating room for subsequent appends rather than stopping at a threshold.
 * Technical hard triggers bypass the gap and savings floor. An unresolved
 * byte or context limit selects compact with the reset history retained, including for a no-op summary.
 * The caller records a rewrite only for changed resets or changed compactions.
 */
export function boundedHistoryV2Decision<
	T extends IterationRequestShape & {
		conversationHistory: IterativeMessage[];
	},
>(
	input: BoundedHistoryV2Input<T> & {
		iteration: number;
		lastRewrite?: number;
		/** The options used at this call's existing approval gate; missing means unclassified. */
		riskOptionsByToolCallId?: ReadonlyMap<string, RiskAssessmentOptions>;
		autonomyLevel?: AutonomyLevel;
	},
) {
	const before = measureBoundedHistoryV2Request(input);
	const technicalHardLimit =
		before.hardLimits.bytes || before.hardLimits.context;
	const unchanged = (reason: HistoryReason) => ({
		action: "append" as const,
		reason,
		pruned: 0,
		tokensFreed: 0,
		bytesFreed: 0,
		keptNonReadOnlyResults: 0,
		before,
		after: before,
		history: input.request.conversationHistory,
	});
	if (!before.hardLimit && !before.softLimit) {
		return unchanged("within_limits");
	}
	if (!before.hardLimit && input.lastRewrite === input.iteration - 1) {
		return unchanged("consecutive_rewrite");
	}
	const reason: HistoryReason = before.hardLimits.bytes
		? "bytes"
		: before.hardLimits.context
			? "context"
			: before.hardLimits.allowance_refused
				? "allowance_refused"
				: before.softLimits.allowance
					? "allowance"
					: "tokens";
	const history: IterativeMessage[] = input.request.conversationHistory;
	type RecordedCall = NonNullable<IterativeMessage["toolCalls"]>[number];
	const calls = new Map<string, RecordedCall | null>();
	for (const message of history) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const call of message.toolCalls ?? []) {
			// A duplicate id cannot identify one recorded operation unambiguously.
			calls.set(call.id, calls.has(call.id) ? null : call);
		}
	}
	const pairedResults = history.filter(
		(message) =>
			message.role === "tool" &&
			message.toolCallId &&
			calls.get(message.toolCallId),
	);
	const recent = new Set(
		pairedResults.slice(-3).map((message) => message.toolCallId),
	);
	let pruned = 0;
	let keptNonReadOnlyResults = 0;
	const proposed = [...history];
	for (let index = 0; index < history.length; index++) {
		const message = history[index];
		const call = message.toolCallId
			? calls.get(message.toolCallId)
			: undefined;
		const name = call?.name;
		if (
			message.role !== "tool" ||
			recent.has(message.toolCallId) ||
			message.iteration === undefined ||
			message.iteration >=
				input.iteration - TOOL_RESULTS.recentIterationsToKeep ||
			message.content.length < TOOL_RESULTS.pruneMinChars ||
			message.content.startsWith("[Previous tool result pruned") ||
			(name !== undefined && PROTECTED_HISTORY_TOOLS.has(name))
		) {
			continue;
		}
		const options = call
			? input.riskOptionsByToolCallId?.get(call.id)
			: undefined;
		// A recorded executor declaration also certifies external reads. Low risk
		// alone does not: content writes and unknown tool names can be low risk.
		const fabricRisk =
			call &&
			options &&
			isFabricOwnedRead(call.name, options.fabricRouted === true)
				? assessToolCallRisk(call, input.autonomyLevel, options)
				: undefined;
		const fabricRead =
			fabricRisk?.riskLevel === "low" && !fabricRisk.requiresApproval;
		if (!call || (message.toolResultReadOnly !== true && !fabricRead)) {
			keptNonReadOnlyResults++;
			continue;
		}
		pruned++;
		const summary = message.content
			.substring(0, TOOL_RESULTS.prunedPlaceholderMax)
			.replace(/\n/g, " ");
		proposed[index] = {
			...message,
			content: `[Previous tool result pruned to save context. Tool: ${name} returned ${message.content.length} chars. Summary: ${summary}...]`,
		};
	}
	const after = measureBoundedHistoryV2Request({
		...input,
		request: { ...input.request, conversationHistory: proposed },
	});

	const tokensFreed = before.tokens - after.tokens;
	const bytesFreed = before.bytes - after.bytes;
	// Technical limits retain their reset/compaction path when triggers overlap.
	// Refusal alone rewrites only when the full reset makes admission fit;
	// its rejected proposal goes to the ledger unchanged without a summary call.
	if (
		!technicalHardLimit &&
		before.hardLimits.allowance_refused &&
		after.reservation > after.room
	) {
		return { ...unchanged("allowance_refused"), keptNonReadOnlyResults };
	}
	if (!before.hardLimit && tokensFreed < HISTORY_CLEAR_AT_LEAST) {
		return { ...unchanged("insufficient_savings"), keptNonReadOnlyResults };
	}
	return {
		action:
			technicalHardLimit &&
			(after.hardLimits.bytes || after.hardLimits.context)
				? ("compact" as const)
				: ("reset" as const),
		reason,
		pruned,
		tokensFreed,
		bytesFreed,
		keptNonReadOnlyResults,
		before,
		after,
		history: proposed,
	};
}
