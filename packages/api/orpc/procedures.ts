import { ORPCError, os } from "@orpc/server";
import { auth } from "@repo/auth";
import { getTrustedClientIp } from "@repo/auth/lib/client-ip";
// NOTE: `getTenantContext` comes from `@repo/database` via its index export,
// which transitively loads the Prisma client (needs DATABASE_URL at import
// time). That's fine inside the oRPC server process, but if this file is
// ever imported from a non-DB context (CLI, frontend, test without
// DATABASE_URL), the import will crash at module load. Test files work
// around this by importing from `@repo/database/src/tenant-context`
// directly. Keep this in mind when refactoring: `resolveOrganizationId`
// must stay reachable without pulling Prisma into lightweight consumers.
import {
	getOrganizationMembership,
	getTenantContext,
	StoryVersionConflictError,
} from "@repo/database";
// Type-only import. Runtime class loaded lazily inside the error-mapper
// middleware (see below) to break the @repo/api ↔ @repo/payments
// module-init cycle: payloads.ts evaluates `NotificationType.STORY_MENTION`
// at module load, which crashes any test with an incomplete vi.mock for
// @repo/database.
import type { AiUsageLimitExceededError as AiUsageLimitExceededErrorType } from "@repo/payments";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "../lib/rate-limit";
import {
	type ActivityCaptureMeta,
	auditActivityMiddleware,
} from "./middleware/audit-activity-middleware";
import { auditErrorMiddleware } from "./middleware/audit-error-middleware";
import { auditTimingMiddleware } from "./middleware/audit-timing-middleware";
import { errorMetricsMiddleware } from "./middleware/error-metrics-middleware";
import { requestCounterMiddleware } from "./middleware/request-counter-middleware";
import {
	getOrganizationIdFromContext,
	getTenantFilterFromContext,
	tenantContextMiddleware,
} from "./middleware/tenant-context-middleware";
import { touchLastSeenMiddleware } from "./middleware/touch-last-seen";

/**
 * Root public procedure.
 *
 * Three middlewares are mounted here, in this order:
 *   1. {@link requestCounterMiddleware} — increments `http_requests_total`
 *      for EVERY request (success or failure). This is the denominator
 *      for the burn-rate alert rules in app-errors.yml; if a request
 *      doesn't pass through this middleware, the burn-rate math is wrong.
 *   2. {@link errorMetricsMiddleware} — increments `app_errors_total` only
 *      when the handler throws.
 *   3. {@link auditErrorMiddleware} — automatic audit-log capture for any
 *      thrown value (D16). Re-throws the original error unchanged; never
 *      throws from the capture path itself. Mounted AFTER the metric
 *      middlewares so the request/error counters still fire on procedures
 *      whose audit-capture itself fails for any reason.
 *
 * All three middlewares must run BEFORE auth so that procedures throwing
 * UNAUTHORIZED still increment the right counters / capture the right
 * audit rows.
 */
export const publicProcedure = os
	.$context<{
		headers: Headers;
	}>()
	// Declares the meta vocabulary so a procedure can override the automatic
	// activity-capture decision with `.meta({ auditActivity: "never" })`. The
	// automatic rule in `audit-activity-middleware` is right for the whole
	// repository today; this exists so the exception does not require changing
	// the middleware.
	.$meta<{ auditActivity?: ActivityCaptureMeta }>({})
	.use(requestCounterMiddleware)
	.use(errorMetricsMiddleware)
	.use(auditErrorMiddleware)
	// auditTimingMiddleware mounts INSIDE auditErrorMiddleware so the
	// ALS frame is active for every audit row emitted during the
	// handler. The frame closes automatically when the handler returns
	// or throws; recordAuditFromRequest reads `getAuditTimingDurationMs`
	// synchronously while assembling the row.
	.use(auditTimingMiddleware);

/**
 * Rate limited public procedure
 * Uses IP-based rate limiting with configurable limits
 */
export const rateLimitedPublicProcedure = publicProcedure.use(
	async ({ context, next, path }) => {
		const ip = getTrustedClientIp(context.headers);
		const key = `public:${ip}:${path}`;
		const { limit, windowMs } = RATE_LIMIT_PRESETS.public;

		const result = await checkRateLimit(key, limit, windowMs);

		if (!result.allowed) {
			if (result.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Rate limit exceeded. Please try again in ${result.resetInSeconds} seconds.`,
			});
		}

		return await next();
	},
);

/**
 * Domain error mapper.
 * Catches `AiUsageLimitExceededError` thrown anywhere downstream of any
 * protected procedure (typically from `getAIModelWithMetadata` /
 * `getAIEmbeddingModelWithMetadata` per) and re-throws it as
 * a structured `ORPCError` so the client receives `code:
 * "AI_USAGE_LIMIT_EXCEEDED"` with the rich payload intact. Without this
 * step `toORPCError(e)` defaults to `INTERNAL_SERVER_ERROR` and drops
 * `code` + `data`, making the / contract
 * un-implementable on the client.
 * Wired as the outermost middleware on {@link protectedProcedure} so
 * every authenticated procedure (including `tenantProtectedProcedure`,
 * which extends it) participates in the mapping. Only the AI-usage error
 * is intercepted; every other thrown value is rethrown unchanged so
 * existing error semantics (FORBIDDEN, NOT_FOUND, etc.) are unaffected.
 * `data` payload mirrors the wire-shape consumed by the client toast
 * helper (`apps/web/modules/saas/payments/lib/ai-usage-limit-toast.tsx`):
 * BigInts coerced to strings so the JSON serializer doesn't choke and the
 * client side does not need a BigInt polyfill.
 *
 * `StoryVersionConflictError` is mapped for the same reason: a lost
 * optimistic-concurrency race on a work item is an ordinary, retryable CONFLICT,
 * but as a bare `Error` it defaulted to INTERNAL_SERVER_ERROR with its message
 * replaced by "Internal server error" — so the one thing that would tell a user
 * what happened was the thing that got discarded. The story editor autosaves
 * every 10s while the AI assistant can write the same row, so the race is
 * reachable in ordinary use. Whether it accounts for any particular report of
 * that toast is NOT established; it is fixed here because a routine, retryable
 * conflict should never have presented as an internal error.
 */
const domainErrorMapper = os
	.$context<{ headers: Headers }>()
	.middleware(async ({ next }) => {
		try {
			return await next();
		} catch (error) {
			if (error instanceof StoryVersionConflictError) {
				throw new ORPCError("CONFLICT", {
					message: error.message,
					// Which row lost the race. The message is deliberately
					// generic (it is shown to the user), so without this the
					// client and the audit trail cannot tell one conflict from
					// another when several work items are open.
					data: { storyId: error.storyId },
				});
			}
			// Duck-type the code first so non-AI errors don't pay the
			// dynamic-import lookup. Lazy class load breaks the
			// @repo/api ↔ @repo/payments module-init cycle.
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				(error as { code: unknown }).code === "AI_USAGE_LIMIT_EXCEEDED"
			) {
				const { AiUsageLimitExceededError } = await import(
					"@repo/payments"
				);
				if (error instanceof AiUsageLimitExceededError) {
					const e: AiUsageLimitExceededErrorType = error;
					throw new ORPCError("AI_USAGE_LIMIT_EXCEEDED", {
						message: e.message,
						data: {
							limitId: e.limitId,
							dimension: e.dimension,
							window: e.window,
							used: e.used.toString(),
							max: e.max.toString(),
							manageLimitsUrl: e.manageLimitsUrl,
						},
					});
				}
			}
			throw error;
		}
	});

export const protectedProcedure = publicProcedure
	.use(domainErrorMapper)
	.use(async ({ context, next }) => {
		const session = await auth.api.getSession({
			headers: context.headers,
		});

		if (!session) {
			throw new ORPCError("UNAUTHORIZED");
		}

		return await next({
			context: {
				session: session.session,
				user: session.user,
			},
		});
	})
	// Every authenticated oRPC call (from a browser session)
	// updates the caller's lastSeenAt (throttled, un-awaited). Must stay
	// AFTER the session middleware — it reads context.user.
	.use(touchLastSeenMiddleware)
	// Automatic activity capture for successful state-changing calls. Mounted
	// on the PROTECTED chain rather than the public one because an audit row
	// needs an actor: unauthenticated calls have none, and the auth events
	// that matter already have curated actions.
	//
	// Mounted LAST so it wraps the innermost handler and observes the real
	// output, and so a curated row emitted by the handler has already set the
	// dedup flag by the time this middleware decides whether to write.
	.use(auditActivityMiddleware);

/**
 * Tenant-isolated protected procedure.
 * Use this for any procedure that needs tenant isolation:
 * - All queries through getTenantDb will be auto-filtered
 * - TenantContext is available in context.tenantContext
 * @example
 * ```ts
 * export const myProcedure = tenantProtectedProcedure
 *.input(z.object({ name: z.string }))
 *.handler(async ({ input, context }) => {
 * // context.tenantContext contains current tenant info
 * // Use getTenantDb for auto-filtered queries
 * const configs = await getTenantDb.mCPConfig.findMany;
 * });
 * ```
 */
export const tenantProtectedProcedure = protectedProcedure.use(
	tenantContextMiddleware,
);

// Re-export helpers for convenience
export { getOrganizationIdFromContext, getTenantFilterFromContext };
export { Permissions } from "@repo/permissions";
export {
	getPermissionFromMiddleware,
	PERMISSION_MIDDLEWARE_TAG,
	requireInputOrgPermission,
	requirePermission,
	requirePermissionAllowGuest,
	requireProjectPermission,
} from "./middleware/require-permission";

/**
 * Rate limited protected procedure with standard limits
 * Rate limits per user ID
 */
export const rateLimitedProcedure = protectedProcedure.use(
	async ({ context, next, path }) => {
		const key = `user:${context.user.id}:${path}`;
		const { limit, windowMs } = RATE_LIMIT_PRESETS.standard;

		const result = await checkRateLimit(key, limit, windowMs);

		if (!result.allowed) {
			if (result.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Rate limit exceeded. Please try again in ${result.resetInSeconds} seconds.`,
			});
		}

		return await next();
	},
);

/**
 * The AI rate limit, as a middleware rather than only a base procedure.
 *
 * `aiRateLimitedProcedure` below builds on `protectedProcedure`, so a
 * tenant-scoped procedure could not adopt the limit without giving up tenant
 * resolution — which is why the limit had no call sites at all while the
 * expensive endpoints went uncapped. Exported separately so any procedure can
 * `.use()` it and keep its own base.
 */
export async function enforceAiRateLimit(
	userId: string,
	path: readonly string[] | string,
	preset: { limit: number; windowMs: number } = RATE_LIMIT_PRESETS.ai,
): Promise<void> {
	const key = `ai:${userId}:${path}`;

	const result = await checkRateLimit(key, preset.limit, preset.windowMs);
	if (result.allowed) {
		return;
	}
	if (result.statusCode === 503) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Rate limit service temporarily unavailable",
		});
	}
	throw new ORPCError("TOO_MANY_REQUESTS", {
		message: `AI rate limit exceeded. Please try again in ${result.resetInSeconds} seconds.`,
	});
}

/**
 * Rate limited procedure for AI operations (stricter limits)
 */
export const aiRateLimitedProcedure = protectedProcedure.use(
	async ({ context, next, path }) => {
		await enforceAiRateLimit(context.user.id, path);
		return await next();
	},
);

/**
 * Rate limited procedure for workflow operations
 */
export const workflowRateLimitedProcedure = protectedProcedure.use(
	async ({ context, next, path }) => {
		const key = `workflow:${context.user.id}:${path}`;
		const { limit, windowMs } = RATE_LIMIT_PRESETS.workflow;

		const result = await checkRateLimit(key, limit, windowMs);

		if (!result.allowed) {
			if (result.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Workflow rate limit exceeded. Please try again in ${result.resetInSeconds} seconds.`,
			});
		}

		return await next();
	},
);

/**
 * Rate limited procedure for agent operations
 */
export const agentRateLimitedProcedure = protectedProcedure.use(
	async ({ context, next, path }) => {
		const key = `agent:${context.user.id}:${path}`;
		const { limit, windowMs } = RATE_LIMIT_PRESETS.agent;

		const result = await checkRateLimit(key, limit, windowMs);

		if (!result.allowed) {
			if (result.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Agent rate limit exceeded. Please try again in ${result.resetInSeconds} seconds.`,
			});
		}

		return await next();
	},
);

export const adminProcedure = protectedProcedure.use(
	async ({ context, next }) => {
		if (context.user.role !== "admin") {
			throw new ORPCError("FORBIDDEN");
		}

		return await next();
	},
);

/**
 * Helper to resolve organizationId from input or session.
 * Fallback priority (highest → lowest):
 * 1. **Explicit non-null `input.organizationId`.** Caller knows exactly
 * which org they want.
 * 2. **`tenantContext.effectiveWriteOrgId`.** Set by the permission
 * middleware *this request* via `grantProjectAccess` AFTER verifying
 * the caller has an accepted ProjectMember row on a project in that
 * org. Required for the cross-org guest write path: the guest's
 * session has no active org, so their client sends
 * `organizationId: null`, but their writes must still land in the
 * host org. This signal is safe to prefer over explicit-null because
 * (a) it was set *this* request, not carried from stale session, and
 * (b) the only production caller of `grantProjectAccess` is the
 * permission middleware's guest path, which verifies access first.
 * See the authorization contract on `grantProjectAccess` itself.
 * 3. **Explicit `input.organizationId === null`.** Explicit personal
 * context. Used by clients that want to force the personal tenant
 * even though their session may have an active org.
 * 4. **`session.activeOrganizationId`.** Session-level fallback when
 * input was `undefined` (not explicitly passed).
 * 5. **`undefined`.** Fully personal, no org context.
 * Clients SHOULD pass `null` when they want personal context (e.g.
 * /app/projects), but be aware that a verified guest write inside the
 * same request will still be routed to the host org via #2 above. That
 * is the intended security invariant: once authorized, writes go to the
 * correct tenant regardless of what the client passed.
 * @example
 * ```ts
 * export const myProcedure = protectedProcedure
 *.input(z.object({ organizationId: z.string.nullable.optional,.. }))
 *.handler(async ({ input, context }) => {
 * const organizationId = resolveOrganizationId(input.organizationId, context.session);
 * });
 * ```
 */
export function resolveOrganizationId(
	inputOrganizationId: string | null | undefined,
	session: { activeOrganizationId?: string | null },
): string | undefined {
	// Explicit organizationId string provided
	if (inputOrganizationId) {
		return inputOrganizationId;
	}
	// The permission middleware's `effectiveWriteOrgId` is the strongest
	// signal available — it was set THIS request after verifying the caller
	// has project-scoped access to a project in that org. It wins over
	// *every* other source, including explicit-null input, because:
	// - Cross-org guests hit pages with `organizationId: null` in input
	// (their session has no active org) but their writes must land in
	// the host org, not in a personal tenant.
	// - Stale session leakage is not a concern here: this value was set
	// by the middleware on THIS request, not carried from session.
	const ctx = getTenantContext();
	if (ctx.effectiveWriteOrgId) {
		return ctx.effectiveWriteOrgId;
	}
	// Explicit null means personal context - DO NOT fall back to session.
	// This prevents security issues where stale session org data leaks to
	// personal pages.
	if (inputOrganizationId === null) {
		return undefined;
	}
	// Fall back to session when input was truly undefined (not explicitly passed)
	if (session.activeOrganizationId) {
		return session.activeOrganizationId;
	}
	return undefined;
}

/**
 * Helper function to verify organization membership and throw appropriate errors.
 * Use this in handlers where organizationId is required:
 * @example
 * ```ts
 * export const myProcedure = protectedProcedure
 *.input(z.object({ organizationId: z.string,.. }))
 *.handler(async ({ input, context }) => {
 * const membership = await requireOrganizationMembership(
 * input.organizationId,
 * context.user.id,
 *);
 * // membership.organization and membership.role are available
 * });
 * ```
 */
export async function requireOrganizationMembership(
	organizationId: string,
	userId: string,
	allowedRoles?: string[],
) {
	const membership = await getOrganizationMembership(organizationId, userId);

	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You are not a member of this organization",
		});
	}

	if (allowedRoles && allowedRoles.length > 0) {
		if (!allowedRoles.includes(membership.role)) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You do not have the required role in this organization",
			});
		}
	}

	return {
		organization: membership.organization,
		role: membership.role,
	};
}

/**
 * Helper function to verify organization admin/owner role.
 * @example
 * ```ts
 * const membership = await requireOrganizationAdmin(organizationId, userId);
 * ```
 */
export async function requireOrganizationAdmin(
	organizationId: string,
	userId: string,
) {
	return requireOrganizationMembership(organizationId, userId, [
		"admin",
		"owner",
	]);
}
