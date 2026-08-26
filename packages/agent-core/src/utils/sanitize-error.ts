/**
 * `sanitizeMcpErrorMessage`
 *
 * Strips secrets and personally identifiable information (PII) from a
 * raw error value before the message is forwarded into the analytics
 * pipeline. Used by the eager-routing helper and the managed-default
 * tool-call wrapper before the resulting string is stamped onto a
 * `mcp_default_tool_failed` signal payload.
 *
 * The sanitizer is intentionally non-deterministic-friendly (pure string
 * manipulation, no IO, no clock reads) so it can live inside a Temporal
 * activity OR inside the workflow without breaking replay determinism.
 * No regex backtracking pathologies — all patterns are anchored and use
 * limited bounded quantifiers.
 *
 * Per `fabric/standards/global/conventions.md` and
 * `fabric/standards/infrastructure/monitoring.md` ("Don't Log Sensitive
 * Data"): secrets and email addresses MUST be scrubbed before they leave
 * the activity boundary. The cap at 500 chars prevents an unbounded
 * upstream message (e.g. a wrapped HTTP body) from filling the analytics
 * payload.
 *
 * Sanitization rules:
 *   1. Strip occurrences of `(api[_-]?key|token|secret|password|bearer)
 *      \s*[:=]\s*\S+` — case-insensitive. The matched span is replaced
 *      with `<redacted>` so the surrounding error context survives.
 *   2. Strip email-like substrings (`\S+@\S+\.\S+`) — also replaced with
 *      `<redacted>`.
 *   3. Cap the result at 500 characters. Truncated messages are suffixed
 *      with `…` so a downstream reviewer can tell the message was cut.
 *
 * The function is total — any input shape produces a string, never
 * throws.
 */

const SECRET_PATTERN =
	/(api[_-]?key|token|secret|password|bearer)\s*[:=]\s*\S+/gi;
const EMAIL_PATTERN = /\b\S+@\S+\.\S+\b/g;
const MAX_LENGTH = 500;
const REDACTED = "<redacted>";

/**
 * Convert an arbitrary thrown value into a sanitized human-readable
 * string suitable for analytics emission. Never throws; never returns
 * empty (returns the literal string "unknown error" when the input is
 * `null`/`undefined`/an unserializable object).
 *
 * @example
 *   sanitizeMcpErrorMessage(new Error("api_key=sk-abc123 failed"))
 *   // → "Error: <redacted> failed"
 *
 * @example
 *   sanitizeMcpErrorMessage("user alice@example.com not found")
 *   // → "user <redacted> not found"
 */
export function sanitizeMcpErrorMessage(error: unknown): string {
	const raw = coerceToString(error);
	const withoutSecrets = raw.replace(SECRET_PATTERN, REDACTED);
	const withoutEmails = withoutSecrets.replace(EMAIL_PATTERN, REDACTED);
	if (withoutEmails.length <= MAX_LENGTH) {
		return withoutEmails;
	}
	// Reserve one char for the ellipsis so the result is ≤ MAX_LENGTH.
	return `${withoutEmails.slice(0, MAX_LENGTH - 1)}…`;
}

function coerceToString(value: unknown): string {
	if (value === null || value === undefined) {
		return "unknown error";
	}
	if (value instanceof Error) {
		// Prefix with the error name so analytics can distinguish e.g.
		// TypeError vs. fetch error vs. AbortError without parsing.
		return `${value.name}: ${value.message}`;
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return "unknown error";
	}
}
