/**
 * Agent Retry Helpers
 *
 * Application-level (whole-node) retry helpers shared by the LangGraph
 * agents under `agents/langchain/`. These sit ABOVE the SDK per-request
 * retry configured in `services/langchain-models.ts` (`DEFAULT_MAX_RETRIES`
 * / LangChain core's `AsyncCaller` + `pRetry`). Every node-level retry here
 * re-enters that SDK envelope — including its own exponential backoff — so
 * these are deliberately short: a small retry ceiling and a small, capped
 * backoff, not a second independent resilience layer.
 */

import {
	ContextOverflowError,
	getRetryable,
	ModelAbortError,
} from "@langchain/core/errors";

/**
 * Default ceiling for whole-node retries. Individual agents may keep a
 * larger or smaller local constant when their retry shape genuinely
 * differs (e.g. more corrective rounds for patch-mode convergence).
 */
export const MAX_NODE_RETRIES = 3;

/** Base delay for the exponential backoff, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 500;

/** Upper bound on the backoff delay, in milliseconds. */
export const RETRY_MAX_DELAY_MS = 4000;

/** Read a string `message` from an Error-like object, or "" when absent. */
function messageOf(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		return typeof message === "string" ? message : "";
	}
	return "";
}

/**
 * Check if an error is a JSON parse error.
 *
 * JSON parse errors get extra retry attempts in most agents' node-retry
 * logic, since LLMs sometimes produce malformed JSON / tool-call arguments
 * that a retry can fix.
 *
 * @param error - The error to check (inputs without a string `message`
 *   return false)
 * @returns Whether it's a JSON parse error
 */
export function isJsonParseError(error: unknown): boolean {
	const errorMsg = messageOf(error);
	return (
		errorMsg.includes("Failed to parse tool call arguments as JSON") ||
		errorMsg.includes("Invalid JSON") ||
		errorMsg.includes("JSON parse error")
	);
}

/**
 * The message / code / status ladder for one error object (no `.cause`
 * traversal). Kept identical to the classifier that used to live in the
 * project-document-generator agent; its tests pin this behaviour.
 */
function matchesContextOverflowShape(error: object): boolean {
	const msg = messageOf(error);
	if (/prompt is too long/i.test(msg)) {
		return true;
	}
	if (/context_length_exceeded/i.test(msg)) {
		return true;
	}
	if (/maximum context length/i.test(msg)) {
		return true;
	}
	// AI SDK / OpenAI-shape errors expose `code` on the object
	const { code, status } = error as { code?: unknown; status?: unknown };
	if (code === "context_length_exceeded") {
		return true;
	}
	const nestedCode = (error as { error?: { code?: unknown } | null }).error
		?.code;
	if (nestedCode === "context_length_exceeded") {
		return true;
	}
	// 400 + "too long" variants from gateways wrapping Anthropic
	if (status === 400 && /too long|context/i.test(msg)) {
		return true;
	}
	return false;
}

/**
 * Check whether an error is a provider-side "prompt too long / context
 * length exceeded" failure. These are deterministic — retrying with the same
 * payload fails again and burns a full round-trip of tokens each attempt.
 *
 * Matches LangChain core's `ContextOverflowError` (which the OpenAI and
 * Anthropic chat-model wrappers produce for their own wording), plus the
 * message/code/status shapes below for errors those wrappers do not convert —
 * notably Anthropic's "prompt is too long" wording arriving through an
 * OpenAI-compatible gateway (e.g. Databricks-served Claude goes through
 * ChatOpenAI, so it is not converted). The `.cause` of a wrapped error is
 * checked one level deep.
 *
 * @param error - The error to check (non-object inputs return false)
 * @returns Whether it is a context-window overflow
 */
export function isContextOverflowError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	if (ContextOverflowError.isInstance(error)) {
		return true;
	}
	if (matchesContextOverflowShape(error)) {
		return true;
	}
	const cause = (error as { cause?: unknown }).cause;
	if (typeof cause === "object" && cause !== null) {
		return (
			ContextOverflowError.isInstance(cause) ||
			matchesContextOverflowShape(cause)
		);
	}
	return false;
}

/** Parse a numeric HTTP status (number or numeric string), else undefined. */
function toStatus(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
		return Number(value.trim());
	}
	return undefined;
}

/** HTTP status from `status`, `statusCode` or `response.status`. */
function httpStatusOf(error: object): number | undefined {
	const e = error as {
		status?: unknown;
		statusCode?: unknown;
		response?: { status?: unknown } | null;
	};
	return (
		toStatus(e.status) ??
		toStatus(e.statusCode) ??
		toStatus(e.response?.status)
	);
}

/** HTTP statuses below 500 that are still transient. */
const RETRYABLE_4XX_STATUSES = new Set([408, 425, 429]);

/** Error codes (Node system errors and undici) that signal a transient network fault. */
const RETRYABLE_NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
	"EAI_AGAIN",
	"ENOTFOUND",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

/** Lowercase message fragments that indicate a transient failure. */
const RETRYABLE_MESSAGE_FRAGMENTS = [
	"timeout",
	"timed out",
	"rate limit",
	"too many requests",
	"network",
	"econnrefused",
	"econnreset",
	"socket hang up",
	"fetch failed",
	"overloaded",
	"service unavailable",
	"bad gateway",
	"gateway timeout",
	"temporarily unavailable",
];

/** The class name of an error: its constructor name, or its `name`. */
function errorClassNames(error: object): string[] {
	const names: string[] = [];
	const ctorName = (error as { constructor?: { name?: unknown } }).constructor
		?.name;
	if (typeof ctorName === "string") {
		names.push(ctorName);
	}
	const name = (error as { name?: unknown }).name;
	if (typeof name === "string") {
		names.push(name);
	}
	return names;
}

/** How many `.cause` links to follow when looking for an error `code`. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Error codes for connection failures not expected to recover within the node
 * retry window (TLS trust/hostname/validity, malformed URL). Retrying the
 * same call at node level only repeats the failure.
 */
const PERMANENT_CONNECTION_CODES = new Set([
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_INVALID_URL",
	"ERR_INVALID_PROTOCOL",
]);

/**
 * The string `code` of the error and of each `.cause` below it, up to
 * {@link MAX_CAUSE_DEPTH} links, stopping at a repeated object (cycle guard).
 */
function causeChainCodes(error: object): string[] {
	const codes: string[] = [];
	const seen = new Set<object>();
	let current: unknown = error;
	for (
		let depth = 0;
		depth <= MAX_CAUSE_DEPTH &&
		typeof current === "object" &&
		current !== null &&
		!seen.has(current);
		depth++
	) {
		seen.add(current);
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") {
			codes.push(code);
		}
		current = (current as { cause?: unknown }).cause;
	}
	return codes;
}

/**
 * Longest wait the node-level backoff can honour. A server cooldown
 * (`retryAfterMs`) beyond this cannot be waited out by a node retry.
 */
function exceedsNodeBackoff(error: object): boolean {
	const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
	return (
		typeof retryAfterMs === "number" &&
		Number.isFinite(retryAfterMs) &&
		retryAfterMs > RETRY_MAX_DELAY_MS
	);
}

/**
 * Check if an error is worth retrying at the node level: a JSON parse
 * error, or a failure treated as transient.
 *
 * Decided in this order; the first rule that applies wins. Safety rules
 * (a-e) run before anything that can say "retry", so an error that matches
 * both cannot be retried by a later rule:
 *  a. Context overflow -> no (deterministic for the same payload).
 *  b. User/run abort (`AbortError` name, `ModelAbortError`) -> no.
 *  c. LangChain stamped the error non-retryable (`getRetryable === false`)
 *     -> no. Core's AsyncCaller stamps aborts, auth/validation statuses and
 *     exhausted quotas this way and leaves 5xx unstamped
 *     (`@langchain/core` `dist/utils/async_caller.cjs`, default handler).
 *  d. Server cooldown: a numeric `retryAfterMs` above {@link RETRY_MAX_DELAY_MS}
 *     (set by core's `setRateLimitMetadata` on long Retry-After hints) -> no;
 *     the node backoff is shorter than the cooldown.
 *  e. A code in {@link PERMANENT_CONNECTION_CODES} (TLS certificate, invalid
 *     URL) on the error or up to five links down its `.cause` chain -> no.
 *  f. JSON parse error -> yes (an LLM can emit valid JSON on the next try).
 *  g. Stamped retryable (`getRetryable === true`) -> yes.
 *  h. HTTP status (`status`, `statusCode`, `response.status`): 408, 425, 429
 *     and every status of 500 or above (including Anthropic's 529) are
 *     treated as transient -> yes; any other 4xx -> no.
 *  i. `TimeoutError` name (how `@langchain/openai` rewraps a connection
 *     timeout) or an `APIConnectionError` / `APIConnectionTimeoutError`
 *     class -> yes (treated as transient; permanent causes were excluded
 *     by rule e).
 *  j. A network error code (ECONNRESET, ETIMEDOUT, ...) on the error or
 *     up to five links down its `.cause` chain -> yes.
 *  k. Case-insensitive message fallback for gateways that only surface text
 *     -> yes.
 *  l. Otherwise -> no.
 *
 * These retries re-enter the SDK retry envelope (see the module comment), so
 * the per-node ceiling stays small. Every rule above has a case in
 * `__tests__/retry.test.ts`, including the overlap cases that pin rules
 * a-e ahead of f-k.
 *
 * @param error - The error to check (any thrown value)
 * @returns Whether the error is retryable
 */
export function isRetryableError(error: unknown): boolean {
	if (typeof error === "object" && error !== null) {
		// a. Context overflow
		if (isContextOverflowError(error)) {
			return false;
		}
		// b. Abort
		if (
			(error as { name?: unknown }).name === "AbortError" ||
			ModelAbortError.isInstance(error)
		) {
			return false;
		}
		// c. Stamped non-retryable
		const stamped = getRetryable(error);
		if (stamped === false) {
			return false;
		}
		// d. Cooldown longer than the node backoff
		if (exceedsNodeBackoff(error)) {
			return false;
		}
		// e. Permanent connection failure within the bounded cause chain
		const codes = causeChainCodes(error);
		if (codes.some((code) => PERMANENT_CONNECTION_CODES.has(code))) {
			return false;
		}
		// f. JSON parse
		if (isJsonParseError(error)) {
			return true;
		}
		// g. Stamped retryable
		if (stamped === true) {
			return true;
		}
		// h. HTTP status
		const status = httpStatusOf(error);
		if (status !== undefined) {
			if (status >= 500 || RETRYABLE_4XX_STATUSES.has(status)) {
				return true;
			}
			if (status >= 400 && status < 500) {
				return false;
			}
		}
		// i. Timeout / connection error classes
		const classNames = errorClassNames(error);
		if (
			classNames.includes("TimeoutError") ||
			classNames.includes("APIConnectionError") ||
			classNames.includes("APIConnectionTimeoutError")
		) {
			return true;
		}
		// j. Network error codes
		if (codes.some((code) => RETRYABLE_NETWORK_CODES.has(code))) {
			return true;
		}
	}

	// k. Message fallback (non-objects use String(error))
	const message = (
		typeof error === "object" && error !== null
			? messageOf(error)
			: String(error ?? "")
	).toLowerCase();
	return RETRYABLE_MESSAGE_FRAGMENTS.some((fragment) =>
		message.includes(fragment),
	);
}

/**
 * Calculate retry delay with exponential backoff, capped at
 * {@link RETRY_MAX_DELAY_MS}.
 *
 * @param retryCount - Current retry count
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(retryCount: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * 2 ** retryCount, RETRY_MAX_DELAY_MS);
}

/**
 * Wait for the specified delay.
 *
 * @param ms - Milliseconds to wait
 */
export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
