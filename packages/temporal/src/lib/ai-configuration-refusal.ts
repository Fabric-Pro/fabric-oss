import { toSubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE } from "@repo/ai/lib/chatgpt-plan/reconnect-message";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "../workflows/ai-non-retryable-errors";

const refusalNames: ReadonlySet<string> = new Set(
	AI_NON_RETRYABLE_ERROR_TYPES.filter(
		(name) => name !== "AIProviderNotConfiguredError",
	),
);

/**
 * Return the original named refusal when found, or convert a raw exhaustion
 * body to a typed error. Name-only matches need not pass instanceof checks.
 */
export function findAiConfigurationRefusal(error: unknown): Error | null {
	try {
		const seen = new Set<object>();
		function find(value: unknown, depth: number): Error | null {
			if (
				!value ||
				typeof value !== "object" ||
				depth > 8 ||
				seen.has(value)
			) {
				return null;
			}
			seen.add(value);
			const bag = value as {
				name?: string;
				constructor?: { name?: string };
				cause?: unknown;
				error?: unknown;
				lastError?: unknown;
				errors?: unknown;
				responseBody?: unknown;
				code?: unknown;
			};
			if (
				refusalNames.has(bag.name ?? "") ||
				refusalNames.has(bag.constructor?.name ?? "")
			) {
				return value as Error;
			}
			const children = [bag.cause, bag.error, bag.lastError];
			if (Array.isArray(bag.errors)) {
				children.push(...bag.errors);
			}
			for (const child of children) {
				const found = find(child, depth + 1);
				if (found) {
					return found;
				}
			}
			return toSubscriptionPlanExhaustedError({
				responseBody: bag.responseBody ?? value,
				error: bag.error,
				code: bag.code,
			});
		}
		return find(error, 0);
	} catch {
		return null;
	}
}

export function resetPhrase(resetAt: Date | null, now: number): string {
	if (!resetAt || !Number.isFinite(resetAt.getTime())) {
		return "Wait for its limit to reset, then try again.";
	}
	const minutes = Math.max(1, Math.ceil((resetAt.getTime() - now) / 60_000));
	return minutes < 60
		? `It resets in about ${minutes} min.`
		: `It resets in about ${Math.round(minutes / 60)} h.`;
}

/** Configuration verdicts as messages for non-oRPC creation surfaces. */
export function aiConfigurationRefusalMessage(
	error: unknown,
	now = Date.now(),
): string | null {
	try {
		const refusal = findAiConfigurationRefusal(error);
		if (!refusal) {
			return null;
		}
		const names = [refusal.name, refusal.constructor?.name];
		if (names.includes("ChatGptPlanAuthError")) {
			return CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE;
		}
		if (names.includes("SubscriptionPlanExhaustedError")) {
			const resetAt = (refusal as Error & { resetAt?: Date | null })
				.resetAt;
			return `Your ChatGPT plan has no usage left. ${resetPhrase(resetAt ?? null, now)}`;
		}
		return typeof refusal.message === "string" ? refusal.message : null;
	} catch {
		return null;
	}
}
