/**
 * Detects a model generation cut off by its output-token budget rather than
 * finishing normally. A tool call truncated for this reason has
 * deterministically incomplete args — retrying the identical generation
 * reproduces the same truncation every time, so callers use this to
 * short-circuit corrective-retry loops instead of burning the retry budget
 * on guaranteed-to-fail generations.
 *
 * Recognizes three provider `response_metadata` shapes:
 *  - Anthropic: `stop_reason === "max_tokens"`.
 *  - OpenAI/Azure Chat Completions (and most LangChain chat model wrappers
 *    that normalize onto it): `finish_reason === "length"`.
 *  - OpenAI/Azure **Responses API** (`@langchain/openai`'s Responses
 *    converter): does NOT synthesize `finish_reason: "length"` — it reports
 *    `status: "incomplete"` with
 *    `incomplete_details: { reason: "max_output_tokens" }`. A non-token
 *    incomplete reason (e.g. `"content_filter"`) is NOT truncation and must
 *    not be treated as one.
 */
export function isOutputTruncated(response: unknown): boolean {
	const meta = responseMetadata(response);
	const stop = meta.stop_reason ?? meta.finish_reason;
	if (stop === "max_tokens" || stop === "length") {
		return true;
	}
	if (meta.status === "incomplete") {
		const reason = incompleteReason(meta);
		if (reason === "max_output_tokens") {
			return true;
		}
	}
	return false;
}

/**
 * Resolves a human-readable stop/truncation reason from a model response for
 * logging, across the same three provider shapes `isOutputTruncated`
 * recognizes. Returns `undefined` when none is present.
 */
export function resolveStopReason(response: unknown): unknown {
	const meta = responseMetadata(response);
	return meta.stop_reason ?? meta.finish_reason ?? incompleteReason(meta);
}

function responseMetadata(response: unknown): Record<string, unknown> {
	return (
		(response as { response_metadata?: Record<string, unknown> })
			?.response_metadata ?? {}
	);
}

function incompleteReason(meta: Record<string, unknown>): unknown {
	return (meta.incomplete_details as { reason?: unknown } | undefined)
		?.reason;
}

/**
 * Hoists a stop/finish reason out of a gateway provider's raw response
 * envelope (`response.additional_kwargs.__raw_response`) into
 * `response_metadata`, where `resolveStopReason`/`isOutputTruncated` above
 * read from.
 *
 * Some gateway providers — the Databricks-served Anthropic path is the
 * confirmed case — populate LangChain's `response_metadata` with only
 * `model_provider` and `usage`, no `stop_reason`/`finish_reason` under any
 * name. This is consistent with a gateway that proxies Anthropic's native
 * `stop_reason` key through its OpenAI-compat choice object UNTRANSLATED:
 * `@langchain/openai`'s own `_generate()` (chat_models/completions.cjs, v1.2.7)
 * unconditionally copies `choices[0].finish_reason` into
 * `response_metadata.finish_reason` — but only that key; it never looks at
 * `choices[0].stop_reason`, so a Claude-native reason silently reaches
 * neither place except the raw envelope. That raw payload is only available
 * transiently: `stripRawResponseEnvelope` (`reasoning-trace/emit.ts`)
 * deletes it right after reasoning extraction, to keep checkpointer storage
 * and SSE payloads from bloating with the full wire response. So this one
 * diagnostic field has to be lifted out first, or truncation detection goes
 * permanently blind on that gateway path.
 *
 * Retention of the envelope itself is conditional on the model having been
 * constructed with `__includeRawResponse: true` (an @langchain/openai
 * constructor option) — verified empirically that without it, the converter
 * omits `additional_kwargs.__raw_response` entirely and this function has
 * nothing to read (issue #2781 follow-up: the Databricks branch of
 * `createProviderModel` did not set this flag).
 *
 * Reads `choices[0].finish_reason`, falling back to `choices[0].stop_reason`
 * on the same choice — the field lives on the choice itself in both the
 * non-streaming (`{ message, finish_reason }`) and streaming
 * (`{ delta, finish_reason }`) converter shapes, never nested under
 * `message`/`delta`.
 *
 * Mutates `response` in place; creates `response_metadata` if it doesn't
 * exist yet; never overwrites an existing `stop_reason`/`finish_reason`;
 * idempotent; fully defensive against malformed or missing shapes (never
 * throws).
 */
export function hoistRawStopReason(response: unknown): void {
	if (!response || typeof response !== "object") {
		return;
	}
	const ak = (response as { additional_kwargs?: unknown }).additional_kwargs;
	if (!ak || typeof ak !== "object") {
		return;
	}
	const raw = (ak as { __raw_response?: unknown }).__raw_response;
	if (!raw || typeof raw !== "object") {
		return;
	}
	const choices = (raw as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return;
	}
	const choice = choices[0];
	if (!choice || typeof choice !== "object") {
		return;
	}
	const value =
		(choice as { finish_reason?: unknown }).finish_reason ??
		(choice as { stop_reason?: unknown }).stop_reason;
	if (value === undefined || value === null) {
		return;
	}

	const existingMeta = (response as { response_metadata?: unknown })
		.response_metadata;
	if (existingMeta && typeof existingMeta === "object") {
		const meta = existingMeta as Record<string, unknown>;
		// Loose `!= null`, not `!== undefined`: an explicit `null` (a provider
		// that includes the keys but leaves them empty) is not an authoritative
		// value either — it must not block a real reason recovered from the raw
		// envelope any more than an absent key would.
		if (meta.stop_reason != null || meta.finish_reason != null) {
			return;
		}
		meta.finish_reason = value;
		return;
	}
	(response as { response_metadata?: unknown }).response_metadata = {
		finish_reason: value,
	};
}
