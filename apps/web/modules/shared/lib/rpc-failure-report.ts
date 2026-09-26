/**
 * Reports to the server the two categories of oRPC failure the server never
 * saw itself: a transport failure (fetch never got a response at all) and a
 * "rewrapped" error page (`data.responseText` — a proxy or platform page
 * `orpc-client.ts` had to turn into an oRPC-shaped error because the API's
 * own handler never ran). Everything else — an ordinary `ORPCError` from the
 * API — the server's own `rpc.error` log line (`packages/api/orpc/
 * rpc-error-logging.ts`) already covers; reporting it again here would be
 * the same failure counted twice from two processes.
 *
 * Sent always, never gated on analytics consent — this is operational
 * telemetry about the app breaking, not tracking. The payload deliberately
 * carries no user data: no message text beyond a status/code, and the route
 * has its id-like segments masked before it ever leaves the browser.
 *
 * Queued in memory and flushed via `navigator.sendBeacon` (falling back to
 * `fetch(..., { keepalive: true })` where beacons are unavailable) every 10
 * seconds and on `pagehide`/a hidden `visibilitychange` — the two events
 * that still fire reliably as a tab closes or is backgrounded, unlike a
 * timer alone.
 */

type RpcFailureKind = "transport" | "error-page";

export interface RpcFailureReport {
	procedure: string;
	kind: RpcFailureKind;
	status?: number;
	code?: string;
	route: string;
}

const ENDPOINT = "/api/client-errors";
const FLUSH_INTERVAL_MS = 10_000;
/** Per page session — a tab crash-looping a request cannot flood the
 *  endpoint, and this is diagnostic telemetry, not a delivery guarantee. */
const MAX_REPORTS_PER_SESSION = 20;

/** A path segment that looks like an opaque identifier rather than a
 *  human-readable route part — a UUID, a prefixed id (`org_...`, `req_...`),
 *  a bare numeric id, or another long opaque token (this repo's Prisma ids
 *  are 25-character cuids). An organization/project SLUG is deliberately
 *  left alone: it is not "id-like" and carries diagnostic value (which
 *  tenant a route-shape failure came from, without naming a person). */
const UUID_SEGMENT =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID_SEGMENT = /^[a-z]+_[a-zA-Z0-9]{6,}$/;
const NUMERIC_SEGMENT = /^\d+$/;
const OPAQUE_TOKEN_SEGMENT = /^[a-zA-Z0-9]{20,}$/;

function isIdLikeSegment(segment: string): boolean {
	return (
		UUID_SEGMENT.test(segment) ||
		PREFIXED_ID_SEGMENT.test(segment) ||
		NUMERIC_SEGMENT.test(segment) ||
		OPAQUE_TOKEN_SEGMENT.test(segment)
	);
}

/** `location.pathname` with every id-like segment replaced by `:id`. */
export function maskRoute(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => (isIdLikeSegment(segment) ? ":id" : segment))
		.join("/");
}

let queue: RpcFailureReport[] = [];
const seenKeys = new Set<string>();
/** Total ever queued this session, sent or still pending — the number the
 *  20-per-session cap is checked against. */
let totalQueued = 0;
let flushTimer: ReturnType<typeof setInterval> | undefined;
let listenersAttached = false;

function reportKey(report: RpcFailureReport): string {
	return [
		report.procedure,
		report.kind,
		report.status ?? "",
		report.code ?? "",
		report.route,
	].join("|");
}

function sendBatch(batch: RpcFailureReport[]): void {
	const body = JSON.stringify({ reports: batch });
	if (typeof navigator.sendBeacon === "function") {
		const sent = navigator.sendBeacon(
			ENDPOINT,
			new Blob([body], { type: "application/json" }),
		);
		if (sent) {
			return;
		}
	}
	// `keepalive` lets the request survive the page unloading, the same
	// guarantee `sendBeacon` gives, for browsers/contexts without it.
	fetch(ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
		keepalive: true,
	}).catch(() => {
		// Best-effort — a failed report about a failure is not itself
		// something to report or retry.
	});
}

function flush(): void {
	if (queue.length === 0) {
		return;
	}
	const batch = queue;
	queue = [];
	sendBatch(batch);
	if (totalQueued >= MAX_REPORTS_PER_SESSION && flushTimer !== undefined) {
		clearInterval(flushTimer);
		flushTimer = undefined;
	}
}

function ensureScheduled(): void {
	if (flushTimer === undefined) {
		flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
	}
	if (!listenersAttached) {
		listenersAttached = true;
		window.addEventListener("pagehide", flush);
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				flush();
			}
		});
	}
}

/**
 * Queue a failure report. No-op outside the browser, once the per-session
 * cap is reached, or for a report identical (by every field) to one already
 * queued or sent this session.
 */
export function queueRpcFailureReport(report: RpcFailureReport): void {
	if (typeof window === "undefined") {
		return;
	}
	if (totalQueued >= MAX_REPORTS_PER_SESSION) {
		return;
	}
	const key = reportKey(report);
	if (seenKeys.has(key)) {
		return;
	}
	seenKeys.add(key);
	queue.push(report);
	totalQueued++;
	ensureScheduled();
}

/** Test-only: force an immediate flush without waiting for the timer. */
export function __flushRpcFailureReportsForTests(): void {
	flush();
}

/** Test-only: drop all in-memory state (queue, dedupe set, cap, timer). */
export function __resetRpcFailureReportsForTests(): void {
	queue = [];
	seenKeys.clear();
	totalQueued = 0;
	if (flushTimer !== undefined) {
		clearInterval(flushTimer);
		flushTimer = undefined;
	}
	listenersAttached = false;
}
