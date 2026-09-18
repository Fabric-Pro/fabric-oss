import type { AiUsageLimitDimension, AiUsageLimitWindow } from "@repo/database";

/**
 * Structured error thrown when a HARD AI usage limit would be exceeded.
 *
 * This module intentionally has type-only dependencies so callers that only
 * need to preserve the quota rejection can import it without registering the
 * payments usage recorder.
 */
export class AiUsageLimitExceededError extends Error {
	readonly code = "AI_USAGE_LIMIT_EXCEEDED" as const;
	readonly limitId: string;
	readonly dimension: AiUsageLimitDimension;
	readonly window: AiUsageLimitWindow;
	readonly used: bigint;
	readonly max: bigint;
	readonly manageLimitsUrl: string;

	constructor(params: {
		message: string;
		limitId: string;
		dimension: AiUsageLimitDimension;
		window: AiUsageLimitWindow;
		used: bigint;
		max: bigint;
		manageLimitsUrl: string;
	}) {
		super(params.message);
		this.name = "AiUsageLimitExceededError";
		this.limitId = params.limitId;
		this.dimension = params.dimension;
		this.window = params.window;
		this.used = params.used;
		this.max = params.max;
		this.manageLimitsUrl = params.manageLimitsUrl;
	}
}
