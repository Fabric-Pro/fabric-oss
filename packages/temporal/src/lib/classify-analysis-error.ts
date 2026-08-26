/**
 * Classify any error thrown by the AI Update generate-path LLM call
 * (`analyzeContextAndPropose` → model resolution + `generateObject`) into a
 * stable `errorClass`, an actionable user message, and structured log fields.
 *
 * Bug #391: that call site was previously unguarded, so failures surfaced as an
 * opaque "Analysis failed: <raw message>" card with no class and no diagnostic
 * trail. This classifier reuses the existing `classifyLimitError` primitive and
 * the same cause-chain walk used by `unwrapPmSyncError`, so it covers all four
 * candidate sub-causes (context-length / quota+rate-limit / schema-parse /
 * provider-not-configured) and otherwise falls back to transient_or_unknown.
 */
import { classifyLimitError, sanitizeProviderMessage } from "@repo/ai/limits";
// Imported directly from the `ai` package (not the @repo/ai root) so this
// module stays light — its test doesn't mock @repo/ai. `isInstance` matches on
// a symbol marker, so the class identity is the same one @repo/ai re-exports.
import { NoObjectGeneratedError } from "ai";

export type BacklogAnalysisErrorClass =
	| "context_length"
	| "provider_quota"
	| "provider_rate_limit"
	| "provider_overloaded"
	| "provider_unavailable"
	| "output_limit"
	| "schema_parse"
	| "provider_not_configured"
	| "provider_content_filter"
	| "transient_or_unknown";

export interface ClassifiedAnalysisError {
	errorClass: BacklogAnalysisErrorClass;
	userMessage: string;
	logFields: Record<string, unknown>;
}

const USER_MESSAGES: Record<BacklogAnalysisErrorClass, string> = {
	context_length:
		"The selected context was too large for the AI model. Narrow the date range or include fewer sources, then retry.",
	provider_quota:
		"AI quota exceeded for this workspace. Check AI billing/usage, then retry.",
	provider_rate_limit:
		"The AI provider is busy right now. Wait a moment and retry.",
	provider_overloaded:
		"The AI provider is busy right now. Wait a moment and retry.",
	provider_unavailable:
		"The AI provider is temporarily unavailable (server error). Please wait a moment and retry.",
	output_limit:
		"The document/context is too large for the configured model's output limit — the response was cut off before it could complete. Reduce the input size or switch to a model with a larger output limit; retrying at the same size won't help.",
	provider_not_configured:
		"No AI provider is configured for this workspace. Set one up in AI settings.",
	provider_content_filter:
		"The AI provider refused to process the selected context because it tripped the provider's content policy. Deselect the most likely source and retry — retrying the same selection won't help.",
	schema_parse:
		"The AI returned a malformed result. Please retry — this is usually transient.",
	transient_or_unknown:
		"AI Update hit an unexpected error and couldn't complete. Please retry; details were logged.",
};

/** Walk the `.cause` chain to the most informative `{ name, message }`. */
function unwrap(error: unknown): { name: string; message: string } {
	let current: unknown = error;
	let depth = 0;
	let bestName = "";
	let bestMessage = "";
	while (current != null && depth < 8) {
		const e = current as {
			name?: unknown;
			message?: unknown;
			cause?: unknown;
		};
		const message = typeof e.message === "string" ? e.message : "";
		const name = typeof e.name === "string" ? e.name : "";
		const isGenericWrapper =
			message === "Activity task failed" ||
			message === "Workflow execution failed";
		if (message && !isGenericWrapper) {
			bestMessage = message;
			if (name) {
				bestName = name;
			}
		} else if (!bestName && name) {
			bestName = name;
		}
		current = e.cause;
		depth += 1;
	}
	if (!bestMessage) {
		bestMessage = error instanceof Error ? error.message : String(error);
	}
	return { name: bestName, message: bestMessage };
}

function build(
	errorClass: BacklogAnalysisErrorClass,
	error: unknown,
	extra: Record<string, unknown>,
	rawCauseOverride?: string,
): ClassifiedAnalysisError {
	const { name, message } = unwrap(error);
	const rawCause = (rawCauseOverride ?? message).slice(0, 500);
	return {
		errorClass,
		userMessage:
			errorClass === "transient_or_unknown"
				? withDiagnosticTail(USER_MESSAGES[errorClass], name, rawCause)
				: USER_MESSAGES[errorClass],
		logFields: {
			errorClass,
			errorName: name || undefined,
			rawCause,
			...extra,
		},
	};
}

/**
 * Append the provider's own words to the one message that has none of its own.
 *
 * Every other class names a cause and an action. `transient_or_unknown` is the
 * bucket for errors we failed to recognise, and it said only "details were
 * logged" — which is true, and useless to everyone who cannot read the worker's
 * logs. A QA run on 18 Aug 2026 spent an afternoon narrowing a reproducible AI
 * Update failure by black-box experiment for exactly this reason.
 *
 * Kept short and sanitized: the same `sanitizeProviderMessage` the limit
 * classifier uses strips endpoints, keys and Authorization headers, and the
 * result is capped so a stack-trace-shaped message cannot swamp the card.
 */
const DIAGNOSTIC_TAIL_MAX_CHARS = 160;

function withDiagnosticTail(
	base: string,
	name: string,
	rawCause: string,
): string {
	const detail = sanitizeProviderMessage(rawCause);
	if (!detail) {
		return base;
	}
	const truncated =
		detail.length > DIAGNOSTIC_TAIL_MAX_CHARS
			? `${detail.slice(0, DIAGNOSTIC_TAIL_MAX_CHARS - 1).trimEnd()}…`
			: detail;
	return name ? `${base} (${name}: ${truncated})` : `${base} (${truncated})`;
}

/**
 * Bug #1681: the AI SDK retries transient provider failures (5xx / network)
 * and, on exhaustion, throws an `AI_RetryError` that wraps the real
 * `APICallError` (which carries the HTTP `statusCode`) in `.lastError` /
 * `.errors[]` — neither of which `classifyLimitError`'s `pickStatusCode` nor
 * `unwrap()` traverse. The result: every retried provider error collapsed
 * into the opaque `transient_or_unknown` "details were logged" bucket.
 *
 * Descend the wrapper chain (`.lastError` → last of `.errors[]` → `.cause`)
 * to the most informative leaf so the existing limit/status classification
 * can see the provider error. Stops as soon as a node carries a numeric
 * status code; returns the original error when there is no wrapper to unwrap
 * (so non-wrapped shapes — covered by the existing tests — are untouched).
 */
function descendToProviderError(error: unknown): unknown {
	let current: unknown = error;
	let depth = 0;
	while (current != null && typeof current === "object" && depth < 8) {
		const e = current as {
			statusCode?: unknown;
			status?: unknown;
			cause?: unknown;
			lastError?: unknown;
			errors?: unknown;
		};
		if (typeof e.statusCode === "number" || typeof e.status === "number") {
			return current;
		}
		let next: unknown;
		if (e.lastError != null) {
			next = e.lastError;
		} else if (Array.isArray(e.errors) && e.errors.length > 0) {
			next = e.errors[e.errors.length - 1];
		} else if (e.cause != null) {
			next = e.cause;
		}
		if (next == null || next === current) {
			break;
		}
		current = next;
		depth += 1;
	}
	return current;
}

/**
 * Codex SHOULD-FIX #8: a `NoObjectGeneratedError` whose `finishReason` is
 * "length" is NOT a malformed-output/parse failure — the model produced valid
 * output but was cut off at its output-token limit before the structured object
 * closed. That is deterministic for a given input + model, so it must classify
 * as `output_limit` (non-retryable copy), not the `schema_parse` "retry usually
 * helps" bucket. Walk the `.cause` chain so a wrapped generate error is still
 * detected. Uses `NoObjectGeneratedError.isInstance` (symbol marker), so a plain
 * Error merely NAMED "NoObjectGeneratedError" does not match here and correctly
 * falls through to the schema_parse regex.
 */
function isOutputLengthError(error: unknown): boolean {
	let current: unknown = error;
	let depth = 0;
	while (current != null && depth < 8) {
		if (
			NoObjectGeneratedError.isInstance(current) &&
			current.finishReason === "length"
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
		depth += 1;
	}
	return false;
}

function pickStatusCode(error: unknown): number | undefined {
	if (error && typeof error === "object") {
		const e = error as { statusCode?: unknown; status?: unknown };
		if (typeof e.statusCode === "number") {
			return e.statusCode;
		}
		if (typeof e.status === "number") {
			return e.status;
		}
	}
	return undefined;
}

export function classifyBacklogAnalysisError(
	error: unknown,
): ClassifiedAnalysisError {
	// Bug #1681: descend `AI_RetryError`/cause wrappers to the leaf provider
	// error so the classification below can see the real `statusCode`. For
	// non-wrapped errors this is the identity, so existing behaviour is
	// preserved.
	const probe = descendToProviderError(error);

	// 1) Limit/budget shapes (context length, quota, rate limit, overloaded).
	// Intentional ordering: classifyLimitError runs BEFORE the schema_parse
	// regex so a genuine context-overflow classifies as `context_length` even
	// though the fallback string path could match "context length" phrasing in
	// any message. Real NoObjectGeneratedError/schema-validation failures never
	// carry context-length phrasing and fall through to branch 2 correctly.
	const limit = classifyLimitError(probe);
	if (limit) {
		// `internal_budget` cannot originate from a provider call here; map it to
		// quota defensively so it still produces actionable copy.
		const mapped: BacklogAnalysisErrorClass =
			limit.kind === "internal_budget" ? "provider_quota" : limit.kind;
		// Use limit.message (already sanitized by classifyLimitError) as rawCause
		// so that credentials stripped by sanitize() are never re-exposed via
		// the raw error's unwrapped message.
		return build(
			mapped,
			probe,
			{ provider: limit.provider, limitKind: limit.kind },
			limit.message,
		);
	}

	// 2) Provider-side server error (5xx) the limit classifier doesn't own
	// (it handles 402/429/529). A provider outage / bad-gateway lands here
	// instead of `transient_or_unknown`, with actionable retry copy. 529 is
	// already claimed by `classifyLimitError` above as `provider_overloaded`.
	const statusCode = pickStatusCode(probe);
	if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
		return build("provider_unavailable", probe, { statusCode });
	}

	// 3) Output-token-limit cut-off. A NoObjectGeneratedError with finishReason
	// "length" means the model hit its output cap before the object closed —
	// deterministic, so classify it as `output_limit` (non-retryable copy)
	// BEFORE the schema_parse regex below, which would otherwise bucket it as a
	// transient malformed-output failure. Check the original error (its
	// finishReason lives on the wrapper, not the descended leaf).
	if (isOutputLengthError(error)) {
		return build("output_limit", probe, {});
	}

	const { name, message } = unwrap(probe);
	const haystack = `${name} ${message}`;

	// 4) Structured-output parse failure from `generateObject`.
	if (
		/NoObjectGenerated|TypeValidation|did not match schema/i.test(haystack)
	) {
		return build("schema_parse", probe, {});
	}

	// 5) Provider not configured.
	if (
		name === "AIProviderNotConfiguredError" ||
		/no ai provider|provider not configured/i.test(message)
	) {
		return build("provider_not_configured", probe, {});
	}

	// 6) Provider content-policy rejection. Azure OpenAI answers 400 with
	// `content_filter` / `ResponsibleAIPolicyViolation` when the PROMPT (not the
	// completion) trips its filters, and Bedrock/Anthropic use "guardrail". None
	// of the branches above own a 400, so these landed in the catch-all with
	// copy that told the user to retry — advice that cannot work, because the
	// same input trips the same filter every time.
	if (
		/content[_ ]filter|content management policy|responsibleaipolicy|guardrail|jailbreak|prompt shield/i.test(
			haystack,
		)
	) {
		return build("provider_content_filter", probe, { statusCode });
	}

	// 7) Anything else: transient/unknown.
	//
	// This is the only class with nothing specific to say, which is exactly when
	// the provider's own words are worth the most. Withholding them turned a
	// staging failure into an investigation that needed Temporal history access
	// (QA, 18 Aug 2026) — the message named no cause, so nobody outside the
	// worker logs could act on it. Carry a short sanitized tail instead.
	return build("transient_or_unknown", probe, {});
}
