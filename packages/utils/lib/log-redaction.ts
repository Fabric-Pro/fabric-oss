/**
 * Redaction for APPLICATION LOG content (Fizzy #1234).
 *
 * Why this exists alongside `redactSensitiveKeys`: that redactor matches on
 * OBJECT KEYS and never inspects values, which is right for audit metadata
 * (a structured bag). An application log line is mostly FREE TEXT — a bearer
 * token pasted into a message has no key to match — so key-based redaction is
 * structurally unable to catch it. This module redacts by VALUE SHAPE, and
 * composes with the shared key denylist for the structured `properties` bag.
 *
 * PURE — no I/O, no DB, no config. Unit-testable without a log platform, which
 * is the point: the security-critical layer must be provable on its own,
 * independent of whichever log-access mechanism is finally adopted.
 *
 * Failure mode is deliberately asymmetric:
 *   - redaction failure  -> DROP the entry (fail closed; never emit unredacted)
 *   - platform failure   -> caller proceeds without logs (fail open; FR3)
 */
import { keyIsSensitive, REDACTED } from "./sensitive-keys";

/** A log entry as returned by a log-source adapter, before redaction. */
export interface RawLogEntry {
	timestamp?: string;
	severity?: string;
	message: string;
	/** Structured fields the platform attached to the entry. */
	properties?: Record<string, unknown>;
}

/** A log entry that has passed redaction and is safe to put in a prompt. */
export interface RedactedLogEntry {
	timestamp?: string;
	severity?: string;
	message: string;
	properties?: Record<string, unknown>;
	/** How many redactions were applied across message + properties. */
	redactionCount: number;
	/** True when the message was truncated to the per-entry character cap. */
	truncated: boolean;
}

/**
 * Per-entry message cap. Long enough for a stack trace's useful head, short
 * enough that one pathological entry cannot dominate the prompt budget.
 */
export const MAX_ENTRY_MESSAGE_CHARS = 2_000;

interface ValuePattern {
	name: string;
	pattern: RegExp;
	/** `$1`/`$2` refer to capture groups, as in `String.replace`. */
	replacement: string;
	/**
	 * When present, a match is redacted only if this returns true for capture
	 * group 1. Lets a broad structural pattern (`<identifier> = <value>`) defer
	 * the actual decision to the shared denylist.
	 */
	guard?: (captured: string) => boolean;
}

/**
 * Identifiers that name a secret when they are the WHOLE key, but which are
 * unusable as denylist SUBSTRINGS because they appear inside ordinary words
 * (`sig` in `assigned`/`design`, `auth` in `author`, `sas` in `phrases`).
 * Matched exactly, case-insensitively, after separators are stripped.
 *
 * Bare `key` is deliberately absent: `key=` is overwhelmingly a cache or
 * partition key in a log line, and redacting every one would cost more
 * debugging value than it buys. `private_key`, `apikey` and `accountkey` are
 * all covered — by the shared denylist or by this set. ADR-017 records the
 * completeness of the denylist as an open question for the security review.
 */
const EXACT_SENSITIVE_IDENTIFIERS = new Set([
	"auth",
	"pwd",
	"sig",
	"sas",
	"accountkey",
	"sharedaccesskey",
]);

/**
 * Whether an identifier appearing on the left of `=` or `:` names a secret.
 *
 * Delegates to the shared denylist rather than re-listing keywords, and also
 * tests the separator-stripped form so `x-api-key` and `API_KEY` reach the
 * `apikey` entry. Matching keywords with a `\b`-anchored alternation instead
 * of this was a real leak: `\b` never fires between two word characters, so
 * every compound identifier — `AWS_SECRET_ACCESS_KEY`, `DB_PASSWORD`,
 * `dbPassword`, `sessionToken` — passed through untouched while a bare
 * `password=` was caught.
 */
function isSensitiveIdentifier(key: string): boolean {
	const stripped = key.replace(/[-_]/g, "");
	return (
		keyIsSensitive(key) ||
		keyIsSensitive(stripped) ||
		EXACT_SENSITIVE_IDENTIFIERS.has(stripped.toLowerCase())
	);
}

/**
 * Value-shaped secret and PII patterns, applied in order. Ordering matters:
 * the structured forms (PEM, JWT, vendor tokens) run before the generic
 * `key=value` sweep so a token is redacted as a whole rather than leaving a
 * recognisable tail behind.
 *
 * Every pattern is linear-time — no nested quantifier over an overlapping
 * character class — so a hostile log line cannot wedge the worker.
 */
const VALUE_PATTERNS: ValuePattern[] = [
	{
		name: "pem-private-key",
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replacement: REDACTED,
	},
	{
		name: "jwt",
		pattern:
			/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
		replacement: REDACTED,
	},
	{
		name: "github-token",
		pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
		replacement: REDACTED,
	},
	{
		name: "slack-token",
		pattern: /\bxox[baprse]-[A-Za-z0-9-]{8,}/g,
		replacement: REDACTED,
	},
	{
		name: "aws-access-key-id",
		pattern: /\bAKIA[0-9A-Z]{16}\b/g,
		replacement: REDACTED,
	},
	{
		name: "google-api-key",
		pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
		replacement: REDACTED,
	},
	{
		name: "http-auth-header",
		pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
		replacement: `$1 ${REDACTED}`,
	},
	{
		// scheme://user:password@host — the password half only, so the host
		// stays legible for debugging.
		name: "url-userinfo",
		pattern: /\b([a-z][a-z0-9+.-]*):\/\/([^\s:@/]+):[^\s@/]+@/gi,
		replacement: `$1://$2:${REDACTED}@`,
	},
	{
		// Connection strings, query-string secrets and JSON scalars alike.
		// Matches the STRUCTURE (`<identifier> = <value>`) and lets the shared
		// denylist decide, via `guard`, whether the identifier names a secret.
		//
		// The optional quote after the identifier is what makes this work on
		// JSON: `"clientSecret": "x"` puts a closing quote between key and
		// colon. The quoted-value alternatives are escape-aware, so a secret
		// containing an escaped quote is consumed whole instead of leaving its
		// tail in cleartext.
		name: "key-value-secret",
		pattern:
			/\b([A-Za-z_][A-Za-z0-9_-]*)["']?\s*[=:]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;,&"')}]+)/g,
		replacement: `$1=${REDACTED}`,
		guard: isSensitiveIdentifier,
	},
	{
		name: "email",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		replacement: REDACTED,
	},
	{
		name: "us-ssn",
		pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
		replacement: REDACTED,
	},
];

/** Luhn check — used to avoid redacting ordinary long digit runs (ids, sizes). */
function passesLuhn(digits: string): boolean {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (d < 0 || d > 9) {
			return false;
		}
		if (double) {
			d *= 2;
			if (d > 9) {
				d -= 9;
			}
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

/**
 * True for addresses that identify nobody: loopback, RFC1918 private space,
 * link-local and the unspecified address. These carry real debugging value
 * (which container, which pod) so they survive redaction.
 */
function isNonIdentifyingIpv4(a: number, b: number): boolean {
	if (a === 0 || a === 127 || a === 10) {
		return true;
	}
	if (a === 192 && b === 168) {
		return true;
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return true;
	}
	if (a === 169 && b === 254) {
		return true;
	}
	return false;
}

/**
 * Redact free-text log content. Returns the redacted text and how many
 * substitutions were made.
 */
export function redactLogText(text: string): {
	text: string;
	redactionCount: number;
} {
	let out = text;
	let count = 0;

	for (const { pattern, replacement, guard } of VALUE_PATTERNS) {
		out = out.replace(pattern, (...args) => {
			// `args` is [match, ...groups, offset, whole], so group n is args[n].
			const whole = args[0] as string;
			if (guard && !guard(String(args[1] ?? ""))) {
				return whole;
			}
			count++;
			// Expand `$n` against this match's capture groups.
			return replacement.replace(/\$(\d)/g, (_marker, digit: string) => {
				const group = args[Number(digit)];
				return typeof group === "string" ? group : "";
			});
		});
	}

	// Payment-card numbers: shape-match first, then Luhn, so ordinary long
	// digit runs (durations, byte counts, ids) are left legible.
	out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
		const digits = match.replace(/[^0-9]/g, "");
		if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) {
			return match;
		}
		count++;
		return REDACTED;
	});

	// Public IPv4 addresses are PII; private and loopback space is not.
	out = out.replace(
		/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
		(match, o1: string, o2: string, o3: string, o4: string) => {
			const octets = [Number(o1), Number(o2), Number(o3), Number(o4)];
			if (octets.some((o) => o > 255)) {
				return match;
			}
			if (
				isNonIdentifyingIpv4(octets[0] as number, octets[1] as number)
			) {
				return match;
			}
			count++;
			return REDACTED;
		},
	);

	// Patterns deliberately overlap (an `Authorization: Bearer x` line matches
	// both the header rule and the key=value rule), which can leave a run of
	// adjacent placeholders. Collapse them so the model sees one redaction,
	// not a smear that looks like several distinct secrets.
	out = out.replace(/\[REDACTED\](?:\s*\[REDACTED\])+/g, REDACTED);

	return { text: out, redactionCount: count };
}

/**
 * Redact the structured `properties` bag: a sensitive KEY has its whole value
 * replaced; every surviving string value still goes through value-shaped
 * redaction, because a benign key can carry a secret.
 */
function redactProperties(props: Record<string, unknown>): {
	properties: Record<string, unknown>;
	redactionCount: number;
} {
	const out: Record<string, unknown> = {};
	let count = 0;
	for (const [key, value] of Object.entries(props)) {
		if (keyIsSensitive(key)) {
			out[key] = REDACTED;
			count++;
			continue;
		}
		if (typeof value === "string") {
			// Capped like `message` is. The platform is external, so a single
			// property can carry a whole serialized request body; without this
			// the ~13 redaction passes run over an unbounded string.
			const redacted = redactLogText(
				value.slice(0, MAX_ENTRY_MESSAGE_CHARS),
			);
			out[key] = redacted.text;
			count += redacted.redactionCount;
			continue;
		}
		// Non-string scalars carry no free text. Anything still structured is
		// dropped rather than guessed at — the adapter flattens before this.
		if (
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null
		) {
			out[key] = value;
		}
	}
	return { properties: out, redactionCount: count };
}

/**
 * Redact one log entry. Returns `null` when the entry cannot be safely
 * redacted — the caller MUST drop it rather than emit anything.
 */
export function redactLogEntry(entry: RawLogEntry): RedactedLogEntry | null {
	try {
		if (typeof entry?.message !== "string") {
			return null;
		}
		const capped = entry.message.slice(0, MAX_ENTRY_MESSAGE_CHARS);
		const truncated = capped.length < entry.message.length;
		const message = redactLogText(capped);

		let properties: Record<string, unknown> | undefined;
		let propertyRedactions = 0;
		if (entry.properties && typeof entry.properties === "object") {
			const redacted = redactProperties(entry.properties);
			propertyRedactions = redacted.redactionCount;
			properties =
				Object.keys(redacted.properties).length > 0
					? redacted.properties
					: undefined;
		}

		return {
			timestamp: entry.timestamp,
			severity: entry.severity,
			message: message.text,
			properties,
			redactionCount: message.redactionCount + propertyRedactions,
			truncated,
		};
	} catch {
		// Fail closed: an entry we could not redact never reaches the model.
		return null;
	}
}

/** Outcome of redacting a batch, including what was dropped. */
export interface RedactBatchResult {
	entries: RedactedLogEntry[];
	/** Entries dropped because redaction failed — never silently zero. */
	droppedCount: number;
	/** Total redactions applied across the surviving entries. */
	redactionCount: number;
}

/** Redact a batch, dropping any entry that fails. */
export function redactLogEntries(entries: RawLogEntry[]): RedactBatchResult {
	const out: RedactedLogEntry[] = [];
	let dropped = 0;
	let redactions = 0;
	for (const entry of entries) {
		const redacted = redactLogEntry(entry);
		if (!redacted) {
			dropped++;
			continue;
		}
		out.push(redacted);
		redactions += redacted.redactionCount;
	}
	return { entries: out, droppedCount: dropped, redactionCount: redactions };
}
