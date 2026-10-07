import { TokenExchangeError } from "@repo/ai-token";

/**
 * The response an agent gives when exchanging its AI token failed. A member's
 * own ChatGPT plan can refuse here before any model call (Fizzy #2939), and
 * that refusal must reach the person as what it is — a spent window to wait
 * out, or a connection to renew — rather than as a configuration error.
 */
export interface TokenExchangeFailure {
	status: 401 | 409 | 429;
	body: {
		error: string;
		code?: string;
		limitSignal?: {
			kind: "subscription_exhausted" | "subscription_reconnect";
			provider: "openai";
			message: string;
			retryAfterMs?: number;
		};
	};
}

export function tokenExchangeFailure(
	error: unknown,
	fallbackMessage: string,
	now = Date.now(),
): TokenExchangeFailure {
	if (!(error instanceof TokenExchangeError)) {
		return { status: 401, body: { error: fallbackMessage } };
	}
	const message = error.reason ?? fallbackMessage;
	if (error.code === "CHATGPT_PLAN_EXHAUSTED") {
		const resetAt = error.resetAt ? Date.parse(error.resetAt) : Number.NaN;
		return {
			status: 429,
			body: {
				error: message,
				code: error.code,
				limitSignal: {
					kind: "subscription_exhausted",
					provider: "openai",
					message,
					...(!Number.isNaN(resetAt) && {
						retryAfterMs: Math.max(0, resetAt - now),
					}),
				},
			},
		};
	}
	if (error.code === "CHATGPT_PLAN_UNAVAILABLE") {
		return {
			status: 409,
			body: {
				error: message,
				code: error.code,
				limitSignal: {
					kind: "subscription_reconnect",
					provider: "openai",
					message,
				},
			},
		};
	}
	return {
		status: 401,
		body: {
			error: fallbackMessage,
			...(error.code && { code: error.code }),
		},
	};
}
