/**
 * Request-span buffering + tail-sampled flush (v2 item 4).
 *
 * Captures lightweight observability spans into an AsyncLocalStorage
 * buffer per request. Spans are PERSISTED ONLY when the originating
 * request errored (or the audit row's outcome is `failure`). On
 * success we drop the buffer — keeps span storage bounded to a tiny
 * fraction of requests, so we can be liberal with the instrumentation.
 *
 * The buffer is bounded (`MAX_SPANS_PER_REQUEST`) to prevent a runaway
 * loop from filling memory; once the limit is hit subsequent spans
 * are silently dropped (the latest spans are most likely to carry the
 * failure context, so we keep early spans by design).
 *
 * Failure modes:
 *   - This module NEVER throws. Bookkeeping errors are swallowed so a
 *     bug here cannot break the request path or the audit-log write.
 *   - DB writes during flush are fire-and-forget (`void` return) so a
 *     slow Postgres doesn't tail-latency the error response.
 *
 * Spec: punch list item 4. Spec section to add: §8.7 (request-span
 * trace capture).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { db, Prisma, redactSensitiveKeys } from "@repo/database";
import { logger } from "@repo/logs";

type RequestSpanKind =
	| "db"
	| "temporal_workflow"
	| "temporal_activity"
	| "http_outbound"
	| "other";

type RequestSpanStatus = "ok" | "error";

export interface RequestSpanInit {
	kind: RequestSpanKind;
	name: string;
	startedAt: Date;
	durationMs: number | null;
	status: RequestSpanStatus;
	errorMessage?: string | null;
	attributes?: Record<string, unknown> | null;
}

export interface RequestSpanContext {
	correlationId: string;
	organizationId: string | null;
	userId: string | null;
}

interface SpanFrame {
	context: RequestSpanContext;
	buffer: RequestSpanInit[];
	drained: boolean;
}

/**
 * Bounded buffer cap. Spans beyond this are dropped silently. Picked
 * high enough to handle deeply-fanned-out flows (a single oRPC call
 * may make dozens of DB reads + a handful of Temporal kicks) but low
 * enough to keep the worst-case memory predictable. Tune via the
 * `FABRIC_REQUEST_SPAN_BUFFER_CAP` env if needed.
 */
const DEFAULT_MAX_SPANS_PER_REQUEST = 200;

function readBufferCap(): number {
	const raw = process.env.FABRIC_REQUEST_SPAN_BUFFER_CAP;
	if (!raw) {
		return DEFAULT_MAX_SPANS_PER_REQUEST;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_MAX_SPANS_PER_REQUEST;
	}
	return parsed;
}

/**
 * Maximum bytes we'll persist per `errorMessage`. Keeps a runaway
 * stack-trace string from blowing up the row.
 */
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

const spanStorage = new AsyncLocalStorage<SpanFrame>();

/**
 * Buffer a span into the active request's frame. No-op when called
 * outside `runWithRequestSpanContext` (e.g. background workers without
 * a request scope). This is the hot path — every Prisma query goes
 * through here on production servers, so the implementation is
 * deliberately allocation-free past the push.
 *
 * Returns nothing — the caller never needs to know whether the buffer
 * accepted the span.
 */
export function bufferSpan(span: RequestSpanInit): void {
	try {
		const frame = spanStorage.getStore();
		if (!frame) {
			return;
		}
		if (frame.drained) {
			return;
		}
		if (frame.buffer.length >= readBufferCap()) {
			return;
		}
		frame.buffer.push(span);
	} catch {
		// Swallow — span buffering is best-effort.
	}
}

/**
 * Begin a span-buffering frame for the lifetime of an async callback.
 * The frame closes when the callback resolves (or throws); the caller
 * decides via `flushSpansOnFailure` / `dropSpans` what to do with the
 * buffer.
 */
export function runWithRequestSpanContext<T>(
	context: RequestSpanContext,
	fn: () => Promise<T>,
): Promise<T> {
	const frame: SpanFrame = {
		context,
		buffer: [],
		drained: false,
	};
	return spanStorage.run(frame, fn);
}

/**
 * Read the current span context (correlationId + tenant scope) if one
 * is active. Useful for instrumenters that need to attach a span to a
 * different child context.
 */
export function getRequestSpanContext(): RequestSpanContext | null {
	try {
		const frame = spanStorage.getStore();
		return frame?.context ?? null;
	} catch {
		return null;
	}
}

/**
 * Drop the buffered spans on the success path. Idempotent. After this
 * call, subsequent `bufferSpan` calls within the same frame are
 * no-ops.
 */
/**
 * Spans detached from a closing frame, waiting for the flusher.
 *
 * `flushSpansOnFailure` reads the buffer from AsyncLocalStorage, but the only
 * caller that knows the resolved tenant — `auditErrorMiddleware` — mounts OUTSIDE
 * the frame that `auditTimingMiddleware` opens. By the time a handler's error
 * reaches it, the ALS context has exited, `getStore()` is `undefined`, and the
 * flush returned having written nothing. Deterministically, on every failure:
 * `audit.tracedRequest` advertised db spans and served an empty list for months.
 *
 * The ordering itself is deliberate and correct — the frame has to be open while
 * the handler runs so audit rows emitted inside it are covered — so the fix is to
 * stop the flusher depending on being inside the frame. The inner middleware
 * detaches the buffer on its way out and leaves it here, keyed by correlationId;
 * the outer one collects it.
 */
const detachedSpans = new Map<string, RequestSpanInit[]>();

/**
 * Cap on how many detached buffers can wait at once. The handoff is same-tick and
 * the outer middleware always runs, so in practice at most a handful are live.
 * Bounded anyway: a pathological path that detaches without collecting must leak
 * a fixed amount rather than grow forever.
 */
const MAX_DETACHED_REQUESTS = 64;

/**
 * Take the buffer out of the active frame and park it for the flusher. Call from
 * INSIDE the frame, on the failure path only.
 */
export function detachSpansForFlush(correlationId: string): void {
	try {
		const frame = spanStorage.getStore();
		if (!frame || frame.drained || frame.buffer.length === 0) {
			return;
		}
		if (detachedSpans.size >= MAX_DETACHED_REQUESTS) {
			// Evict the oldest rather than refuse the newest: a stuck entry must
			// not starve live requests of their spans.
			const oldest = detachedSpans.keys().next();
			if (!oldest.done) {
				detachedSpans.delete(oldest.value);
			}
		}
		detachedSpans.set(correlationId, frame.buffer.slice());
		frame.buffer.length = 0;
		frame.drained = true;
	} catch {
		// Bookkeeping must never break the request it observes.
	}
}

/** Collect a parked buffer. Removes it, so a second call finds nothing. */
function takeDetachedSpans(
	correlationId: string,
): RequestSpanInit[] | undefined {
	const spans = detachedSpans.get(correlationId);
	if (spans) {
		detachedSpans.delete(correlationId);
	}
	return spans;
}

export function dropSpans(): void {
	try {
		const frame = spanStorage.getStore();
		if (!frame) {
			return;
		}
		frame.buffer.length = 0;
		frame.drained = true;
		// Success path: make sure nothing stays parked for this request either.
		detachedSpans.delete(frame.context.correlationId);
	} catch {
		// Swallow.
	}
}

/**
 * Persist the buffered spans to the database in a single batched
 * insert. Called by the error-handling middleware after capture, or
 * when the REST handler sees a >= 400 response. Fire-and-forget — the
 * returned promise resolves once the spans have been written (or the
 * write has logged a warning on failure).
 *
 * After flushing the buffer is drained so a hand-rolled retry doesn't
 * double-write.
 *
 * `correlationId` argument is honored only when the caller wants to
 * override the frame's correlationId (e.g. mid-flight reattribution).
 * Defaults to the frame's correlationId.
 */
/**
 * Persist a detached buffer. Extracted so the in-frame path and the parked-buffer
 * path cannot drift — the redaction below is a SOC 2 control and duplicating it
 * would be how one copy silently loses it.
 */
async function persistSpans(
	correlationId: string,
	organizationId: string | null,
	userId: string | null,
	buffer: RequestSpanInit[],
): Promise<void> {
	try {
		await db.requestSpan.createMany({
			data: buffer.map((s) => ({
				correlationId,
				organizationId,
				userId,
				kind: s.kind,
				name: s.name.slice(0, 512),
				startedAt: s.startedAt,
				durationMs:
					typeof s.durationMs === "number" &&
					Number.isFinite(s.durationMs) &&
					s.durationMs >= 0
						? Math.round(s.durationMs)
						: null,
				status: s.status,
				errorMessage: s.errorMessage
					? s.errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)
					: null,
				// Redact sensitive keys before persisting (SOC 2 C1.1/C1.2).
				// Span attributes are free-form and future producers (e.g.
				// `http_outbound`) may carry URLs, headers, or tokens — run them
				// through the same key-denylist redactor the audit log uses so
				// secrets never land in request_span rows.
				attributes: s.attributes
					? (redactSensitiveKeys(
							s.attributes,
						) as Prisma.InputJsonValue)
					: Prisma.JsonNull,
			})),
			skipDuplicates: true,
		});
	} catch (err) {
		// Span persistence is best-effort; an INSERT failure must not break the
		// request response. Log so operators can chase the outage, never throw.
		try {
			logger.warn(
				{
					event: "request_span.flush_failed",
					correlationId,
					count: buffer.length,
					error: err instanceof Error ? err.message : String(err),
				},
				"Failed to flush request spans on failure",
			);
		} catch {
			// Logging must not throw either.
		}
	}
}

export async function flushSpansOnFailure(
	overrideCorrelationId?: string,
	overrideTenant?: { organizationId: string | null; userId: string | null },
): Promise<void> {
	let frame: SpanFrame | undefined;
	try {
		frame = spanStorage.getStore();
	} catch {
		frame = undefined;
	}

	// Outside the frame — the normal case for `auditErrorMiddleware`, which mounts
	// outside the middleware that opens it. Collect what the inner one parked.
	// Without this the function returned here and wrote nothing, every time.
	if (!frame || frame.drained || frame.buffer.length === 0) {
		const parked = overrideCorrelationId
			? takeDetachedSpans(overrideCorrelationId)
			: undefined;
		if (!parked || parked.length === 0) {
			if (frame && !frame.drained) {
				frame.drained = true;
			}
			return;
		}
		await persistSpans(
			overrideCorrelationId as string,
			overrideTenant?.organizationId ?? null,
			overrideTenant?.userId ?? null,
			parked,
		);
		return;
	}

	const correlationId =
		overrideCorrelationId && overrideCorrelationId.length > 0
			? overrideCorrelationId
			: frame.context.correlationId;
	// The frame is opened by `auditTimingMiddleware`, which sits INSIDE the auth
	// chain — so at open time there is no session and its tenant fields are null.
	// Persisting those nulls made every span unreadable: `audit.tracedRequest`
	// scopes its span read to `organizationId IS NULL AND userId = <caller>` in
	// personal context, which a null-userId row can never match. The caller passes
	// the tenant it has already resolved for the audit row; when it cannot resolve
	// one we keep the nulls, which is the previous behaviour rather than a guess.
	const organizationId =
		overrideTenant?.organizationId ?? frame.context.organizationId;
	const userId = overrideTenant?.userId ?? frame.context.userId;
	const buffer = frame.buffer.slice();
	frame.buffer.length = 0;
	frame.drained = true;

	await persistSpans(correlationId, organizationId, userId, buffer);
}

/**
 * Test-only helper: read the current buffer without mutating it.
 */
export function __getBufferForTest(): RequestSpanInit[] | null {
	const frame = spanStorage.getStore();
	return frame ? [...frame.buffer] : null;
}

/**
 * Test-only helper: peek the active frame's drained state.
 */
export function __isDrainedForTest(): boolean | null {
	const frame = spanStorage.getStore();
	return frame ? frame.drained : null;
}

/**
 * Build a Prisma `$extends` query extension that buffers a `db` span
 * for every operation. Intentionally a NO-OP when the request-span
 * frame is absent (e.g. background workers / Temporal activities
 * without a per-request scope). Zero allocation on the dropped path.
 *
 * Usage (one-time at boot):
 *   import { extendPrismaWithSpanInstrumentation } from "@repo/api/lib/request-span";
 *   const db = basePrisma.$extends(extendPrismaWithSpanInstrumentation());
 *
 * In this monorepo we install the extension on the shared `db` proxy
 * through `wireRequestSpanInstrumentation()` to keep the writer
 * package boundary intact.
 */
export interface PrismaQueryExtensionArgs {
	model?: string;
	operation: string;
	args: unknown;
	query: (args: unknown) => Promise<unknown>;
}

export async function instrumentPrismaQuery(
	args: PrismaQueryExtensionArgs,
): Promise<unknown> {
	const frame = spanStorage.getStore();
	// Fast path: no active frame, just run the query.
	if (!frame || frame.drained) {
		return args.query(args.args);
	}
	const startedAt = new Date();
	const start = Date.now();
	let status: RequestSpanStatus = "ok";
	let errorMessage: string | null = null;
	try {
		const result = await args.query(args.args);
		return result;
	} catch (err) {
		status = "error";
		errorMessage =
			err instanceof Error ? err.message : String(err ?? "unknown");
		throw err;
	} finally {
		const dur = Math.max(0, Date.now() - start);
		bufferSpan({
			kind: "db",
			name: `${args.model ?? "raw"}.${args.operation}`,
			startedAt,
			durationMs: dur,
			status,
			errorMessage,
			attributes: {
				model: args.model ?? null,
				operation: args.operation,
			},
		});
	}
}
