/**
 * `sanitizeMcpErrorMessage`
 *
 * Strips secrets and personally identifiable information (PII) from a
 * raw error value before the message is forwarded into the analytics
 * pipeline. Used by the eager-routing helper and the managed-default
 * tool-call wrapper before the resulting string is stamped onto a
 * `mcp_default_tool_failed` signal payload.
 *
 * The sanitizer is pure and deterministic (string
 * manipulation, no IO, no clock reads) so it can live inside a Temporal
 * activity OR inside the workflow without breaking replay determinism.
 * Credential prefixes use word boundaries and bounded patterns. Values are
 * scanned linearly, including long or escaped quoted values, without an
 * unbounded credential regex or shared mutable matcher state.
 *
 * Per `fabric/standards/global/conventions.md` and
 * `fabric/standards/infrastructure/monitoring.md` ("Don't Log Sensitive
 * Data"): secrets and email addresses MUST be scrubbed before they leave
 * the activity boundary. The cap at 500 chars prevents an unbounded
 * upstream message (e.g. a wrapped HTTP body) from filling the analytics
 * payload.
 *
 * Sanitization rules:
 *   1. Strip labeled key/token/secret/password/authorization values
 *      (including quoted labels and values; an unquoted Authorization value
 *      to the end of its line), Bearer tokens, and bare sk- vendor keys. The
 *      matched span is replaced with `<redacted>`.
 *   2. Strip email-like substrings (`\S+@\S+\.\S+`) — also replaced with
 *      `<redacted>`.
 *   3. Cap the result at 500 characters. Truncated messages are suffixed
 *      with `…` so a downstream reviewer can tell the message was cut.
 *
 * The function is total — any input shape produces a string, never
 * throws.
 */

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
	const withoutSecrets = redactSecrets(raw);
	const withoutEmails = withoutSecrets.replace(EMAIL_PATTERN, REDACTED);
	if (withoutEmails.length <= MAX_LENGTH) {
		return withoutEmails;
	}
	// Reserve one char for the ellipsis so the result is ≤ MAX_LENGTH.
	return `${withoutEmails.slice(0, MAX_LENGTH - 1)}…`;
}

/** Prefix matching is bounded; value scanning consumes each credential once. */
function redactSecrets(raw: string): string {
	const prefixes =
		/["']?(?:authorization|api[_ -]?key|(?:access[_-]?|refresh[_-]?)?token|secret|password|bearer|\bkey)\b["']?|\bsk-/gi;
	const parts: string[] = [];
	let consumed = 0;
	for (let match = prefixes.exec(raw); match; match = prefixes.exec(raw)) {
		let valueStart = prefixes.lastIndex;
		const vendorKey = match[0].toLowerCase() === "sk-";
		// A header value (`Basic <creds>`, `Digest a="…", b="…"`) runs to the
		// end of its line, so an unquoted Authorization value is redacted whole.
		const toLineEnd = /authorization/i.test(match[0]);
		if (!vendorKey) {
			const afterName = skipWhitespace(raw, valueStart);
			if (raw[afterName] === ":" || raw[afterName] === "=") {
				valueStart = skipWhitespace(raw, afterName + 1);
			} else if (
				match[0].toLowerCase() === "bearer" &&
				afterName > valueStart
			) {
				valueStart = afterName;
			} else {
				continue;
			}
		}
		let end = valueStart;
		const quote = raw[valueStart];
		if (!vendorKey && (quote === '"' || quote === "'")) {
			end++;
			while (end < raw.length) {
				if (raw[end] === "\\") {
					end = Math.min(end + 2, raw.length);
				} else if (raw[end++] === quote) {
					break;
				}
			}
		} else {
			while (
				end < raw.length &&
				(vendorKey
					? /[A-Za-z0-9._+/=-]/.test(raw[end])
					: toLineEnd
						? !/[\r\n]/.test(raw[end])
						: !/\s/.test(raw[end]))
			) {
				end++;
			}
		}
		if (end === valueStart) {
			continue;
		}
		parts.push(raw.slice(consumed, match.index), REDACTED);
		consumed = end;
		prefixes.lastIndex = end;
	}
	parts.push(raw.slice(consumed));
	return parts.join("");
}

function skipWhitespace(raw: string, start: number): number {
	let end = start;
	while (end < raw.length && /\s/.test(raw[end])) {
		end++;
	}
	return end;
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
