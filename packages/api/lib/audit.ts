/**
 * Request-context wrapper around `recordAudit` for oRPC procedure callsites.
 *
 * The bare `recordAudit` helper in `@repo/database` has no request-context
 * awareness; this wrapper pulls `ipAddress` (via `getTrustedClientIp`),
 * `userAgent`, `requestId`, `sessionId`, and `impersonatedById` from the
 * active oRPC context so individual procedures do not have to read the
 * headers themselves. It also defaults the actor from `context.user` when
 * the caller did not specify one (the typical logged-in-user case).
 *
 * Like `recordAudit`, this helper NEVER throws -- failures route through
 * `onAuditWriteFailure` (structured log + Prometheus counter + stdout
 * fallback). Callers that need transactional parity with the originating
 * mutation should use `recordAuditTx` directly.
 *
 * Spec: docs/audit-log/README.md §7.1
 */

import { getTrustedClientIp } from "@repo/auth/lib/client-ip";
import {
	ERROR_CATEGORY,
	isActivityAction,
	type RecordAuditInput,
	recordAudit,
	setAuditCounters,
	setPrismaQueryObserver,
} from "@repo/database";
import { auditWriteFailures, auditWritesTotal } from "@repo/observability";
import {
	getAuditTimingDurationMs,
	markCuratedAuditWritten,
} from "../orpc/middleware/audit-timing-middleware";
import {
	extractCorrelationId,
	getCorrelationIdFromContext,
} from "./correlation-id";
import { instrumentPrismaQuery } from "./request-span";

/**
 * Wire the audit-log counters from `@repo/observability` into the
 * `@repo/database` helper module. Must be called once at API startup
 * (before any audit event would be emitted). Idempotent.
 *
 * Lives here rather than inside `@repo/database` because the database
 * package deliberately does NOT depend on `@repo/observability` (would
 * create a circular dependency with the metrics route registration).
 */
export function wireAuditObservability(): void {
	setAuditCounters({
		incFailure: (action, category) =>
			auditWriteFailures.inc({ action, category }),
		incWrite: (action, category, outcome) =>
			auditWritesTotal.inc({ action, category, outcome }),
	});
	// Install the query observer that buffers a `db` span for every query. It is
	// a no-op outside a `runWithRequestSpanContext` frame, so background workers
	// (Temporal, retention) pay only the frame lookup.
	//
	// This previously used `db.$use(...)` behind a `typeof db.$use === "function"`
	// guard. Prisma 6 removed `$use`, so the guard was always false and NO db span
	// was ever captured — for months, while the traced-request API kept
	// advertising "low-level spans (db / temporal / http)". `setPrismaQueryObserver`
	// is a required export rather than an optional method, so the same mistake now
	// fails at compile time instead of silently doing nothing.
	setPrismaQueryObserver(({ model, operation, args, query }) =>
		instrumentPrismaQuery({ model, operation, args, query }),
	);
}

/**
 * Request context shape expected by `recordAuditFromRequest`. Mirrors
 * the shape the oRPC `protectedProcedure` already provides -- `headers`
 * from the public procedure, plus `user` and `session` from the
 * `protectedProcedure.use` middleware.
 *
 * Defined inline rather than imported to avoid pulling Better Auth
 * types into this module (and to keep the helper callable from any
 * shape-compatible caller including tests).
 */
export interface AuditRequestContext {
	/**
	 * Request headers. Optional because some procedure-test harnesses build
	 * a synthetic context without the public-procedure `headers` field. When
	 * missing, IP / UA / requestId all default to `null` rather than crash.
	 */
	headers?: Headers;
	user?: {
		id: string;
		email: string;
		name?: string | null;
	} | null;
	session?: {
		id: string;
		impersonatedBy?: string | null;
		activeOrganizationId?: string | null;
	} | null;
}

/**
 * Input accepted by `recordAuditFromRequest`. Omits the request-context
 * fields (ip / ua / requestId / sessionId / impersonatedById) because we
 * read them from `context`. `actor` is optional -- when missing we
 * default to the logged-in user from `context.user`.
 */
export type RecordAuditFromRequestInput = Omit<
	RecordAuditInput,
	"actor" | "ipAddress" | "userAgent" | "requestId" | "sessionId"
> & {
	actor?: Partial<RecordAuditInput["actor"]>;
	/**
	 * Optional explicit override of the procedure-timing value. Useful for
	 * Temporal activities that want to log their own measured wall-clock
	 * time. When omitted, the helper reads from the
	 * `auditTimingMiddleware`'s AsyncLocalStorage frame.
	 */
	durationMs?: number | null;
};

/**
 * Read the request ID from the active headers. Falls back to
 * `x-correlation-id` (used by the existing correlation middleware) so
 * a single audit row can be correlated to a full request trace.
 */
function readRequestId(headers: Headers): string | null {
	const requestId = headers.get("x-request-id");
	if (requestId && requestId.trim().length > 0) {
		return requestId.trim();
	}
	const correlationId = headers.get("x-correlation-id");
	if (correlationId && correlationId.trim().length > 0) {
		return correlationId.trim();
	}
	return null;
}

/**
 * Resolve the correlation ID for this audit row.
 *
 * Priority (D16):
 *   1. AsyncLocalStorage (`getCorrelationIdFromContext`) — set by
 *      `asyncCorrelationMiddleware` on the Hono request boundary. Wins
 *      over the header because it is the same value end-to-end through
 *      any nested async hops (Prisma queries, fetch calls, child
 *      activities), so a downstream emitter and an outer emitter agree.
 *   2. Header (`extractCorrelationId`) — for callers that did not run
 *      through `asyncCorrelationMiddleware` (e.g. a future ingress
 *      that forgot the middleware). Defense in depth.
 *   3. `null` — middleware is the canonical generator; we do NOT
 *      synthesize one here, otherwise two emitters in the same request
 *      would generate different IDs and the audit trail would not
 *      group cleanly.
 */
function resolveCorrelationId(headers: Headers | undefined): string | null {
	const fromContext = getCorrelationIdFromContext();
	if (fromContext && fromContext.length > 0) {
		return fromContext;
	}
	if (headers) {
		const fromHeader = extractCorrelationId(headers);
		if (fromHeader && fromHeader.length > 0) {
			return fromHeader;
		}
	}
	return null;
}

/**
 * Default-actor builder. When the caller does not pass an actor we
 * assume the logged-in user from `context.user` made the action. If
 * there is no user (e.g. unauthenticated callsite that somehow
 * reaches this helper), the actor falls back to `type: "system"`.
 */
function resolveActor(
	context: AuditRequestContext,
	override: Partial<RecordAuditInput["actor"]> | undefined,
): RecordAuditInput["actor"] {
	const impersonatedById = context.session?.impersonatedBy ?? null;

	if (override?.type) {
		// Caller provided a complete actor; merge impersonation defaulting
		return {
			...override,
			impersonatedById: override.impersonatedById ?? impersonatedById,
		} as RecordAuditInput["actor"];
	}

	if (context.user) {
		return {
			type: "user",
			userId: context.user.id,
			emailSnapshot: context.user.email,
			nameSnapshot: context.user.name ?? null,
			impersonatedById,
			...(override ?? {}),
		};
	}

	return {
		type: "system",
		userId: null,
		emailSnapshot: null,
		nameSnapshot: null,
		impersonatedById,
		...(override ?? {}),
	};
}

/**
 * Record an audit event from an oRPC procedure handler. Pulls request
 * context from `context.headers` / `context.session` so the caller only
 * has to think about the event itself (action / category / resource /
 * outcome / metadata).
 *
 * Never throws. Snapshot fields populated from `context.user` when no
 * explicit actor is provided.
 *
 * @example
 * ```ts
 * recordAuditFromRequest(context, {
 *   action: "org.member.invited",
 *   organizationId,
 *   resource: { type: "user", id: invitedUserId, name: invitedEmail },
 *   metadata: { role: "admin" },
 * });
 * ```
 */
export function recordAuditFromRequest(
	context: AuditRequestContext,
	input: RecordAuditFromRequestInput,
): void {
	const actor = resolveActor(context, input.actor);
	// `context.headers` is optional so the wrapper survives synthetic
	// procedure-test contexts that omit the public-procedure `headers`
	// field. Production callers always pass a real `Headers` instance.
	const headers = context.headers;
	const ipAddress = headers ? getTrustedClientIp(headers) || null : null;
	const userAgent = headers?.get("user-agent") ?? null;
	const requestId = headers ? readRequestId(headers) : null;
	const sessionId = context.session?.id ?? null;
	// Caller can override (e.g. a Temporal activity wrapping a request
	// emit with its workflow runId). Otherwise resolve from
	// AsyncLocalStorage first, then headers.
	const correlationId =
		input.correlationId !== undefined
			? input.correlationId
			: resolveCorrelationId(headers);

	// Read the elapsed wall-clock time from the auditTimingMiddleware's
	// AsyncLocalStorage frame. Returns null when called outside the
	// middleware (Temporal activities, tests). Caller can also pass an
	// explicit `durationMs` to override (e.g. a Temporal activity might
	// want to log its own measured time).
	const durationMs =
		typeof input.durationMs === "number"
			? input.durationMs
			: getAuditTimingDurationMs();

	// In production `recordAudit` is always defined; in unit tests that
	// `vi.mock("@repo/database", ...)` without re-exporting `recordAudit`,
	// the imported binding may throw or be undefined when invoked. Per D9
	// we never want a missing audit helper to break the originating
	// mutation, so we swallow any error from the call site itself. (The
	// helper is already fire-and-forget in production — failures route
	// through `onAuditWriteFailure`.)
	try {
		recordAudit({
			...input,
			actor,
			ipAddress: ipAddress === "unknown" ? null : ipAddress,
			userAgent,
			requestId,
			sessionId,
			correlationId,
			durationMs,
		});
		// Tell the automatic activity middleware that this procedure already
		// recorded a purpose-built event, so it does not also emit a generic
		// `activity.*` row for the same call. `error.*` rows do not count:
		// an error capture describes a FAILED call, and suppressing the
		// activity row on its account would lose the record of the attempt.
		if (
			!isActivityAction(input.action) &&
			input.category !== ERROR_CATEGORY
		) {
			markCuratedAuditWritten();
		}
	} catch {
		// Swallow synchronous errors from the helper binding so the audit
		// path never breaks the originating action.
	}
}
