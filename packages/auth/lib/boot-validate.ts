import { logger } from "@repo/logs";

// Next.js sets this during `next build` page-data collection. Runtime secrets
// (TURNSTILE_SECRET_KEY, UPSTASH_*) often aren't injected at that phase, so
// boot guards must defer to runtime invocation.
function isNextBuildPhase(): boolean {
	return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * Validates auth env at module-load time and throws on misconfigurations that
 * would silently fail-open in production:
 *  - CAPTCHA enabled without `TURNSTILE_SECRET_KEY`.
 *  - A missing / default / weak `BETTER_AUTH_SECRET` in production (forgeable
 *    sessions).
 * Called from auth.ts; the rate-limit variant is called from the API layer.
 */
export function validateAuthBootEnv(): void {
	if (isNextBuildPhase()) {
		return;
	}
	const captchaEnabled = process.env.NEXT_PUBLIC_ENABLE_CAPTCHA === "true";
	const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
	if (captchaEnabled && !turnstileSecret) {
		throw new Error(
			"CAPTCHA enabled but TURNSTILE_SECRET_KEY missing — refuse to boot.",
		);
	}

	// BETTER_AUTH_SECRET underpins session/cookie signing — if it is unset or
	// left at Better Auth's well-known default, sessions become forgeable (a
	// silent fail-open). Better Auth 1.6.x throws on the exact default secret in
	// production, but not on an unset var at this layer and not on a weak/short
	// secret; enforce a strong secret here as a first-party, tested guard.
	// Production-only so local dev / tests keep working without a secret set.
	if (process.env.NODE_ENV === "production") {
		const authSecret =
			process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET;
		const DEFAULT_BETTER_AUTH_SECRET =
			"better-auth-secret-12345678901234567890";
		if (
			!authSecret ||
			authSecret === DEFAULT_BETTER_AUTH_SECRET ||
			authSecret.length < 32
		) {
			throw new Error(
				"BETTER_AUTH_SECRET must be set to a strong (>=32 char) value in production — refuse to boot (an unset/default/weak secret makes sessions forgeable).",
			);
		}
	}

	logger.info({ event: "boot.auth.validated" }, "auth env validated");
}

export function validateRateLimitBootEnv(): void {
	if (isNextBuildPhase()) {
		return;
	}
	if (process.env.NODE_ENV !== "production") {
		return;
	}
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		throw new Error(
			"Production rate-limit requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
		);
	}
	logger.info(
		{ event: "boot.ratelimit.validated" },
		"ratelimit env validated",
	);
}
