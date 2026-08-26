/**
 * Cloudflare Turnstile CAPTCHA Verification
 *
 * Server-side utility to verify Turnstile tokens against the Cloudflare API.
 * Skips verification when CAPTCHA is disabled (dev/test environments).
 */

import { logger } from "@repo/logs";
import { createCircuitBreaker } from "./turnstile-circuit-breaker";

const TURNSTILE_VERIFY_URL =
	"https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileVerifyResponse {
	success: boolean;
	"error-codes"?: string[];
	challenge_ts?: string;
	hostname?: string;
}

export interface TurnstileResult {
	success: boolean;
	errorCodes?: string[];
}

const breaker = createCircuitBreaker({
	failureThreshold: 5,
	windowMs: 60_000,
	cooldownMs: 30_000,
});

/**
 * Verify a Turnstile CAPTCHA token with the Cloudflare API.
 *
 * Returns `{ success: true }` immediately if CAPTCHA is disabled
 * via `NEXT_PUBLIC_ENABLE_CAPTCHA` env var (for dev/test environments).
 */
export async function verifyTurnstileToken(
	token: string,
	ip: string,
): Promise<TurnstileResult> {
	// Skip verification if CAPTCHA is disabled
	if (process.env.NEXT_PUBLIC_ENABLE_CAPTCHA !== "true") {
		return { success: true };
	}

	const secretKey = process.env.TURNSTILE_SECRET_KEY;
	if (!secretKey) {
		logger.error(
			{
				event: "captcha.fail_closed",
				reason: "missing-key",
				security: true,
			},
			"TURNSTILE_SECRET_KEY is not configured but CAPTCHA is enabled",
		);
		return { success: false, errorCodes: ["captcha-unavailable"] };
	}

	if (!token) {
		logger.warn(
			{
				event: "auth.captcha.missing_token",
				security: true,
				ip,
			},
			"CAPTCHA token missing from request",
		);
		return { success: false, errorCodes: ["missing-input-response"] };
	}

	if (!breaker.shouldAllow()) {
		logger.warn(
			{ event: "captcha.fail_closed", reason: "circuit-open" },
			"Turnstile circuit breaker open",
		);
		return { success: false, errorCodes: ["captcha-circuit-open"] };
	}

	try {
		const params = new URLSearchParams({
			secret: secretKey,
			response: token,
		});

		if (ip && ip !== "unknown") {
			params.set("remoteip", ip);
		}

		const response = await fetch(TURNSTILE_VERIFY_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params,
		});

		if (!response.ok) {
			logger.error(
				{
					event: "captcha.fail_closed",
					reason: "http-error",
					security: true,
					status: response.status,
				},
				"Turnstile API returned non-OK status",
			);
			breaker.recordFailure();
			return { success: false, errorCodes: ["captcha-unavailable"] };
		}

		// Network round-trip succeeded — circuit breaker is happy regardless of token validity
		breaker.recordSuccess();

		const data = (await response.json()) as TurnstileVerifyResponse;

		if (!data.success) {
			logger.warn(
				{
					event: "auth.captcha.failed",
					security: true,
					ip,
					errorCodes: data["error-codes"],
				},
				"Turnstile verification failed",
			);
			return {
				success: false,
				errorCodes: data["error-codes"] ?? ["unknown-error"],
			};
		}

		return { success: true };
	} catch (error) {
		logger.error(
			{
				event: "captcha.fail_closed",
				reason: "fetch-error",
				security: true,
				error: error instanceof Error ? error.message : String(error),
			},
			"Turnstile verification request failed",
		);
		breaker.recordFailure();
		return { success: false, errorCodes: ["captcha-unavailable"] };
	}
}
