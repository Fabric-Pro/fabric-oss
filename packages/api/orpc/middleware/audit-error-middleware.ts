/**
 * Automatic audit-error middleware (D16).
 *
 * Wraps every oRPC procedure invocation. On any thrown value:
 *  - Classify the error (action + severity).
 *  - Build the `metadata` payload (OTEL `exception` shape + Sentry-style
 *    fingerprint + sanitized input snapshot + cause chain up to depth 5).
 *  - Emit one audit row via `recordAuditFromRequest`.
 *  - Re-throw the ORIGINAL error instance unchanged so the client UX,
 *    error codes, status mappings, and downstream middleware all observe
 *    the same value they would have seen without this middleware.
 *
 * Safety invariants (D16):
 *  1. Never wraps or alters the thrown error — the same instance is
 *     re-thrown so `instanceof ORPCError` etc. still hold downstream.
 *  2. Never throws from the capture path — every step is wrapped in
 *     try/catch so a bug in the metadata builder cannot break the error
 *     response. On internal failure a structured `console.error` lands.
 *  3. Uses `recordAuditFromRequest` (fire-and-forget) so audit writes
 *     do not block the error response.
 *  4. Honors two operator kill switches:
 *     - `FABRIC_AUDIT_ERROR_CAPTURE_DISABLED=true` -> skip ALL capture.
 *     - `FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS=path.a,path.b.*` ->
 *       skip the listed procedure paths (prefix match via `*`).
 *
 * Spec: docs/audit-log/README.md
 * D16 (automatic error capture).
 */

import { os } from "@orpc/server";
import { auth } from "@repo/auth";
import { ERROR_CATEGORY } from "@repo/database";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../lib/audit";
import {
	extractCorrelationId,
	getCorrelationIdFromContext,
} from "../../lib/correlation-id";
import { flushSpansOnFailure } from "../../lib/request-span";
import { classifyError } from "./audit-error-mapping";
import {
	buildException,
	computeFingerprint,
	extractCauseChain,
	sanitizeInput,
} from "./audit-error-sanitize";

const SKIP_PATHS_ENV = "FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS";
const DISABLED_ENV = "FABRIC_AUDIT_ERROR_CAPTURE_DISABLED";

/**
 * Procedure paths whose error captures are ALWAYS suppressed, regardless of
 * env config (#1899). These carry personal calendar data — a join URL is a
 * meeting capability URL — and the audit row would land in the project's ORG
 * tenant, where org admins could read it. That is precisely the disclosure the
 * feature's design forbids (FR4), and the design also states this feature emits
 * no audit entries at all: recording that someone read their own private
 * calendar is itself the privacy risk. Hardcoded rather than left to
 * FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS so a ConfigMap edit cannot re-enable it.
 */
// NOTE: matched against the dotted ROUTER path (see renderProcedurePath). A
// direct `call(procedure, ...)` renders "(root)" and would NOT be skipped —
// so these procedures must only ever be reached through the router.
const ALWAYS_SKIP_PATHS = [
	"projects.meetingDigest.listPersonalMeetings",
	"projects.meetingDigest.getPersonalTranscript",
	// Runs the identical Graph chain as getPersonalTranscript and holds the
	// transcript in memory to summarise it, so it carries the same personal
	// calendar exposure and inherits the same unconditional suppression.
	"projects.meetingDigest.getPersonalInsights",
	// #1901 — agenda content is user prose. `content` is not on the redaction
	// denylist, so a thrown save would persist the whole document to an
	// org-admin-readable AuditLog row. Hardcoded rather than left to
	// FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS so a ConfigMap edit cannot re-enable it.
	"projects.meetingDigest.saveAgenda",
	// #2170 — the personal-meeting import. Unlike the entries above this
	// procedure DOES persist, deliberately, and its successes are audited: the
	// sibling audit-ACTIVITY middleware records every successful import, and
	// that row is lean by design (no input snapshot), which is exactly the
	// record an org admin is entitled to.
	//
	// Only the FAILURE path is suppressed, and only because of what it would
	// capture. This middleware snapshots the validated input, `joinUrl` is not
	// on the sensitive-key denylist, and a Teams join URL is a meeting
	// CAPABILITY url — #1899 went out of its way (DEF-6) to keep it off the
	// error path for precisely this reason. A throw here means the import did
	// NOT happen (a caller without CONTEXT_CREATE, the flag off, an unexpected
	// Graph failure), so the row would publish the address of a still-private
	// meeting into the project's ORG tenant in exchange for nothing.
	"projects.meetingDigest.importPersonalMeeting",
] as const;

/**
 * Parse `FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS` into a list of patterns.
 * Trailing `*` indicates a prefix match; otherwise the value matches
 * exactly. We re-parse on every call so tests can flip the env without
 * restarting; in production the value is read once per request which is
 * cheap (<= a few entries typically).
 */
function readSkipPatterns(): { exact: Set<string>; prefixes: string[] } {
	const raw = process.env[SKIP_PATHS_ENV];
	if (!raw || raw.trim().length === 0) {
		return { exact: new Set(), prefixes: [] };
	}
	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed.length === 0) {
			continue;
		}
		if (trimmed.endsWith("*")) {
			prefixes.push(trimmed.slice(0, -1));
		} else {
			exact.add(trimmed);
		}
	}
	return { exact, prefixes };
}

function shouldSkip(path: string): boolean {
	if ((ALWAYS_SKIP_PATHS as readonly string[]).includes(path)) {
		return true;
	}
	const { exact, prefixes } = readSkipPatterns();
	if (exact.has(path)) {
		return true;
	}
	for (const prefix of prefixes) {
		if (path.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

function isCaptureDisabled(): boolean {
	return process.env[DISABLED_ENV] === "true";
}

/**
 * Project the oRPC `path` tuple into a dotted procedure key. Mirrors the
 * shape the viewer's `action` column shows (e.g. `"projects.create"`).
 */
function renderProcedurePath(path: readonly string[]): string {
	return path.length === 0 ? "(root)" : path.join(".");
}

/**
 * Best-effort HTTP method extraction. oRPC defaults to POST.
 */
function readHttpMethod(headers: Headers | undefined): string | undefined {
	if (!headers) {
		return undefined;
	}
	const candidate = headers.get?.("x-http-method");
	return candidate ?? undefined;
}

/**
 * Read a numeric HTTP status off an ORPCError-like object. Returns
 * `undefined` when the value is not a finite number.
 */
function readHttpStatus(err: unknown): number | undefined {
	if (err && typeof err === "object" && "status" in err) {
		const candidate = (err as { status?: unknown }).status;
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Read the `code` field off an ORPCError-like object. Falls back to the
 * Error constructor name when no `code` is present (Zod, plain Error).
 */
function readErrorCode(err: unknown): string {
	if (err && typeof err === "object") {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) {
			return code;
		}
		const name = (err as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) {
			return name;
		}
	}
	return "UNKNOWN";
}

/**
 * Best-effort projectId read off the input. The middleware does not know
 * what shape the input has, so we duck-type for a `projectId` string at
 * the top level. Falls back to undefined.
 */
export function readProjectIdFromInput(input: unknown): string | undefined {
	if (input && typeof input === "object" && "projectId" in input) {
		const candidate = (input as { projectId?: unknown }).projectId;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Best-effort organizationId read off the input. Same duck-typing pattern
 * as `readProjectIdFromInput`. Returns `null` for explicit personal
 * context (`organizationId: null`) so the row lands in personal tenant.
 * Returns `undefined` when the input doesn't carry the field at all so
 * downstream resolution (session.activeOrganizationId) can still apply.
 */
export function readOrganizationIdFromInput(
	input: unknown,
): string | null | undefined {
	if (input && typeof input === "object" && "organizationId" in input) {
		const candidate = (input as { organizationId?: unknown })
			.organizationId;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
		if (candidate === null) {
			return null;
		}
	}
	return undefined;
}

/**
 * Resolve actor + org context for an error row when the outer middleware
 * sits OUTSIDE the auth chain (so `context.user` / `context.session` are
 * undefined). Re-runs Better Auth's session resolver against the request
 * headers (cached internally) and merges the result into the AuditRequestContext.
 *
 * Critical for correctness: without this, every error row was orphaned
 * with `userId=null, organizationId=null` and invisible to any viewer.
 * The auth resolver returns `null` for anonymous requests, in which case
 * we leave the actor as "system" — same behavior as before.
 */
async function enrichContextFromHeaders(
	context: AuditRequestContext,
): Promise<AuditRequestContext> {
	if (context.user || !context.headers) {
		return context;
	}
	try {
		const session = await auth.api.getSession({ headers: context.headers });
		if (!session?.user) {
			return context;
		}
		return {
			...context,
			user: {
				id: session.user.id,
				email: session.user.email,
				name: session.user.name,
			},
			session: {
				id: session.session.id,
				impersonatedBy: session.session.impersonatedBy ?? null,
				activeOrganizationId:
					session.session.activeOrganizationId ?? null,
			},
		};
	} catch {
		// Anonymous or session-resolution failure — proceed with the
		// unenriched context. Actor falls back to "system" in
		// resolveActor; orgId falls back to the input-derived value.
		return context;
	}
}

/**
 * Internal: build the metadata payload + emit one audit row. Wrapped in
 * a try/catch so a failure here CANNOT break the error response. On
 * failure we log a structured `console.error` so operators see it.
 */
async function captureError(
	err: unknown,
	rawContext: AuditRequestContext & {
		_auditFailureEmitted?: boolean;
	},
	input: unknown,
	path: readonly string[],
): Promise<void> {
	try {
		// Idempotence (D16): a hand-emitted failure earlier in the chain
		// can set `_auditFailureEmitted = true` on context to suppress us.
		if (rawContext._auditFailureEmitted === true) {
			return;
		}

		const renderedPath = renderProcedurePath(path);

		// Kill switches: env-disabled OR path-matched skip-list.
		if (isCaptureDisabled()) {
			return;
		}
		if (shouldSkip(renderedPath)) {
			return;
		}

		// Re-resolve user + session from headers because this middleware
		// sits OUTSIDE the auth chain (so the outer `context` arg never
		// carries `user`/`session` even when downstream auth middleware
		// successfully resolved them via `next({ context: ... })`).
		const context = await enrichContextFromHeaders(rawContext);

		const classification = classifyError(err);
		const exception = buildException(err);
		const cause = extractCauseChain(err);
		const fingerprint = computeFingerprint(
			exception.type,
			readErrorCode(err),
			exception.stacktrace?.[0],
		);

		// Correlation: AsyncLocalStorage first, then header (D16). We don't
		// fall back to null here because we want operators to be able to
		// trace ANY error back to a request — even one whose middleware
		// chain somehow missed `asyncCorrelationMiddleware`. If both sources
		// are empty, the field is simply omitted.
		const correlationId =
			getCorrelationIdFromContext() ??
			(context.headers ? extractCorrelationId(context.headers) : null);

		const metadata: Record<string, unknown> = {
			exception: {
				...exception,
				// OTEL `exception.escaped` is true once the exception
				// crosses a span boundary. By definition we are catching it
				// at the outermost middleware so `escaped` is always true.
				escaped: true,
			},
			fingerprint,
			procedure: {
				path: renderedPath,
				method: readHttpMethod(context.headers),
				httpStatus: readHttpStatus(err),
			},
			errorCode: readErrorCode(err),
		};
		if (cause) {
			metadata.cause = cause;
		}
		const inputSnapshot = sanitizeInput(input);
		if (inputSnapshot !== undefined) {
			metadata.input = inputSnapshot;
		}
		// Surface correlation at the top level of metadata (not under
		// `procedure`) so the viewer can filter / display it directly
		// without drilling into the nested OTEL shape.
		if (correlationId) {
			metadata.correlationId = correlationId;
		}

		// Resolve organizationId: explicit input wins (including explicit
		// null for personal context), else session.activeOrganizationId,
		// else null. This mirrors `resolveOrganizationId` in procedures.ts
		// but is intentionally simpler since the middleware can't pull
		// from `getTenantContext()` (no AsyncLocalStorage frame yet at
		// outermost wrap).
		const inputOrg = readOrganizationIdFromInput(input);
		const organizationId =
			inputOrg !== undefined
				? inputOrg
				: (context.session?.activeOrganizationId ?? null);

		recordAuditFromRequest(context, {
			action: classification.action,
			category: ERROR_CATEGORY,
			severity: classification.severity,
			outcome: "failure",
			organizationId,
			resource: {
				type: "procedure",
				id: renderedPath,
				name: renderedPath,
			},
			projectId: readProjectIdFromInput(input) ?? null,
			metadata,
			// Pass explicitly too so it lands on the row even if
			// `recordAuditFromRequest`'s own resolution misses (e.g. tests).
			correlationId,
		});

		// v2 item 4: persist any buffered request spans now that the
		// audit row has been emitted. The span buffer was opened by
		// `auditTimingMiddleware` (which sits inside this middleware)
		// and was NOT drained on the failure path. Pass the resolved
		// correlationId so spans share the same trace key as the audit
		// row. The call is awaited so the spans land before the error
		// response completes (still fast — single batched INSERT).
		// Stamp the tenant too, not just the correlationId. The span frame was
		// opened before auth resolved, so its tenant fields are null — and
		// `audit.tracedRequest` scopes the span read to
		// `organizationId IS NULL AND userId = <caller>` in personal context, so
		// null-userId rows were invisible to the only surface that reads them.
		// Same failure shape as the audit rows that were written tenant-less.
		const spanTenant = {
			organizationId,
			userId: context.user?.id ?? null,
		};
		await flushSpansOnFailure(correlationId || undefined, spanTenant);

		// Mark so any downstream hand-rolled emit can opt out via
		// `context._auditFailureEmitted = true` (idempotence flag).
		rawContext._auditFailureEmitted = true;
	} catch (captureErr) {
		// Last-resort: the audit-capture path itself failed. We log to
		// stdout in a structured shape so operators can grep, but we do
		// NOT throw — the original error still has to surface to the
		// client.
		try {
			// eslint-disable-next-line no-console
			console.error({
				event: "audit.error_capture_failed",
				path: renderProcedurePath(path),
				captureErrorMessage:
					captureErr instanceof Error
						? captureErr.message
						: String(captureErr),
			});
		} catch {
			// Truly catastrophic — even console.error blew up. Give up.
		}
	}
}

/**
 * The middleware itself. Wired as the outermost layer on the base public
 * procedure in `procedures.ts` so every procedure (auth, rate-limit,
 * permission, tenant, handler) participates.
 *
 * The second-argument `input` is the resolved input object from any
 * `.input(zSchema)` declaration upstream. For procedures without an input
 * declaration it is `undefined`, which `sanitizeInput` handles cleanly.
 */
export const auditErrorMiddleware = os
	.$context<
		{
			headers: Headers;
		} & AuditRequestContext
	>()
	.middleware(async ({ context, next, path }, input: unknown) => {
		try {
			// `next()` is the only place we await; on success we never
			// touch the audit path.
			return await next();
		} catch (err) {
			// Best-effort capture. We have access to the validated input
			// snapshot via the second arg; the sanitizer redacts secrets
			// and truncates to 8KiB before storage. captureError is async
			// (it re-resolves session via auth.api.getSession) but we MUST
			// re-throw synchronously to preserve error timing for the
			// client — so we fire it without await. The function is
			// self-contained: its own outer try/catch handles all failures,
			// so an unhandled rejection here is impossible.
			void captureError(err, context, input, path);
			throw err;
		}
	});

/**
 * Internal exports for tests.
 *
 * `captureError` is the pure capture function; tests can call it
 * directly to avoid spinning up the full oRPC framework.
 */
export {
	ALWAYS_SKIP_PATHS,
	captureError as __captureErrorForTest,
	readSkipPatterns as __readSkipPatternsForTest,
	shouldSkip as __shouldSkipForTest,
	isCaptureDisabled as __isCaptureDisabledForTest,
};
