import type { Prisma } from "../client";

/**
 * Models whose usage rows carry no request latency. Parlume's meeting bot
 * (`attendee/teams-bot`) and its live transcription (`@cf/deepgram/flux`) are
 * billed by meeting time, and its realtime voice (`gpt-realtime-2.1`) per
 * response with no request timing; older rows of the first two stored the
 * meeting's length in `latencyMs`. These rows count in cost and requests, but
 * never in a latency average or a latency filter.
 */
export const AI_USAGE_MODELS_WITHOUT_REQUEST_LATENCY: readonly string[] = [
	"attendee/teams-bot",
	"@cf/deepgram/flux",
	"gpt-realtime-2.1",
];

export function hasRequestLatency(providerModelId: string): boolean {
	return !AI_USAGE_MODELS_WITHOUT_REQUEST_LATENCY.includes(providerModelId);
}

export const requestLatencyRows: Prisma.AiUsageLogWhereInput = {
	NOT: {
		providerModelId: { in: [...AI_USAGE_MODELS_WITHOUT_REQUEST_LATENCY] },
	},
};

/** The latency range filter, which only rows with a request latency can match. */
export function buildLatencyClause(
	minLatencyMs: number | undefined,
	maxLatencyMs: number | undefined,
): Prisma.AiUsageLogWhereInput {
	const latencyMs: { gte?: number; lte?: number } = {};
	if (typeof minLatencyMs === "number") {
		latencyMs.gte = minLatencyMs;
	}
	if (typeof maxLatencyMs === "number") {
		latencyMs.lte = maxLatencyMs;
	}
	return Object.keys(latencyMs).length > 0
		? { latencyMs, ...requestLatencyRows }
		: {};
}
