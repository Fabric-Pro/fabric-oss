/**
 * Databricks Model Serving / Unity AI Gateway compatibility shims (Vercel AI SDK
 * path — `@ai-sdk/openai`). The request-field strip + response normalization are
 * mirrored in `@repo/agent-core`'s databricks-compat.ts for the LangChain agent
 * path (which cannot import `@repo/ai`); keep the shared pieces in sync.
 *
 * Databricks' OpenAI-compatible endpoint diverges from the strict OpenAI schema
 * that `@ai-sdk/openai` assumes. We correct the divergences via a custom `fetch`
 * wired into `createOpenAI`, mirroring the Azure body-compat pattern in
 * `model-factory.ts` (`applyAzureChatBodyCompat`):
 *
 *  1. REQUEST body — see {@link applyDatabricksChatBodyCompat}:
 *     - Strip fields Databricks rejects outright: `stream_options`
 *       (`@ai-sdk/openai` sends `{include_usage:true}` when streaming →
 *       `400 BAD_REQUEST: json: unknown field "stream_options"`) and
 *       `parallel_tool_calls` (Databricks Claude: `Extra inputs are not
 *       permitted`).
 *     - Drop `temperature` — Databricks-served Claude (e.g. Claude Sonnet 5)
 *       rejects the sampling params with `400: does not support the temperature
 *       parameter`; callers such as the security scan pass `temperature: 0`.
 *     - Relax strict JSON-schema structured outputs
 *       (`response_format.json_schema.strict: true → false`). `@ai-sdk/openai`
 *       defaults `strict` to `true` for `generateObject`; strict mode requires
 *       every property in `required`, so the optional-heavy schemas used by the
 *       security scan / review / grouping / backlog analysis get a 400 (the same
 *       "Bug #1681" already fixed for Azure). The AI SDK still validates the
 *       result against the Zod schema. `max_tokens` is intentionally left
 *       untouched — Anthropic/Databricks require it (unlike Azure's o1/o3 rename).
 *
 *     The `temperature` and strict-`json_schema` transforms are Vercel-EXCLUSIVE:
 *     the agent path omits `temperature` at the `ChatOpenAI` constructor and does
 *     structured output via tool-calling (never `response_format.json_schema`), so
 *     they must NOT be copied into the agent-core shim. Only the request-field
 *     strip list (`DATABRICKS_UNSUPPORTED_REQUEST_FIELDS`) and the prompt-cache
 *     marker injection ({@link applyDatabricksPromptCacheMarkers}) are shared
 *     across both.
 *
 *  1b. REQUEST body — see {@link applyDatabricksPromptCacheMarkers}: inject
 *     Anthropic `cache_control` breakpoints so Databricks-served Claude actually
 *     caches the prompt prefix. Caching is opt-in per request; without markers the
 *     full prompt is re-billed on every turn.
 *
 *  2. RESPONSE — Claude services (Anthropic via Bedrock) return the streaming
 *     `delta.content` as an ARRAY of content blocks (including
 *     `{type:"reasoning", summary:[...]}`), not a string. `@ai-sdk/openai`'s
 *     schema expects `content` to be a string and throws `AI_TypeValidationError`
 *     ("expected string, received array"). We flatten the array to the
 *     concatenated text of its `type:"text"` blocks (reasoning blocks carry no
 *     user-facing text — the thinking is an opaque `signature` — so they are
 *     dropped).
 *
 *  3. RESPONSE (opt-in `stripReasoning`) — a DeepSeek-R1 endpoint served over
 *     Databricks returns its chain-of-thought as raw `<think>…</think>` tags in
 *     the string `content` (no native `reasoning_content`). Consumers that stream
 *     the content verbatim — the CopilotKit `OpenAIAdapter` and the LangChain
 *     agent path — would leak the reasoning into the answer, so they enable
 *     `{ stripReasoning }` to remove those spans (Bug #1942). The CALLER gates
 *     `stripReasoning` on the resolved *canonical* model identity
 *     ({@link isReasoningModelName}) — NOT the serving-endpoint alias — so a
 *     non-R1 model's literal `<think>` markup (e.g. Claude/Llama emitting it in
 *     code/docs) is preserved, and an R1 endpoint mapped to an opaque alias is
 *     still stripped. The `@ai-sdk` `getModel` path does NOT opt in — it extracts
 *     reasoning into a separate reasoning part via `extractReasoningMiddleware`.
 */

/**
 * Top-level request-body fields Databricks' OpenAI-compatible serving endpoints
 * reject with HTTP 400 but `@ai-sdk/openai` may emit. Kept in sync with the
 * agent-core copy's `DATABRICKS_UNSUPPORTED_REQUEST_FIELDS`:
 *  - `stream_options` — sent on every streaming request (`{include_usage:true}`).
 *  - `parallel_tool_calls` — Databricks Claude: "Extra inputs are not permitted".
 *    (`@ai-sdk/openai` only emits it when a caller sets
 *    `providerOptions.openai.parallelToolCalls`; stripped for parity + safety.)
 */
const DATABRICKS_UNSUPPORTED_REQUEST_FIELDS = [
	"stream_options",
	"parallel_tool_calls",
] as const;

/**
 * Apply the Databricks request-body compatibility transforms in place, mirroring
 * `applyAzureChatBodyCompat` (model-factory.ts). Returns true if `body` changed.
 * See the file header for the rationale behind each transform.
 */
export function applyDatabricksChatBodyCompat(
	body: Record<string, unknown>,
): boolean {
	let mutated = false;

	// Strip fields Databricks rejects outright.
	for (const field of DATABRICKS_UNSUPPORTED_REQUEST_FIELDS) {
		if (field in body) {
			delete body[field];
			mutated = true;
		}
	}

	// Databricks-served Claude rejects the temperature/top_p/top_k sampling params
	// (`400: ... does not support the temperature parameter`). Drop `temperature`
	// unconditionally — serving-endpoint names are user-defined aliases so the
	// model family isn't reliably detectable; the model uses its own default.
	if (body.temperature !== undefined) {
		delete body.temperature;
		mutated = true;
	}

	// Bug #1681: @ai-sdk/openai defaults strict JSON-schema structured outputs
	// (`response_format.json_schema.strict = true`); strict mode requires every
	// property to appear in `required`, so optional-heavy schemas (security scan,
	// review, grouping, backlog analysis) are rejected with a 400. Force
	// non-strict — the AI SDK still validates the result against the Zod schema.
	const responseFormat = body.response_format as
		| { type?: string; json_schema?: { strict?: boolean } }
		| undefined;
	if (
		responseFormat?.type === "json_schema" &&
		responseFormat.json_schema?.strict === true
	) {
		responseFormat.json_schema.strict = false;
		mutated = true;
	}

	return mutated;
}

// ---------------------------------------------------------------------------
// Anthropic prompt caching over the Databricks OpenAI-compatible surface.
// Mirrored verbatim in `@repo/agent-core`'s databricks-compat.ts — keep in sync.
// ---------------------------------------------------------------------------

/**
 * Anthropic's hard limit on cache breakpoints per request. Exceeding it is a 400,
 * so a body that already carries markers (a caller that hand-rolled its own)
 * reduces the budget we're willing to spend.
 */
const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;

/**
 * Breakpoints this shim will inject: one after the system block (caches
 * tools + system instructions) and one rolling breakpoint at the tail of the
 * conversation (caches the accumulated history). Deliberately well under
 * {@link MAX_ANTHROPIC_CACHE_BREAKPOINTS} so a caller adding its own markers
 * still fits.
 */
const MAX_INJECTED_CACHE_BREAKPOINTS = 2;

/** Env kill-switch: any truthy value disables prompt-cache marker injection. */
const PROMPT_CACHE_DISABLED_ENV = "DATABRICKS_PROMPT_CACHE_DISABLED";

/** True when {@link PROMPT_CACHE_DISABLED_ENV} is set to anything truthy. */
function isPromptCacheDisabled(): boolean {
	const raw = process.env[PROMPT_CACHE_DISABLED_ENV];
	if (raw === undefined) {
		return false;
	}
	const normalized = raw.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/** A fresh marker object per call — never share one across content blocks. */
function ephemeralCacheControl(): { type: "ephemeral" } {
	return { type: "ephemeral" };
}

/**
 * True for an OpenAI-shaped `{type:"text", text:"…"}` block carrying real text.
 * An empty text block is excluded: it is not a useful breakpoint, and some
 * backends reject an empty text block outright.
 */
function isTextContentBlock(block: unknown): boolean {
	return (
		!!block &&
		typeof block === "object" &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string" &&
		(block as { text: string }).text.length > 0
	);
}

/** True for an OpenAI-shaped `{type:"image_url", image_url:{…}}` block. */
function isImageContentBlock(block: unknown): boolean {
	return (
		!!block &&
		typeof block === "object" &&
		(block as { type?: unknown }).type === "image_url"
	);
}

/**
 * True for a content block Databricks accepts a `cache_control` marker on —
 * text AND image blocks (its docs list both, alongside `tool_calls` elements).
 *
 * Images matter for placement, not just permission: a breakpoint caches
 * everything BEFORE it, so marking the last *text* block of a
 * `[text, image_url]` turn would leave the image — by far the more expensive
 * half — outside the cached prefix. Marking the last cacheable block of any
 * kind keeps the whole message inside it.
 */
function isCacheableContentBlock(block: unknown): boolean {
	return isTextContentBlock(block) || isImageContentBlock(block);
}

/** True when a content block / tool_call already carries a cache breakpoint. */
function hasCacheControl(node: unknown): boolean {
	return (
		!!node &&
		typeof node === "object" &&
		(node as { cache_control?: unknown }).cache_control !== undefined
	);
}

/** Count cache breakpoints already present, so we never blow the limit of 4. */
function countExistingCacheBreakpoints(messages: unknown[]): number {
	let count = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object") {
			continue;
		}
		const content = (message as { content?: unknown }).content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (hasCacheControl(block)) {
					count++;
				}
			}
		}
		const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
		if (Array.isArray(toolCalls)) {
			for (const call of toolCalls) {
				if (hasCacheControl(call)) {
					count++;
				}
			}
		}
	}
	return count;
}

/**
 * Outcome of trying to place a breakpoint on one message:
 *  - `injected` — a marker was added (costs one breakpoint from the budget).
 *  - `already-marked` — this message is already a breakpoint; nothing to do, and
 *    the caller must STOP scanning (adding an earlier one would be redundant).
 *  - `unsupported` — nothing here can carry a marker (empty or null `content`
 *    and no `tool_calls`); keep scanning back.
 */
type CacheMarkOutcome = "injected" | "already-marked" | "unsupported";

/**
 * Place a `cache_control` breakpoint on a message, in place.
 *
 * A message with `tool_calls` gets the marker on its LAST call: Databricks
 * accepts `cache_control` on `tool_calls` elements, they translate to the
 * `tool_use` blocks that serialize AFTER the content blocks of the turn — so a
 * marker there caches the whole message, content included — and on the
 * tool-calling turns of an agent loop (`content: null` or `""` alongside
 * `tool_calls`) it is the only place a marker can go at all. Without it the
 * rolling breakpoint could never advance past the loop's first user turn, and
 * the cached prefix stayed pinned at its first-turn size while the accumulated
 * tool-result history was re-billed at the full input rate on every request.
 *
 * Otherwise a string `content` is widened to a single-element text-block array
 * (the only shape that can carry the marker), and an array `content` gets the
 * marker on its LAST *cacheable* block — text or image, whichever comes last —
 * so the breakpoint sits at the very end of that message and the whole turn
 * falls inside the cached prefix.
 */
function markMessageForCaching(
	message: Record<string, unknown>,
): CacheMarkOutcome {
	const toolCalls = message.tool_calls;
	if (Array.isArray(toolCalls) && toolCalls.length > 0) {
		const lastCall = toolCalls[toolCalls.length - 1];
		if (lastCall && typeof lastCall === "object") {
			if (hasCacheControl(lastCall)) {
				return "already-marked";
			}
			(lastCall as Record<string, unknown>).cache_control =
				ephemeralCacheControl();
			return "injected";
		}
	}
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return "unsupported";
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: ephemeralCacheControl(),
			},
		];
		return "injected";
	}
	if (Array.isArray(content)) {
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i];
			if (!isCacheableContentBlock(block)) {
				continue;
			}
			if (hasCacheControl(block)) {
				return "already-marked";
			}
			(block as Record<string, unknown>).cache_control =
				ephemeralCacheControl();
			return "injected";
		}
	}
	return "unsupported";
}

/**
 * Inject Anthropic prompt-cache breakpoints into a Databricks chat-completions
 * body, in place. Returns true if `body` changed.
 *
 * WHY: Databricks-served Claude supports Anthropic prompt caching through the
 * OpenAI-compatible surface — you attach `cache_control: {"type":"ephemeral"}` to
 * a content block and everything BEFORE it (tools, system, prior turns) is cached
 * on a prefix match. It is opt-in: with no marker on the wire nothing is cached
 * and the entire prompt is re-billed every turn. The AI SDK / LangChain OpenAI
 * providers have no notion of Anthropic cache markers — `providerOptions.anthropic
 * .cacheControl` is dropped during OpenAI-shaped serialization — so the only place
 * the marker can reach the wire on this path is the body-rewrite layer, here.
 *
 * WHAT it places (at most {@link MAX_INJECTED_CACHE_BREAKPOINTS}):
 *  1. On the last message of the leading `system` run — caches tools + the system
 *     prompt, the largest stable prefix in almost every call this repo makes.
 *  2. A rolling breakpoint on the last cacheable conversation turn — each request
 *     extends the cached prefix, so multi-turn agent loops read the previous
 *     turn's cache instead of re-billing the whole history. Earlier breakpoints
 *     keep working as read points (Anthropic matches the longest cached prefix).
 *
 * Each marker goes on the LAST block of the target message that can hold one —
 * text or image alike — so a `[text, image_url]` turn is cached in full rather
 * than up to its text.
 *
 * GATING: only bodies whose `model` mentions "claude". Databricks validates
 * request bodies strictly (`parallel_tool_calls` → "Extra inputs are not
 * permitted"), so an unrecognized field on a non-Claude endpoint would 400. The
 * `model` field is the serving-ENDPOINT name, which for custom endpoints is a
 * user-defined alias that need not name the backing family — the same limitation
 * documented on {@link isReasoningModelName}. A Claude endpoint aliased without
 * "claude" in its name therefore just doesn't get caching; that is the safe
 * failure direction (a missed saving, never a rejected request), and the
 * pre-provisioned `databricks-claude-*` endpoints this repo actually targets do
 * match.
 *
 * KILL-SWITCH: set {@link PROMPT_CACHE_DISABLED_ENV}
 * (`DATABRICKS_PROMPT_CACHE_DISABLED`) to any truthy value to stop injecting —
 * no redeploy of the model config needed if a serving endpoint ever rejects the
 * field. Anything malformed passes through untouched.
 */
export function applyDatabricksPromptCacheMarkers(
	body: Record<string, unknown>,
): boolean {
	try {
		if (isPromptCacheDisabled()) {
			return false;
		}
		const model = body.model;
		if (typeof model !== "string" || !/claude/i.test(model)) {
			return false;
		}
		const messages = body.messages;
		if (!Array.isArray(messages) || messages.length === 0) {
			return false;
		}

		let budget = Math.min(
			MAX_INJECTED_CACHE_BREAKPOINTS,
			MAX_ANTHROPIC_CACHE_BREAKPOINTS -
				countExistingCacheBreakpoints(messages),
		);
		if (budget <= 0) {
			return false;
		}

		let mutated = false;

		// (1) End of the leading `system` run. Anthropic requires system content
		// first, so this is located positionally by role rather than by index.
		let lastSystemIndex = -1;
		for (const message of messages) {
			if (
				!message ||
				typeof message !== "object" ||
				(message as { role?: unknown }).role !== "system"
			) {
				break;
			}
			lastSystemIndex++;
		}
		if (lastSystemIndex >= 0) {
			const outcome = markMessageForCaching(
				messages[lastSystemIndex] as Record<string, unknown>,
			);
			if (outcome === "injected") {
				mutated = true;
				budget--;
			}
		}

		// (2) Rolling breakpoint: walk back from the tail to the last turn that can
		// hold a marker. `role:"tool"` results are stepped past rather than marked —
		// Databricks documents `cache_control` on text blocks, image blocks and
		// `tool_calls` elements, not on tool messages — so in an agent loop the
		// marker lands on the latest assistant tool-calling turn and each new
		// request extends the cached prefix past the previous turn's results.
		if (budget > 0) {
			for (let i = messages.length - 1; i > lastSystemIndex; i--) {
				const message = messages[i];
				if (!message || typeof message !== "object") {
					continue;
				}
				const role = (message as { role?: unknown }).role;
				if (role !== "user" && role !== "assistant") {
					continue;
				}
				const outcome = markMessageForCaching(
					message as Record<string, unknown>,
				);
				if (outcome === "injected") {
					mutated = true;
					break;
				}
				if (outcome === "already-marked") {
					break;
				}
			}
		}

		return mutated;
	} catch {
		// Never let a surprising body shape cost us the request — the other compat
		// transforms have already run and their result must still go out.
		return false;
	}
}

/**
 * Apply {@link applyDatabricksChatBodyCompat} and
 * {@link applyDatabricksPromptCacheMarkers} to a raw request-body string.
 * Returns the (possibly rewritten) body string; input is returned unchanged when
 * it isn't JSON or nothing needed rewriting. This is the entrypoint used by
 * `createDatabricksFetch`.
 */
export function stripUnsupportedRequestFields(bodyText: string): string {
	try {
		const body = JSON.parse(bodyText) as Record<string, unknown>;
		let mutated = applyDatabricksChatBodyCompat(body);
		if (applyDatabricksPromptCacheMarkers(body)) {
			mutated = true;
		}
		return mutated ? JSON.stringify(body) : bodyText;
	} catch {
		return bodyText;
	}
}

/** Concatenate the text of `type:"text"` blocks; drop reasoning/other blocks. */
export function extractTextFromContentBlocks(blocks: unknown[]): string {
	let out = "";
	for (const block of blocks) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			out += (block as { text: string }).text;
		}
	}
	return out;
}

/**
 * Normalize a chat-completions chunk (streaming) or full response (non-streaming)
 * in place: any `choices[].delta.content` or `choices[].message.content` that is
 * an array is flattened to a text string. Returns true if anything was mutated.
 */
export function normalizeContentArrays(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") {
		return false;
	}
	const choices = (payload as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) {
		return false;
	}
	let mutated = false;
	for (const choice of choices) {
		if (!choice || typeof choice !== "object") {
			continue;
		}
		for (const key of ["delta", "message"] as const) {
			const node = (choice as Record<string, unknown>)[key];
			if (
				node &&
				typeof node === "object" &&
				Array.isArray((node as { content?: unknown }).content)
			) {
				(node as { content: unknown }).content =
					extractTextFromContentBlocks(
						(node as { content: unknown[] }).content,
					);
				mutated = true;
			}
		}
	}
	return mutated;
}

/**
 * Databricks' Foundation Model API serves Claude through the OpenAI-compatible
 * chat-completions surface, but reports Anthropic-style prompt-cache usage in
 * TOP-LEVEL fields (`cache_read_input_tokens`, `cache_creation_input_tokens`,
 * `cache_creation`) instead of the OpenAI shape — `usage.prompt_tokens_details
 * .cached_tokens` — that `@ai-sdk/openai`'s `convertOpenAIChatUsage` and
 * `@langchain/openai`'s completions parser both read. Cache-READ savings were
 * therefore invisible in AI usage logging: the OpenAI-shaped parsers never look
 * at the Anthropic-named fields, so a cached call billed and displayed
 * identically to an uncached one.
 *
 * Maps `usage.cache_read_input_tokens` onto `usage.prompt_tokens_details
 * .cached_tokens` in place, when present. This needs no adjustment to
 * `prompt_tokens` itself — Databricks' `prompt_tokens` already counts the
 * cached portion, matching OpenAI's own `prompt_tokens_details.cached_tokens`
 * semantics (a subset of `prompt_tokens`, not additional to it).
 *
 * Leaves the Anthropic-style fields on the (non-streaming, or choices-less
 * streaming usage event — see {@link applyChunkCacheUsageHandling}) usage
 * object untouched. Cache-WRITE tokens (`cache_creation_input_tokens`) have
 * no OpenAI-shape equivalent, so
 * they can only ever be read from those Anthropic-named fields directly —
 * and that is possible on ONE of the two consumer paths, not both:
 *  - `@repo/agent-core`'s `usage-logging.ts` (the LangChain/agent path) reads
 *    it, because `@langchain/openai`'s completions parser spreads the raw
 *    wire `usage` object verbatim onto `response_metadata.usage`, so the
 *    Anthropic-named field survives to that extractor unmapped.
 *  - `@repo/ai`'s `usage-logging-middleware.ts` (the `@ai-sdk/openai` path)
 *    CANNOT read it. `@ai-sdk/openai@3.0.0` validates every response and
 *    chunk against a CLOSED `z.object` schema (`dist/internal/index.mjs`,
 *    the `usage` sub-schema) listing only OpenAI-named fields; Zod strips
 *    unknown keys on a plain (non-`.passthrough()`) object by default, so
 *    `cache_creation_input_tokens` is gone from `usage` before
 *    `convertOpenAIChatUsage` — and its `raw: usage` passthrough — ever see
 *    it. There is no recognized OpenAI usage field free to smuggle it
 *    through either (repurposing e.g. `completion_tokens_details
 *    .accepted_prediction_tokens` would corrupt an unrelated, real metric).
 *    Cache-WRITE visibility for Databricks-served Claude is therefore
 *    LangChain-path-only; an `@ai-sdk/openai` caller sees a cache-write call
 *    exactly like an ordinary uncached one.
 *
 * Never fabricates the `cached_tokens` field on a cache miss
 * (`cache_read_input_tokens` absent, zero, or non-numeric) — a miss must read
 * exactly like any other provider's non-cached usage, not synthesize a zero
 * `cached_tokens`. Never overwrites an existing numeric `cached_tokens`
 * (future-proofing; Databricks does not send one today).
 *
 * No model/Claude gating and no env kill-switch: this only reads a response
 * field already on the wire and adds an OpenAI-shaped alias for it, so a
 * non-Claude response without the field is simply a no-op.
 *
 * STREAMING CALLERS: do not call this directly on every SSE chunk — see
 * {@link applyChunkCacheUsageHandling} / {@link buildSynthesizedUsageEvent},
 * which `createDatabricksSseTransform` uses to route only choices-less usage
 * events (native or synthesized) through this function.
 *
 * Mirrored verbatim in `@repo/agent-core`'s databricks-compat.ts — keep in sync.
 */
export function normalizeDatabricksUsageFields(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") {
		return false;
	}
	const usage = (payload as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
		return false;
	}
	const usageObj = usage as Record<string, unknown>;
	const cacheRead = usageObj.cache_read_input_tokens;
	if (
		typeof cacheRead !== "number" ||
		!Number.isFinite(cacheRead) ||
		cacheRead <= 0
	) {
		return false;
	}
	const existing = usageObj.prompt_tokens_details;
	const existingDetails =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? (existing as Record<string, unknown>)
			: undefined;
	if (typeof existingDetails?.cached_tokens === "number") {
		return false;
	}
	usageObj.prompt_tokens_details = {
		...existingDetails,
		cached_tokens: cacheRead,
	};
	return true;
}

/**
 * Deep-clone a `usage` object so a later in-place mutation (stripping the
 * Anthropic fields off a content chunk, or mapping them on a usage-only
 * event) can never corrupt a retained last-write-wins snapshot taken from it.
 */
function cloneUsage(usage: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(usage);
}

/**
 * True when at least one of the three Anthropic-style cache keys is PRESENT
 * on `usage` — regardless of value, including an explicit `0`. A Databricks
 * response for a non-Claude model (or a Claude call where caching truly
 * never applies) never carries these keys at all, so this is the gate that
 * keeps a non-caching stream byte-identical to its pre-normalization shape:
 * see {@link buildSynthesizedUsageEvent}.
 */
function hasAnthropicCacheKeys(usage: Record<string, unknown>): boolean {
	return (
		"cache_read_input_tokens" in usage ||
		"cache_creation_input_tokens" in usage ||
		"cache_creation" in usage
	);
}

/**
 * Delete the three Anthropic-style cache-usage fields from a CHOICES-BEARING
 * SSE chunk's `usage` object, in place, when present. Deletes whenever a key
 * is PRESENT, regardless of its value — a cache-write-only call
 * (`cache_read_input_tokens: 0`, `cache_creation_input_tokens: <nonzero>`) is
 * exactly the case that would otherwise multiply (see
 * {@link applyChunkCacheUsageHandling} for why every choices-bearing chunk,
 * not just non-final ones, must be stripped). Returns true if anything was
 * deleted. Never injects `prompt_tokens_details` here — that only happens on
 * a choices-LESS usage event, via {@link normalizeDatabricksUsageFields}.
 */
function suppressCacheUsageFields(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") {
		return false;
	}
	const usage = (payload as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
		return false;
	}
	const usageObj = usage as Record<string, unknown>;
	let mutated = false;
	for (const key of [
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
		"cache_creation",
	] as const) {
		if (key in usageObj) {
			delete usageObj[key];
			mutated = true;
		}
	}
	return mutated;
}

/** Outcome of {@link applyChunkCacheUsageHandling} for one parsed SSE chunk. */
type ChunkUsageHandling = {
	/** Whether the chunk's JSON was mutated (so it must be re-serialized). */
	mutated: boolean;
	/**
	 * Deep copy of this chunk's `usage` object, taken BEFORE any stripping or
	 * mapping — undefined when the chunk had no usage object at all.
	 */
	usageSnapshot?: Record<string, unknown>;
	/**
	 * This chunk's envelope — every field except `choices` and `usage` — paired
	 * with `usageSnapshot` above, undefined under the same condition.
	 */
	usageEnvelope?: Record<string, unknown>;
	/**
	 * True when this chunk is choices-less (`choices` absent or empty) AND
	 * carried a `usage` object: a REAL trailing usage-only event the gateway
	 * sent on its own, as opposed to one this transform has to synthesize.
	 */
	isNativeUsageOnlyChunk: boolean;
};

/**
 * Classify and handle cache-usage fields for ONE parsed SSE data chunk, per
 * the two-shape contract Databricks-style OpenAI-compatible gateways use:
 *
 *  - CHOICES-BEARING chunks (`choices` is a non-empty array) carry the
 *    running `usage` object on every content delta — Databricks does this on
 *    EVERY chunk, not just the one carrying `finish_reason`. The three
 *    Anthropic-named cache keys are stripped from EVERY such chunk,
 *    regardless of `finish_reason`. This is stricter than "only non-final
 *    chunks": `@langchain/openai`'s streaming loop converts the
 *    finish-bearing content chunk into an `AIMessageChunk` whose
 *    `response_metadata.usage` carries the cache fields, AND — separately —
 *    emits its OWN trailing usage-only chunk built from the same last-seen
 *    `data.usage` after the loop ends. If the finish-bearing chunk were left
 *    unstripped, `@langchain/core`'s additive chunk `.concat()` (`_mergeDicts`,
 *    which SUMS colliding numeric fields — only `index`/`created`/`timestamp`
 *    are excluded) would sum that content chunk's copy against the trailing
 *    synthetic chunk's copy: exactly 2× on `cache_creation_input_tokens` /
 *    `cache_read_input_tokens`, worse with multiple staggered
 *    `finish_reason`s in a multi-choice response. `prompt_tokens_details` is
 *    never injected on a choices-bearing chunk either.
 *  - CHOICES-LESS chunks (`choices` absent or empty — the OpenAI-style
 *    trailing usage-only event some gateways send) keep the Anthropic fields
 *    and get the `cached_tokens` OpenAI-shape mapping via
 *    {@link normalizeDatabricksUsageFields}. `@langchain/openai`'s streaming
 *    loop skips a choices-less chunk as a content delta (`if (!choice)
 *    continue`) — it contributes NO `response_metadata` of its own — so the
 *    cache fields living here are read exactly once, by the loop's own
 *    post-loop synthetic usage chunk (built from this same `usage` object).
 *
 * Every chunk that carries a `usage` object (of either shape) updates the
 * `usageSnapshot`/`usageEnvelope` the caller tracks as a last-write-wins pair,
 * used to synthesize a trailing usage-only event when Databricks doesn't send
 * one natively — see {@link buildSynthesizedUsageEvent}.
 */
function applyChunkCacheUsageHandling(
	payload: Record<string, unknown>,
): ChunkUsageHandling {
	const usage = payload.usage;
	const isUsageObject =
		!!usage && typeof usage === "object" && !Array.isArray(usage);
	const choices = payload.choices;
	const isChoicesBearing = Array.isArray(choices) && choices.length > 0;

	let usageSnapshot: Record<string, unknown> | undefined;
	let usageEnvelope: Record<string, unknown> | undefined;
	if (isUsageObject) {
		usageSnapshot = cloneUsage(usage as Record<string, unknown>);
		const { usage: _usage, choices: _choices, ...envelope } = payload;
		usageEnvelope = envelope;
	}

	if (isChoicesBearing) {
		return {
			mutated: suppressCacheUsageFields(payload),
			usageSnapshot,
			usageEnvelope,
			isNativeUsageOnlyChunk: false,
		};
	}
	if (isUsageObject) {
		return {
			mutated: normalizeDatabricksUsageFields(payload),
			usageSnapshot,
			usageEnvelope,
			isNativeUsageOnlyChunk: true,
		};
	}
	return { mutated: false, isNativeUsageOnlyChunk: false };
}

/**
 * Build the synthesized trailing usage-only SSE event Databricks doesn't send
 * on its own — usage rides only on content chunks today, per the file header
 * — modeled on the OpenAI-style choices-less usage chunk some gateways DO
 * send natively (`{"choices":[], "usage":{...}}`). Returns `""` when there is
 * nothing to synthesize:
 *  - no chunk on this stream ever carried a `usage` object at all (`envelope`/
 *    `usageSnapshot` null), or
 *  - the retained usage has NONE of the three Anthropic cache keys (see
 *    {@link hasAnthropicCacheKeys}) — a non-Claude endpoint, or a Claude
 *    stream with caching disabled, must produce byte-identical output to
 *    before this feature existed, not grow an extra trailing event.
 *
 * The caller is responsible for the other synthesis gate: skip this call
 * entirely when a REAL choices-less usage chunk was already seen on the
 * stream ({@link ChunkUsageHandling.isNativeUsageOnlyChunk}) — that chunk is
 * authoritative and nothing should be synthesized alongside it.
 */
function buildSynthesizedUsageEvent(
	envelope: Record<string, unknown> | null,
	usageSnapshot: Record<string, unknown> | null,
): string {
	if (!envelope || !usageSnapshot || !hasAnthropicCacheKeys(usageSnapshot)) {
		return "";
	}
	const event: Record<string, unknown> = {
		...envelope,
		choices: [],
		usage: cloneUsage(usageSnapshot),
	};
	normalizeDatabricksUsageFields(event);
	return `data: ${JSON.stringify(event)}\n\n`;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * DeepSeek-R1-architecture model-name patterns (mirrors `REASONING_MODEL_PATTERNS`
 * in `model-factory.ts`). Only these models emit `<think>` reasoning tags, so
 * reasoning stripping is gated to them: a non-R1 model (Claude, Llama) may
 * legitimately output literal `<think>` markup (e.g. in code or docs), which must
 * be preserved, not silently removed.
 */
const REASONING_MODEL_PATTERNS = [
	"deepseek-r1",
	"deepseek-reasoner",
	"r1-distill",
];

/**
 * True when a model name denotes a DeepSeek-R1-architecture model whose
 * `<think>` reasoning tags should be stripped/extracted.
 *
 * IMPORTANT: pass the resolved *canonical* model name, NOT a Databricks serving-
 * endpoint alias. Per-workspace endpoints have arbitrary names (e.g. `prod-chat`)
 * that reveal nothing about the backend family — sniffing the alias would miss an
 * R1 endpoint mapped to an opaque alias (Bug #1942 review). The caller resolves
 * the canonical identity and passes the result as `createDatabricksFetch`'s
 * `stripReasoning` flag / `getModel`'s `isReasoningModel` context.
 */
export function isReasoningModelName(
	model: string | null | undefined,
): boolean {
	if (!model) {
		return false;
	}
	const lower = model.toLowerCase();
	return REASONING_MODEL_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Longest suffix of `text` that is a non-empty proper prefix of `tag`. */
function partialTagTail(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let n = max; n > 0; n--) {
		if (tag.startsWith(text.slice(text.length - n))) {
			return n;
		}
	}
	return 0;
}

/**
 * Stateful `<think>…</think>` remover for a *streaming* content channel. Feed it
 * the ordered `delta.content` fragments; it returns the visible (non-reasoning)
 * text to emit for each, suppressing everything from `<think>` to `</think>`
 * (inclusive). Tags split across fragment boundaries are handled by holding back
 * a partial-tag tail until the next fragment (or `flush()`).
 *
 * DeepSeek-R1 served over Databricks' OpenAI-compatible surface returns its
 * chain-of-thought as raw `<think>` tags in `delta.content` (no native
 * `reasoning_content`). Consumers that stream this content verbatim — the
 * CopilotKit `OpenAIAdapter` and the LangChain agent path — would otherwise leak
 * the raw reasoning into the answer (Bug #1942). The `@ai-sdk` `getModel` path
 * handles this via `extractReasoningMiddleware` instead, so it does NOT enable
 * this stripper.
 */
export interface ReasoningStripper {
	/** Visible (non-reasoning) text to emit for this content fragment. */
	push(fragment: string): string;
	/** Residual held text to emit at end-of-stream (empty while mid-reasoning). */
	flush(): string;
}

export function createReasoningStripper(): ReasoningStripper {
	let inside = false;
	let carry = "";
	return {
		push(fragment: string): string {
			let text = carry + fragment;
			carry = "";
			let out = "";
			for (;;) {
				if (!inside) {
					const i = text.indexOf(THINK_OPEN);
					if (i !== -1) {
						out += text.slice(0, i);
						text = text.slice(i + THINK_OPEN.length);
						inside = true;
						continue;
					}
					const tail = partialTagTail(text, THINK_OPEN);
					out += text.slice(0, text.length - tail);
					carry = text.slice(text.length - tail);
					return out;
				}
				const j = text.indexOf(THINK_CLOSE);
				if (j !== -1) {
					text = text.slice(j + THINK_CLOSE.length);
					inside = false;
					continue;
				}
				carry = text.slice(
					text.length - partialTagTail(text, THINK_CLOSE),
				);
				return out;
			}
		},
		flush(): string {
			// A residual carry is visible content only when we're NOT mid-reasoning
			// (a held partial `<think>` prefix that never completed = literal text).
			const out = inside ? "" : carry;
			carry = "";
			inside = false;
			return out;
		},
	};
}

/** Apply a {@link ReasoningStripper} to every string `delta.content` in a chunk. */
function applyReasoningStripperToChunk(
	payload: unknown,
	stripper: ReasoningStripper,
): boolean {
	const choices = (payload as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) {
		return false;
	}
	let mutated = false;
	for (const choice of choices) {
		const delta = (choice as { delta?: unknown })?.delta;
		if (
			delta &&
			typeof delta === "object" &&
			typeof (delta as { content?: unknown }).content === "string"
		) {
			const original = (delta as { content: string }).content;
			const stripped = stripper.push(original);
			if (stripped !== original) {
				(delta as { content: string }).content = stripped;
				mutated = true;
			}
		}
	}
	return mutated;
}

/**
 * Strip complete `<think>…</think>` spans from string `message.content`
 * (non-streaming responses). Returns true if anything was rewritten.
 */
export function stripReasoningFromMessages(payload: unknown): boolean {
	const choices = (payload as { choices?: unknown }).choices;
	if (!Array.isArray(choices)) {
		return false;
	}
	let mutated = false;
	for (const choice of choices) {
		const message = (choice as { message?: unknown })?.message;
		if (
			message &&
			typeof message === "object" &&
			typeof (message as { content?: unknown }).content === "string"
		) {
			const original = (message as { content: string }).content;
			// Remove complete spans, then drop a trailing unterminated `<think>`
			// (a truncated R1 response) so non-streaming matches the streaming
			// stripper, which suppresses everything after an unclosed `<think>`.
			const stripped = original
				.replace(/<think>[\s\S]*?<\/think>/g, "")
				.replace(/<think>[\s\S]*$/, "");
			if (stripped !== original) {
				(message as { content: string }).content = stripped;
				mutated = true;
			}
		}
	}
	return mutated;
}

/**
 * A TransformStream that rewrites Databricks SSE chat chunks so `delta.content`
 * arrays become plain strings. Buffers across chunk boundaries so multi-read SSE
 * events are handled correctly. When `stripReasoning` is set, it also removes
 * `<think>…</think>` reasoning spans from string `delta.content` (see
 * {@link createReasoningStripper}).
 *
 * Also normalizes Databricks' prompt-cache usage fields for streaming
 * responses — see {@link applyChunkCacheUsageHandling} for the per-chunk
 * classification and {@link buildSynthesizedUsageEvent} for the trailing
 * usage-only event this synthesizes right before `[DONE]` when Databricks
 * never sends one natively. DELIBERATE DEGRADATION: if the underlying stream
 * ends WITHOUT a `[DONE]` line (aborted mid-stream, or an upstream error), no
 * event is synthesized — an aborted stream has no authoritative final usage
 * to report, and its consumer is already on an error path rather than reading
 * usage off a clean finish.
 */
export function createDatabricksSseTransform(
	stripReasoning = false,
): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	const stripper = stripReasoning ? createReasoningStripper() : null;
	// Envelope (chunk minus `choices` AND `usage`) of the last data chunk seen,
	// so a flushed residual reasoning-strip tail can be re-emitted as a
	// well-formed chunk. `usage` is deliberately excluded: a chunk with an
	// array `choices` can still carry a `usage` object (a hypothetical future
	// native `choices: []` usage-only event, or any choices-bearing chunk before
	// its cache fields are stripped) — spreading that into a flushed residual
	// CONTENT chunk would put cache usage on two chunks at once, reopening the
	// double-count `applyChunkCacheUsageHandling` exists to prevent. The
	// flushed chunk is text-only and needs neither.
	let lastEnvelope: Record<string, unknown> | null = null;

	// Last-write-wins pair for the trailing usage-only event synthesis: the
	// most recent chunk-level `usage` (deep-copied BEFORE stripping/mapping)
	// and the envelope of the chunk it came from. By the time `[DONE]` arrives
	// this holds the final chunk's complete usage, since Databricks sends it
	// on every content chunk.
	let lastUsageSnapshot: Record<string, unknown> | null = null;
	let lastUsageEnvelope: Record<string, unknown> | null = null;
	// True once a REAL choices-less usage chunk has been seen on this stream.
	// Databricks doesn't send one today, but if it (or a future gateway) ever
	// does, that native chunk is authoritative and nothing is synthesized.
	let sawNativeUsageOnlyChunk = false;

	const transformDataLine = (line: string): string => {
		if (!line.startsWith("data:")) {
			return line;
		}
		const data = line.slice(5).trim();
		if (data === "" || data === "[DONE]") {
			return line;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return line; // Not JSON — leave untouched.
		}
		let mutated = normalizeContentArrays(parsed);
		if (parsed && typeof parsed === "object") {
			const usageHandling = applyChunkCacheUsageHandling(
				parsed as Record<string, unknown>,
			);
			if (usageHandling.mutated) {
				mutated = true;
			}
			if (usageHandling.usageSnapshot && usageHandling.usageEnvelope) {
				lastUsageSnapshot = usageHandling.usageSnapshot;
				lastUsageEnvelope = usageHandling.usageEnvelope;
			}
			if (usageHandling.isNativeUsageOnlyChunk) {
				sawNativeUsageOnlyChunk = true;
			}
		}
		if (stripper && parsed && typeof parsed === "object") {
			if (Array.isArray((parsed as { choices?: unknown }).choices)) {
				const {
					choices: _choices,
					usage: _usage,
					...envelope
				} = parsed as Record<string, unknown>;
				lastEnvelope = envelope;
			}
			if (applyReasoningStripperToChunk(parsed, stripper)) {
				mutated = true;
			}
		}
		return mutated ? `data: ${JSON.stringify(parsed)}` : line;
	};

	// Emit any held reasoning-strip tail as a well-formed chunk. Returns "" when
	// there's nothing held (or no envelope to model the chunk on).
	const flushEvent = (): string => {
		if (!stripper) {
			return "";
		}
		const residual = stripper.flush();
		if (!residual || !lastEnvelope) {
			return "";
		}
		const chunk = {
			...lastEnvelope,
			choices: [
				{ index: 0, delta: { content: residual }, finish_reason: null },
			],
		};
		return `data: ${JSON.stringify(chunk)}\n\n`;
	};

	const processEvent = (rawEvent: string): string => {
		const lines = rawEvent.split("\n");
		const isDone = lines.some(
			(l) => l.startsWith("data:") && l.slice(5).trim() === "[DONE]",
		);
		const body = lines.map(transformDataLine).join("\n");
		if (!isDone) {
			return body;
		}
		// [DONE] arrived: flush any held reasoning-strip tail, then synthesize
		// the trailing usage-only event (unless a native one already carried the
		// cache fields), both landing in-order before the terminating [DONE].
		const synthesizedUsage = sawNativeUsageOnlyChunk
			? ""
			: buildSynthesizedUsageEvent(lastUsageEnvelope, lastUsageSnapshot);
		return flushEvent() + synthesizedUsage + body;
	};

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			// Normalize CRLF -> LF so event-boundary detection ("\n\n") works
			// whether the gateway terminates SSE lines with LF or CRLF. Applied to
			// the whole buffer so a "\r\n" split across chunk boundaries still
			// collapses correctly (a lone trailing "\r" waits for its "\n").
			buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
				/\r\n/g,
				"\n",
			);
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const rawEvent = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				controller.enqueue(
					encoder.encode(`${processEvent(rawEvent)}\n\n`),
				);
				sep = buffer.indexOf("\n\n");
			}
		},
		flush(controller) {
			const parts: string[] = [];
			if (buffer.length > 0) {
				parts.push(processEvent(buffer));
			}
			// Stream ended without a [DONE] event — flush any residual here.
			// (A [DONE] already consumed the stripper, so this is then a no-op.)
			const residual = flushEvent();
			if (residual) {
				parts.push(residual);
			}
			if (parts.length > 0) {
				// Join with an event boundary so a flushed residual chunk never
				// glues onto the final buffered event's `data:` line (which
				// `processEvent` returns without a trailing separator).
				controller.enqueue(encoder.encode(parts.join("\n\n")));
			}
		},
	});
}

/** Response headers minus ones invalidated by rewriting the (decoded) body. */
function rewrittenHeaders(headers: Headers): Headers {
	const out = new Headers(headers);
	out.delete("content-encoding");
	out.delete("content-length");
	return out;
}

/**
 * Databricks nests the human-readable reason as a JSON *string* inside
 * `message`, e.g. `"{\"message\":\"messages.2.content...\"}"`. Unwrap one level
 * so the reason reads as prose; anything that isn't that shape passes through.
 */
function unwrapNestedMessage(message: string): string {
	const trimmed = message.trim();
	if (!trimmed.startsWith("{")) {
		return message;
	}
	try {
		const inner = JSON.parse(trimmed) as { message?: unknown };
		return typeof inner.message === "string" ? inner.message : message;
	} catch {
		return message;
	}
}

/**
 * Rewrite a Databricks error envelope into the OpenAI shape its own SDK reads.
 *
 * Databricks reports request-schema failures as `{error_code, message}`. Both
 * `openai` and `@ai-sdk/openai` look for a top-level `error` key, find nothing,
 * and raise `400 status code (no body)` — discarding a field-level explanation
 * the gateway *did* send. That is why an oversized-history / malformed-content
 * 400 read as opaque for weeks: the wire carried
 *
 *   {"error_code":"BAD_REQUEST","message":"{\"message\":\"messages.2.content.0
 *    .tool_result.content.1: Input tag 'image_url' ... \"}"}
 *
 * while the agent logged only "400 status code (no body)".
 *
 * Returns the rewritten JSON, or `null` when the body is already OpenAI-shaped,
 * is not JSON, or carries neither field (leave it exactly as it arrived).
 */
export function normalizeDatabricksErrorEnvelope(
	bodyText: string,
): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const body = parsed as Record<string, unknown>;
	// Already OpenAI-shaped — the SDK will read it correctly.
	if (body.error !== undefined) {
		return null;
	}
	const code = typeof body.error_code === "string" ? body.error_code : null;
	const rawMessage = typeof body.message === "string" ? body.message : null;
	if (code === null && rawMessage === null) {
		return null;
	}
	return JSON.stringify({
		...body,
		error: {
			message: rawMessage
				? unwrapNestedMessage(rawMessage)
				: (code ?? "Unknown Databricks error"),
			...(code ? { code } : {}),
			type: "databricks_error",
		},
	});
}

/**
 * Buffer a non-2xx response and, when it carries a Databricks error envelope,
 * hand back an OpenAI-shaped one. The body is buffered either way — once
 * `.text()` has run the original is spent, so the untouched text is re-wrapped
 * rather than returning a consumed Response ("Body is unusable").
 */
async function normalizeDatabricksErrorResponse(
	response: Response,
): Promise<Response> {
	if (!response.body) {
		return response;
	}
	if (!(response.headers.get("content-type") ?? "").includes("json")) {
		return response;
	}
	const text = await response.text();
	return new Response(normalizeDatabricksErrorEnvelope(text) ?? text, {
		status: response.status,
		statusText: response.statusText,
		headers: rewrittenHeaders(response.headers),
	});
}

/**
 * A `fetch` wrapper for Databricks serving endpoints: strips unsupported request
 * fields and normalizes streaming/non-streaming content arrays in the response.
 */
export function createDatabricksFetch(
	baseFetch: typeof fetch = fetch,
	options: { stripReasoning?: boolean } = {},
): typeof fetch {
	const stripReasoning = options.stripReasoning ?? false;
	return async (input, init) => {
		let patchedInit = init;
		if (init?.body && typeof init.body === "string") {
			const newBody = stripUnsupportedRequestFields(init.body);
			if (newBody !== init.body) {
				patchedInit = { ...init, body: newBody };
			}
		}

		const response = await baseFetch(input, patchedInit);
		// Surface the gateway's own explanation before the SDK can discard it.
		if (!response.ok) {
			return await normalizeDatabricksErrorResponse(response);
		}
		if (!response.body) {
			return response;
		}

		const contentType = response.headers.get("content-type") ?? "";

		if (contentType.includes("text/event-stream")) {
			return new Response(
				response.body.pipeThrough(
					createDatabricksSseTransform(stripReasoning),
				),
				{
					status: response.status,
					statusText: response.statusText,
					headers: rewrittenHeaders(response.headers),
				},
			);
		}

		// Non-streaming JSON: flatten message.content arrays if present.
		// Buffer the body as TEXT first, then parse — so a malformed/empty 200
		// body survives a parse failure. Calling response.json() directly would
		// consume the stream, and a throw would leave the fall-through
		// `return response` handing back an unreadable body ("Body is unusable"),
		// masking the real Databricks payload.
		if (contentType.includes("application/json")) {
			const text = await response.text();
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				// Not JSON after all — return the buffered body verbatim so it
				// stays readable downstream.
				return new Response(text, {
					status: response.status,
					statusText: response.statusText,
					headers: rewrittenHeaders(response.headers),
				});
			}
			normalizeContentArrays(json);
			normalizeDatabricksUsageFields(json);
			if (stripReasoning) {
				stripReasoningFromMessages(json);
			}
			return new Response(JSON.stringify(json), {
				status: response.status,
				statusText: response.statusText,
				headers: rewrittenHeaders(response.headers),
			});
		}

		return response;
	};
}
