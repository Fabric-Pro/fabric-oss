/**
 * Sanitizers for the automatic audit-error middleware (D16).
 *
 * - `sanitizeStack` strips absolute filesystem paths to repo-relative,
 *   drops `node_modules` and node-internal frames, and caps at top 30
 *   frames. Inspired by `clean-stack` but implemented inline to avoid
 *   adding a third-party dependency.
 * - `sanitizeInput` runs the existing `redactSensitiveKeys` redactor over
 *   the input snapshot, handles circular references, and truncates the
 *   serialized payload to 8 KiB.
 * - `extractCauseChain` walks `Error.cause` recursively up to depth 5 so
 *   the chain is captured without infinite loops.
 * - `computeFingerprint` returns a stable hex hash (16 chars, SHA-256
 *   prefix) for grouping recurring errors a la Sentry.
 *
 * Spec: docs/audit-log/README.md
 * D16 (automatic error capture).
 */

import { createHash } from "node:crypto";
import { redactSensitiveKeys } from "@repo/database";

const MAX_STACK_FRAMES = 30;
const MAX_INPUT_BYTES = 8192;
const MAX_MESSAGE_CHARS = 1024;
const MAX_CAUSE_DEPTH = 5;

/** Shape of a captured exception payload. Mirrors OTEL conventions. */
export interface ExceptionMetadata {
	type: string;
	message: string;
	stacktrace?: string[];
}

/**
 * Resolve the repository root. We trust `process.cwd()` at the point the
 * middleware runs (the API server boots from the monorepo root). Callers
 * who need to override this for tests can pass `repoRoot` explicitly to
 * `sanitizeStack`.
 */
function resolveRepoRoot(): string {
	// Fall back to "" so the regex replace becomes a no-op when cwd is
	// empty (unreachable in production).
	return process.cwd() || "";
}

/**
 * Escape regex metacharacters in a literal string. Standard pattern from
 * MDN — required because `process.cwd()` on Windows contains backslashes
 * which are regex metacharacters.
 */
function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clean a stack trace string into an array of repo-relative frames.
 *
 * Behaviour:
 *  - Drops the leading `Error: <message>` header (first line of `stack`).
 *  - Removes frames that point into `node_modules` (vendor noise).
 *  - Removes frames that point into node internals (`at … (node:...)`).
 *  - Strips the absolute repo root prefix so frames are repo-relative.
 *  - Normalizes Windows path separators to forward slashes.
 *  - Truncates to the top `MAX_STACK_FRAMES` frames.
 *
 * Returns `undefined` when the input is falsy so callers can omit the
 * stack from metadata cleanly.
 */
export function sanitizeStack(
	stack: string | undefined,
	repoRoot: string = resolveRepoRoot(),
): string[] | undefined {
	if (!stack) {
		return undefined;
	}

	const rootPattern = repoRoot
		? new RegExp(escapeRegExp(repoRoot), "g")
		: null;

	const lines = stack.split("\n").slice(1); // drop the "Error: msg" header
	const cleaned: string[] = [];
	for (const raw of lines) {
		if (cleaned.length >= MAX_STACK_FRAMES) {
			break;
		}
		if (raw.includes("node_modules")) {
			continue;
		}
		// Skip node internals — these are at lines like
		// "    at process.processTicksAndRejections (node:internal/...)".
		if (/\(node:/.test(raw) || /\s+at\s+node:/.test(raw)) {
			continue;
		}

		let line = raw;
		if (rootPattern) {
			line = line.replace(rootPattern, "");
		}
		line = line.replace(/file:\/\/\//g, "");
		line = line.replace(/\\/g, "/");
		line = line.trim();
		if (line.length === 0) {
			continue;
		}
		cleaned.push(line);
	}
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Extract a string error name without crashing on weird inputs.
 */
function readErrorName(err: unknown): string {
	if (err && typeof err === "object") {
		const candidate = err as {
			name?: unknown;
			constructor?: { name?: unknown };
		};
		if (typeof candidate.name === "string" && candidate.name.length > 0) {
			return candidate.name;
		}
		if (
			candidate.constructor &&
			typeof candidate.constructor.name === "string" &&
			candidate.constructor.name.length > 0
		) {
			return candidate.constructor.name;
		}
	}
	return typeof err;
}

/**
 * Best-effort message read with truncation. Returns the empty string when
 * `err` has no readable message (still produces a valid metadata payload).
 */
function readErrorMessage(err: unknown): string {
	let raw: string;
	if (err instanceof Error) {
		raw = err.message;
	} else if (typeof err === "string") {
		raw = err;
	} else if (err && typeof err === "object" && "message" in err) {
		const candidate = (err as { message?: unknown }).message;
		raw = typeof candidate === "string" ? candidate : String(candidate);
	} else {
		raw = String(err);
	}
	if (raw.length > MAX_MESSAGE_CHARS) {
		return `${raw.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
	}
	return raw;
}

/**
 * Build the `exception` metadata block from a thrown value.
 */
export function buildException(
	err: unknown,
	repoRoot: string = resolveRepoRoot(),
): ExceptionMetadata {
	const type = readErrorName(err);
	const message = readErrorMessage(err);
	const stack =
		err && typeof err === "object" && "stack" in err
			? ((err as { stack?: unknown }).stack as string | undefined)
			: undefined;
	const stacktrace = sanitizeStack(stack, repoRoot);
	const result: ExceptionMetadata = { type, message };
	if (stacktrace) {
		result.stacktrace = stacktrace;
	}
	return result;
}

/**
 * Walk `Error.cause` recursively, capping at depth 5 to avoid runaway
 * loops on pathological inputs. Returns `undefined` when no cause is
 * present.
 */
export function extractCauseChain(
	err: unknown,
	maxDepth: number = MAX_CAUSE_DEPTH,
	repoRoot: string = resolveRepoRoot(),
): ExceptionMetadata | undefined {
	if (!err || typeof err !== "object") {
		return undefined;
	}
	const cause = (err as { cause?: unknown }).cause;
	if (!cause) {
		return undefined;
	}
	if (maxDepth <= 0) {
		return undefined;
	}
	const exception = buildException(cause, repoRoot);
	const nested = extractCauseChain(cause, maxDepth - 1, repoRoot);
	if (nested) {
		// Recursive shape — store the next cause under a `cause` property
		// of the exception block so the viewer can render the full chain.
		return Object.assign({}, exception, {
			cause: nested,
		}) as ExceptionMetadata;
	}
	return exception;
}

/**
 * JSON.stringify with circular-reference handling. Returns the empty
 * string when serialization itself blows up (e.g. a Proxy that throws
 * from `get`).
 */
function safeStringify(value: unknown): string {
	const seen = new WeakSet();
	try {
		return JSON.stringify(value, (_key, val) => {
			if (val && typeof val === "object") {
				if (seen.has(val as object)) {
					return "[Circular]";
				}
				seen.add(val as object);
			}
			if (typeof val === "bigint") {
				return val.toString();
			}
			if (typeof val === "function") {
				return "[Function]";
			}
			if (typeof val === "symbol") {
				return "[Symbol]";
			}
			return val;
		});
	} catch {
		return "";
	}
}

/**
 * Truncate a string to `MAX_INPUT_BYTES` and append an ellipsis when
 * over budget. Compared with `Buffer.byteLength` so multi-byte
 * characters do not slip past the cap.
 */
function truncateBytes(input: string): string {
	const bytes = Buffer.from(input, "utf8");
	if (bytes.length <= MAX_INPUT_BYTES) {
		return input;
	}
	// Cut the encoded bytes once (the ellipsis takes 3), stepping back over
	// continuation bytes so no character is split: a split pair would leave a
	// lone surrogate, which Postgres refuses in jsonb, and a character-by-
	// character walk with a byte count each step took seconds on a large input.
	let end = MAX_INPUT_BYTES - 3;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
		end--;
	}
	return `${bytes.subarray(0, end).toString("utf8")}…`;
}

/**
 * Sanitize an input snapshot for storage in `audit_log.metadata`.
 *
 * Order of operations matters here. `redactSensitiveKeys` has no
 * circular-reference tracking (it predates this middleware and is the
 * same redactor used at write time on already-flat metadata payloads).
 * If we call the redactor on an arbitrary user-supplied input first, a
 * circular structure stack-overflows. So:
 *   1. `safeStringify` first — this is the circular-aware serializer
 *      that emits `"[Circular]"` markers and `"[Function]"`/`"[Symbol]"`
 *      for non-JSONable values.
 *   2. Parse the serialized form back into a plain JSON tree.
 *   3. Run `redactSensitiveKeys` over the now-acyclic tree.
 *   4. ONLY THEN cut to the byte cap. An input over the cap is recorded as
 *      `{ _truncated }`, a prefix of the REDACTED tree's JSON: once cut it is
 *      a string, which the write-time redactor cannot look inside, so a
 *      `password` or `apiKey` cut before redaction would be stored verbatim.
 *
 * Fields that hold a whole user-written body are summarized before this, by
 * the middleware's per-path redaction. A tree the redactor cannot walk (one
 * nested deeply enough to overflow the stack) is recorded as a placeholder,
 * never as its raw text.
 *
 * Returns `undefined` when input is `undefined` so the caller can drop
 * the field cleanly.
 */
export function sanitizeInput(input: unknown): unknown {
	if (input === undefined) {
		return undefined;
	}
	if (input === null) {
		return null;
	}
	const serialized = safeStringify(input);
	if (!serialized) {
		// Serialization failed; record a placeholder so the operator sees
		// that input was present but unprintable.
		return { _truncated: "[serialization-failed]" };
	}
	let redacted: unknown;
	try {
		// Safe to recurse — the parsed tree has no cycles (safeStringify
		// converted them to "[Circular]" leaves).
		redacted = redactSensitiveKeys(JSON.parse(serialized) as unknown);
	} catch {
		return { _truncated: "[redaction-failed]" };
	}
	const redactedSerialized = safeStringify(redacted);
	const truncated = truncateBytes(redactedSerialized);
	if (truncated === redactedSerialized) {
		return redacted;
	}
	// We truncated; the result is no longer valid JSON, so wrap it.
	return { _truncated: truncated };
}

/**
 * Compute a stable 16-char hex fingerprint over `${type}|${code}|${topFrame}`.
 * Sentry-style — operators query for "how many of this same error fired
 * in the last hour" without scanning every row.
 */
export function computeFingerprint(
	type: string,
	code: string,
	topFrame: string | undefined,
): string {
	const input = `${type}|${code}|${topFrame ?? ""}`;
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
