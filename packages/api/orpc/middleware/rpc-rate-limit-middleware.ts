/**
 * Global per-caller request limiter for every oRPC procedure.
 *
 * Until this existed the only limiters in the API were opt-in builders
 * (`rateLimitedProcedure`, `aiRateLimitedProcedure`, ...) that no module
 * procedure actually used, plus a handful of per-route `checkRateLimit`
 * calls. A single authenticated caller could therefore issue an unbounded
 * number of requests against any of the ~1,000 procedures. This middleware
 * is the floor under all of them: a wide per-caller budget that ordinary UI
 * traffic never approaches, that a runaway client or a scripted abuser does.
 *
 * Keying: `rpc:user:<id>` once a session has been established, otherwise
 * `rpc:ip:<client-ip>` using the same trusted-proxy IP extraction the rest
 * of the codebase relies on. The public and protected chains in
 * `procedures.ts` each mount this exactly once, so a request is counted in
 * one bucket only — an office behind a single NAT address shares a budget
 * only for the unauthenticated public procedures (webhooks, OAuth
 * callbacks), never for signed-in use.
 *
 * Budget: `RPC_RATE_LIMIT_PER_MINUTE`, default 1000 requests per minute per
 * key. `0` disables the limiter. The default is deliberately generous — the
 * authenticated shell is chatty (the CopilotKit route alone budgets 500/min
 * per user) and this is an abuse ceiling, not a product quota. The per-route
 * limiters keep their own, tighter keys and are unaffected.
 *
 * Failure semantics are exactly those of `checkRateLimit`: in production with
 * Redis unreachable the check fails closed as 503, elsewhere it falls back to
 * the in-memory store. Nothing here changes that.
 */

import { ORPCError, os } from "@orpc/server";
import { getTrustedClientIp } from "@repo/auth/lib/client-ip";
import { logger } from "@repo/logs";
import { checkRateLimit } from "../../lib/rate-limit";

export const RPC_RATE_LIMIT_ENV = "RPC_RATE_LIMIT_PER_MINUTE";
export const RPC_RATE_LIMIT_DEFAULT_PER_MINUTE = 1000;
export const RPC_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Resolve the per-minute budget from the environment.
 *
 * Unset or blank means the default. `0` means disabled. Anything that is not
 * a non-negative integer is refused and the default applies — a typo in an
 * env file must never silently disable the limiter (fail-open) or set it to
 * `NaN` (which would refuse every request).
 */
export function resolveRpcRateLimitPerMinute(
	raw: string | undefined = process.env[RPC_RATE_LIMIT_ENV],
): number {
	if (raw === undefined || raw.trim() === "") {
		return RPC_RATE_LIMIT_DEFAULT_PER_MINUTE;
	}
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		logger.warn(
			{ event: "ratelimit.rpc.invalid_config", value: trimmed },
			`${RPC_RATE_LIMIT_ENV} is not a non-negative integer; using the default of ${RPC_RATE_LIMIT_DEFAULT_PER_MINUTE}`,
		);
		return RPC_RATE_LIMIT_DEFAULT_PER_MINUTE;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed)
		? parsed
		: RPC_RATE_LIMIT_DEFAULT_PER_MINUTE;
}

export interface RpcRateLimitContext {
	headers: Headers;
	/** Injected by `ResponseHeadersPlugin` on the HTTP handlers; absent for
	 *  in-process callers (server components, tests), where there is no
	 *  response to decorate. */
	resHeaders?: Headers;
	/** Present once the session middleware has run. Optional so the same
	 *  middleware serves the public chain, where it never is. */
	user?: { id: string };
}

/**
 * Which bucket a request is charged to. Exported so the tests can pin the
 * user-vs-IP decision without driving the whole middleware.
 */
export function rpcRateLimitKey(context: RpcRateLimitContext): {
	key: string;
	userId?: string;
	ip?: string;
} {
	if (context.user?.id) {
		return { key: `rpc:user:${context.user.id}`, userId: context.user.id };
	}
	const ip = getTrustedClientIp(context.headers);
	return { key: `rpc:ip:${ip}`, ip };
}

export const rpcRateLimitMiddleware = os
	.$context<RpcRateLimitContext>()
	.middleware(async ({ context, next, path }) => {
		const limit = resolveRpcRateLimitPerMinute();
		if (limit === 0) {
			return await next();
		}

		const { key, userId, ip } = rpcRateLimitKey(context);
		const result = await checkRateLimit(
			key,
			limit,
			RPC_RATE_LIMIT_WINDOW_MS,
		);

		if (result.allowed) {
			return await next();
		}

		const retryAfter = Math.max(1, result.resetInSeconds);
		// Set on 503 as well as 429 so a client knows when to come back either
		// way — the same choice `authRateLimitMiddleware` makes.
		context.resHeaders?.set("Retry-After", String(retryAfter));

		if (result.statusCode === 503) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Rate limit service temporarily unavailable",
			});
		}

		logger.warn(
			{
				event: "ratelimit.rpc.exceeded",
				userId,
				ip,
				path: path.join("."),
				limit,
				retryAfter,
			},
			"Global RPC rate limit exceeded",
		);

		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
			data: { retryAfter },
		});
	});
