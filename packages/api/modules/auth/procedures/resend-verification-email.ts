import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { auth } from "@repo/auth";
import { getTrustedClientIp } from "@repo/auth/lib/client-ip";
import { verifyTurnstileToken } from "@repo/auth/lib/turnstile";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { checkRateLimit } from "../../../lib/rate-limit";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";

const PER_MINUTE_WINDOW_MS = 60_000;

/**
 * Extract client IP using trusted ingress headers. Falls back to a
 * user-agent fingerprint so different clients without forwarding headers
 * don't share a single rate-limit bucket.
 */
function getClientIp(headers: Headers): string {
	const trusted = getTrustedClientIp(headers);
	if (trusted !== "unknown") {
		return trusted;
	}

	const ua = headers.get("user-agent") ?? "unknown";
	let hash = 0;
	for (let i = 0; i < ua.length; i++) {
		hash = (hash << 5) - hash + ua.charCodeAt(i);
		hash = hash & hash;
	}
	return `fingerprint:${hash.toString(36)}`;
}

/**
 * Core handler logic for resending email verification.
 * Exported separately so it can be unit-tested without the oRPC middleware chain.
 */
export async function resendVerificationEmailHandler({
	input,
	context,
}: {
	input: { email: string; captchaToken: string };
	context: { headers: Headers };
}) {
	const normalizedEmail = input.email.toLowerCase().trim();
	const clientIp = getClientIp(context.headers);

	// 0. CAPTCHA
	const captcha = await verifyTurnstileToken(input.captchaToken, clientIp);
	if (!captcha.success) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Captcha verification failed",
			data: { code: "CAPTCHA_INVALID" },
		});
	}

	// 1. Global cap: 1000 requests per hour across all IPs
	const globalCheck = await checkRateLimit(
		"verify-resend:global",
		1000,
		3_600_000,
	);
	if (!globalCheck.allowed) {
		if (globalCheck.statusCode === 503) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Rate limit service temporarily unavailable",
			});
		}
		logger.warn(
			{ event: "resend_verification.global_cap" },
			"global cap engaged",
		);
		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: "Service temporarily unavailable",
		});
	}

	// 2. Per-IP rate limit: 10 requests per hour
	const ipCheck = await checkRateLimit(
		`verify-resend:ip:${clientIp}`,
		10,
		3_600_000,
	);
	if (!ipCheck.allowed) {
		if (ipCheck.statusCode === 503) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Rate limit service temporarily unavailable",
			});
		}
		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: "Please try again later or contact support.",
			data: { retryAfter: ipCheck.resetInSeconds },
		});
	}

	// 3. Per-email hourly rate limit: 3 requests per hour
	const emailHash = createHash("sha256")
		.update(normalizedEmail)
		.digest("hex");
	const emailHourlyCheck = await checkRateLimit(
		`verify-resend:email-hr:${emailHash}`,
		3,
		3_600_000,
	);
	if (!emailHourlyCheck.allowed) {
		if (emailHourlyCheck.statusCode === 503) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Rate limit service temporarily unavailable",
			});
		}
		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: "Please try again later or contact support.",
			data: { retryAfter: emailHourlyCheck.resetInSeconds },
		});
	}

	// 4. Per-email sliding window: 1 request per 60 seconds
	// With limit=1, the fixed-window checkRateLimit effectively acts as a
	// sliding window: the first call sets the window, the second is blocked
	// until it expires. resetInSeconds reflects the real remaining time.
	const emailMinuteCheck = await checkRateLimit(
		`verify-resend:email:${emailHash}`,
		1,
		PER_MINUTE_WINDOW_MS,
	);
	if (!emailMinuteCheck.allowed) {
		if (emailMinuteCheck.statusCode === 503) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Rate limit service temporarily unavailable",
			});
		}
		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: "Please try again later or contact support.",
			data: {
				retryAfter: emailMinuteCheck.resetInSeconds,
				isPerMinuteLimit: true,
			},
		});
	}

	// 5. Check if user exists and whether already verified
	const user = await db.user.findFirst({
		where: { email: normalizedEmail },
		select: { emailVerified: true },
	});

	// Return identical response for non-existent AND verified emails
	// to prevent email enumeration. An attacker cannot distinguish
	// "doesn't exist" from "exists but verified" from "exists and unverified".
	if (!user || user.emailVerified) {
		return {
			success: true as const,
			alreadyVerified: false as const,
			resetInSeconds: PER_MINUTE_WINDOW_MS / 1000,
		};
	}

	// 6. Send verification email via Better Auth server API
	await auth.api.sendVerificationEmail({
		body: { email: normalizedEmail },
	});

	return {
		success: true as const,
		alreadyVerified: false as const,
		resetInSeconds: PER_MINUTE_WINDOW_MS / 1000,
	};
}

/**
 * Resend email verification link.
 *
 * Public procedure (user is unauthenticated on login page).
 * Enforces CAPTCHA, global hourly cap, per-IP hourly, per-email hourly,
 * and per-email per-minute rate limits.
 * Prevents email enumeration by returning identical responses for all cases.
 */
export const resendVerificationEmail = publicProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/auth/resend-verification-email",
		tags: ["Auth"],
		summary: "Resend email verification link",
	})
	.input(
		z.object({
			email: z.string().email(),
			captchaToken: z.string().min(1),
		}),
	)
	.handler(resendVerificationEmailHandler);
