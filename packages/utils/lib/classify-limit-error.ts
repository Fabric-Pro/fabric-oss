import type { LimitKind, LimitSignal } from "./limit-signal";

/**
 * Detects provider/SDK/internal error shapes that indicate a budget or limit
 * was hit, and normalizes them to a `LimitSignal`. Returns `null` for any
 * error that is not a recognized limit exhaustion — callers should treat
 * `null` as "not a limit problem, handle as a generic error."
 *
 * Shapes covered:
 *   - AI SDK `APICallError` / `AI_APICallError` with HTTP statusCode 402/429/529.
 *   - OpenAI-style error.code: "insufficient_quota", "rate_limit_exceeded",
 *     "context_length_exceeded".
 *   - Anthropic error.type: "rate_limit_error", "overloaded_error".
 *   - AI SDK `AI_InvalidPromptError` / `NoOutputGeneratedError` whose message
 *     mentions context length / maximum context.
 *   - String fallback: last-resort regex over `.message` for "quota",
 *     "credit balance", "rate limit", "context length", "insufficient_quota".
 */
export function classifyLimitError(error: unknown): LimitSignal | null {
	if (!error) {
		return null;
	}

	const err = toErrorBag(error);
	const provider = detectProvider(err);
	const statusCode = pickStatusCode(err);
	const code = pickCode(err);
	const anthropicType = pickAnthropicType(err);
	const retryAfterMs = pickRetryAfterMs(err);
	const message = sanitize(pickMessage(err));

	// 1) HTTP status-based mapping (most reliable across providers).
	if (statusCode === 402) {
		return make("provider_quota", message, provider, retryAfterMs);
	}
	if (statusCode === 429) {
		// OpenAI returns 429 for both rate-limit AND out-of-quota billing errors.
		// Disambiguate via `code`.
		if (code === "insufficient_quota") {
			return make("provider_quota", message, provider, retryAfterMs);
		}
		return make("provider_rate_limit", message, provider, retryAfterMs);
	}
	if (statusCode === 529 || anthropicType === "overloaded_error") {
		return make("provider_overloaded", message, provider, retryAfterMs);
	}

	// 2) OpenAI-style explicit error codes.
	if (code === "insufficient_quota") {
		return make("provider_quota", message, provider, retryAfterMs);
	}
	if (
		code === "rate_limit_exceeded" ||
		anthropicType === "rate_limit_error"
	) {
		return make("provider_rate_limit", message, provider, retryAfterMs);
	}
	if (code === "context_length_exceeded") {
		return make("context_length", message, provider);
	}

	// 3) AI SDK class names that imply context length.
	const sdkName = err.name ?? err.constructor?.name;
	if (
		(sdkName === "AI_InvalidPromptError" ||
			sdkName === "InvalidPromptError" ||
			sdkName === "NoOutputGeneratedError" ||
			sdkName === "AI_NoOutputGeneratedError") &&
		/\b(context\s+length|context\s+window|maximum\s+context|max(?:_|\s)?tokens)\b/i.test(
			message,
		)
	) {
		return make("context_length", message, provider);
	}

	// 4) String fallback over .message. Order matters: quota before rate limit.
	const lc = message.toLowerCase();
	// "credit balance" wording covers the two exhaustion messages actually
	// seen in production: the gateway's "A positive credit balance is
	// required for all requests…" (HTTP 402) and the upstream provider's
	// "Your credit balance is too low…" — the latter arrives as HTTP 400, so
	// status alone never classified it and it fell through as a generic
	// request failure.
	if (
		/insufficient[_\s-]?quota|exceeded\s+your\s+quota|credit\s+balance|add\s+credits|purchase\s+credits/.test(
			lc,
		)
	) {
		return make("provider_quota", message, provider, retryAfterMs);
	}
	if (/context[\s_-]?length|context\s+window|maximum\s+context/.test(lc)) {
		return make("context_length", message, provider);
	}
	if (/\brate[\s_-]?limit\b|too\s+many\s+requests/.test(lc)) {
		return make("provider_rate_limit", message, provider, retryAfterMs);
	}
	if (/\boverloaded\b/.test(lc)) {
		return make("provider_overloaded", message, provider, retryAfterMs);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ErrorBag {
	name?: string;
	message?: string;
	statusCode?: number;
	status?: number;
	code?: string | number;
	type?: string;
	cause?: unknown;
	data?: unknown;
	response?: { status?: number; headers?: Record<string, string> };
	headers?: Record<string, string>;
	/** AI SDK `APICallError` carries the response headers here, not on `.headers`. */
	responseHeaders?: Record<string, string>;
	error?: ErrorBag;
	// Bug #1681: AI SDK `RetryError` wraps the real provider error in
	// `.lastError` / `.errors[]` (not `.cause`/`.error`). Traversed by
	// `childBags` so a retried/wrapped 402/429/529/quota still classifies.
	lastError?: unknown;
	errors?: unknown;
	constructor?: { name?: string };
}

/**
 * Nested error candidates to recurse into when extracting a signal. Covers the
 * standard `.cause`/`.error` chains AND the AI SDK `RetryError` wrappers
 * (`.lastError`, `.errors[]`) introduced in Bug #1681's investigation.
 */
function childBags(err: ErrorBag): unknown[] {
	const kids: unknown[] = [];
	if (err.cause != null) {
		kids.push(err.cause);
	}
	if (err.error != null) {
		kids.push(err.error);
	}
	if (err.lastError != null) {
		kids.push(err.lastError);
	}
	if (Array.isArray(err.errors)) {
		for (const e of err.errors) {
			if (e != null) {
				kids.push(e);
			}
		}
	}
	return kids;
}

function toErrorBag(error: unknown): ErrorBag {
	if (typeof error === "string") {
		return { message: error };
	}
	if (error && typeof error === "object") {
		return error as ErrorBag;
	}
	return { message: String(error) };
}

function make(
	kind: LimitKind,
	message: string,
	provider: string | undefined,
	retryAfterMs?: number,
): LimitSignal {
	const signal: LimitSignal = { kind, message };
	if (provider) {
		signal.provider = provider;
	}
	if (retryAfterMs && retryAfterMs > 0) {
		signal.retryAfterMs = retryAfterMs;
	}
	return signal;
}

function pickStatusCode(err: ErrorBag, depth = 0): number | undefined {
	const direct =
		coerceNumber(err.statusCode) ??
		coerceNumber(err.status) ??
		coerceNumber(err.response?.status);
	if (direct) {
		return direct;
	}
	if (depth >= 8) {
		return undefined;
	}
	for (const kid of childBags(err)) {
		const found = pickStatusCode(toErrorBag(kid), depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function pickCode(err: ErrorBag, depth = 0): string | undefined {
	const code =
		typeof err.code === "string"
			? err.code
			: (readNested(err, "error.code") ??
				readNested(err, "data.error.code"));
	if (typeof code === "string") {
		return code;
	}
	if (depth >= 8) {
		return undefined;
	}
	for (const kid of childBags(err)) {
		const found = pickCode(toErrorBag(kid), depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function pickAnthropicType(err: ErrorBag, depth = 0): string | undefined {
	const type =
		err.type ??
		readNested(err, "error.type") ??
		readNested(err, "data.error.type");
	if (typeof type === "string") {
		return type;
	}
	if (depth >= 8) {
		return undefined;
	}
	for (const kid of childBags(err)) {
		const found = pickAnthropicType(toErrorBag(kid), depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function pickMessage(err: ErrorBag): string {
	const msg =
		err.message ??
		readNested(err, "error.message") ??
		readNested(err, "data.error.message") ??
		readNested(err, "cause.message");
	return typeof msg === "string" && msg.length > 0 ? msg : "Unknown error";
}

/**
 * Bug #2288: the real provider headers live on the AI SDK `APICallError`'s
 * `.responseHeaders`, nested inside `RetryError.lastError`/`.errors[]` — so this
 * must recurse through `childBags` exactly like `pickStatusCode`, otherwise
 * every Retry-After a retried call carries is silently dropped.
 */
function pickRetryAfterMs(err: ErrorBag, depth = 0): number | undefined {
	// Each source is parsed independently rather than `??`-chained: an error can
	// carry a present-but-irrelevant `.headers` bag alongside the real
	// `.responseHeaders`, and short-circuiting on the first non-null object would
	// never look at the latter.
	const direct =
		parseRetryAfter(err.headers) ??
		parseRetryAfter(err.response?.headers) ??
		parseRetryAfter(err.responseHeaders);
	if (direct !== undefined) {
		return direct;
	}
	if (depth >= 8) {
		return undefined;
	}
	for (const kid of childBags(err)) {
		const found = pickRetryAfterMs(toErrorBag(kid), depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function parseRetryAfter(headers: unknown): number | undefined {
	if (!headers || typeof headers !== "object") {
		return undefined;
	}
	const bag = headers as Record<string, unknown>;

	// `retry-after-ms` (OpenAI / Azure) is millisecond-precision — prefer it over
	// the whole-second `retry-after`, which rounds a 1.5s hint up to 2s.
	const rawMs = bag["retry-after-ms"] ?? bag["Retry-After-Ms"];
	if (typeof rawMs === "string") {
		const ms = Number.parseFloat(rawMs);
		if (Number.isFinite(ms) && ms >= 0) {
			return Math.round(ms);
		}
	}

	const raw = bag["retry-after"] ?? bag["Retry-After"];
	if (typeof raw !== "string") {
		return undefined;
	}
	const seconds = Number.parseFloat(raw);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1000);
	}
	const asDate = Date.parse(raw);
	if (!Number.isNaN(asDate)) {
		return Math.max(0, asDate - Date.now());
	}
	return undefined;
}

function detectProvider(err: ErrorBag): string | undefined {
	const name = err.name ?? err.constructor?.name ?? "";
	const message = err.message ?? "";
	const blob = `${name} ${message}`.toLowerCase();
	if (blob.includes("anthropic")) {
		return "anthropic";
	}
	if (blob.includes("openai")) {
		return "openai";
	}
	if (blob.includes("azure")) {
		return "azure";
	}
	if (blob.includes("groq")) {
		return "groq";
	}
	if (blob.includes("gemini") || blob.includes("google")) {
		return "google";
	}
	if (blob.includes("deepseek")) {
		return "deepseek";
	}
	if (blob.includes("cerebras")) {
		return "cerebras";
	}
	return undefined;
}

function coerceNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const n = Number.parseInt(value, 10);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function readNested(source: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((acc, segment) => {
		if (acc && typeof acc === "object" && segment in (acc as object)) {
			return (acc as Record<string, unknown>)[segment];
		}
		return undefined;
	}, source);
}

/**
 * Strip common secret-ish patterns before putting the message anywhere users or
 * logs see it.
 *
 * Exported (as `sanitizeProviderMessage`) so every path that surfaces a raw
 * provider string reuses this one list rather than growing its own — see
 * `classify-analysis-error.ts`, which shows a provider message to the user when
 * it has no better classification to offer.
 */
function sanitize(message: string): string {
	return message
		.replace(/https?:\/\/\S+/g, "[endpoint]")
		.replace(/sk-[A-Za-z0-9_-]+/g, "[key]")
		.replace(/api[-_]?key["'\s:=]+[A-Za-z0-9_-]+/gi, "api-key: [redacted]")
		.replace(/bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
		.replace(
			/authorization["'\s:=]+[A-Za-z0-9._-]+/gi,
			"Authorization: [redacted]",
		)
		.trim();
}

export { sanitize as sanitizeProviderMessage };
