/**
 * Classify a wholesale security/accessibility scan failure into a short,
 * user-facing hint, so the failure toast reads as a transient, retryable event
 * ("the AI model was rate-limited — try again shortly") instead of a bare,
 * alarming "Every scanner failed to complete (Accessibility)".
 *
 * A wholesale scan failure is almost never a code bug — the scanner is chunked,
 * serial (one chunk at a time, under the gateway's TPM quota), retries each
 * chunk generously, and keeps partial results. It only throws when EVERY chunk
 * failed or the whole activity timed out, i.e. the shared AI model was
 * unavailable / rate-limited / too slow for the scan's entire window. Telling
 * the user that (and that it's usually temporary) is far more useful than a
 * generic failure string.
 *
 * No package imports on purpose: the deterministic scan workflow imports this,
 * and a workflow bundle must not pull in Node built-ins (`unwrapPmSyncError` is
 * import-free too). Mirrors its cause-walking — Temporal wraps activity throws
 * in `ActivityFailure` whose own `.message` is generic ("Activity task failed"
 * / "Activity task timed out"), while the real reason (a 429, a gateway 503, a
 * chunk timeout) lives deeper in the `.cause` chain.
 */

import { unwrapPmSyncError } from "./pm-sync-error-unwrap";

export type ScanFailureKind =
	| "rate_limit"
	| "timeout"
	| "unavailable"
	| "unknown";

/**
 * Collect every message / name / code / status in an error's `cause` chain so
 * keyword classification sees the real reason no matter how deeply Temporal (or
 * the AI SDK) nested it.
 */
function collectChainText(error: unknown, out: string[], depth = 0): void {
	if (error == null || depth > 8) {
		return;
	}
	const e = error as {
		message?: unknown;
		cause?: unknown;
		type?: unknown;
		name?: unknown;
		code?: unknown;
		status?: unknown;
		statusCode?: unknown;
	};
	for (const v of [e.message, e.type, e.name, e.code]) {
		if (typeof v === "string") {
			out.push(v);
		}
	}
	for (const n of [e.status, e.statusCode]) {
		if (typeof n === "number") {
			out.push(String(n));
		}
	}
	collectChainText(e.cause, out, depth + 1);
}

/**
 * Bucket one or more failure reasons (raw thrown errors and/or Temporal
 * `ActivityFailure` wrappers) into a coarse cause. Order matters: a request can
 * be both rate-limited AND time out, and "rate-limited" is the more actionable
 * message, so it wins.
 */
export function classifyScanFailure(reasons: unknown[]): ScanFailureKind {
	const parts: string[] = [];
	for (const r of reasons) {
		collectChainText(r, parts);
	}
	const blob = parts.join("\n").toLowerCase();
	if (!blob) {
		return "unknown";
	}

	// Rate limiting / quota — the single most common cause on the shared gateway.
	if (
		/rate[\s_-]?limit|\b429\b|too many requests|quota|tokens? per min|\btpm\b/.test(
			blob,
		)
	) {
		return "rate_limit";
	}
	// The activity (or a chunk) ran out of time — large scan and/or slow worker.
	if (
		/timed out|time-?out|deadline|start[\s_-]?to[\s_-]?close|heartbeat|etimedout/.test(
			blob,
		)
	) {
		return "timeout";
	}
	// Transient upstream unavailability (gateway 5xx / dropped connection).
	if (
		/overloaded|unavailable|\b50[023]\b|econnreset|econnrefused|socket hang up|fetch failed|network/.test(
			blob,
		)
	) {
		return "unavailable";
	}
	return "unknown";
}

const HINTS: Record<Exclude<ScanFailureKind, "unknown">, string> = {
	rate_limit:
		"The AI model was rate-limited (its request/token quota was exceeded). This is usually temporary — please try again in a few minutes.",
	timeout:
		"The AI model didn't respond in time, which can happen on a large scan or a busy worker. This is usually temporary — please try again in a few minutes.",
	unavailable:
		"The AI model was temporarily unavailable. This is usually temporary — please try again shortly.",
};

/**
 * A short, user-facing sentence explaining a wholesale scan failure, or `null`
 * when the cause can't be classified (callers keep the bare failure message).
 */
export function describeScanFailureReason(reasons: unknown[]): string | null {
	const kind = classifyScanFailure(reasons);
	return kind === "unknown" ? null : HINTS[kind];
}

/** The scan steps whose exhausted retries fail the whole run. */
const SCAN_STEP_LABELS: Record<string, string> = {
	markScanRunningActivity: "Starting the scan",
	gatherScanContextActivity: "Gathering the project content",
	persistScanResultsActivity: "Saving the scan results",
};

/**
 * The failure message a scan run records: the real cause from the `.cause`
 * chain, prefixed with the step that failed. Without this, a step's exhausted
 * retries persist Temporal's generic "Activity task failed" wrapper text, which
 * tells neither the user nor the server log what went wrong.
 */
export function describeScanFailureMessage(error: unknown): string {
	const { message } = unwrapPmSyncError(error);
	const activityType = (error as { activityType?: unknown } | null)
		?.activityType;
	const step =
		typeof activityType === "string"
			? SCAN_STEP_LABELS[activityType]
			: undefined;
	return step ? `${step} failed: ${message}` : message;
}

/**
 * Append the transient-cause hint to a failure `message` unless it already
 * carries one. Idempotent so the wholesale "every scanner failed" branch —
 * which appends its own hint from the raw per-scanner reasons before it throws —
 * isn't double-hinted when its Error flows through the workflow's catch. Every
 * OTHER failure path (context gather, commit resolve, persist) reaches the catch
 * with no hint yet, so this classifies the caught error's `.cause` chain and
 * appends one, making the actionable message universal rather than wholesale-only.
 */
export function ensureScanFailureHint(message: string, error: unknown): string {
	const hint = describeScanFailureReason([error]);
	if (!hint) {
		return message;
	}
	return message.includes(hint) ? message : `${message} ${hint}`;
}
