/**
 * Request rules for OpenAI Responses calls billed to a member's ChatGPT plan
 * ("Sign in with ChatGPT"), shared by both inference paths:
 *
 *  - the Vercel AI SDK path, through `@repo/ai`'s `lib/chatgpt-plan/provider.ts`
 *    (`createOpenAI({ fetch })`), and
 *  - the LangChain agent path (`ChatOpenAI` with `configuration.fetch`), through
 *    `@repo/agent-core`'s `langchain-models.ts`.
 *
 * It lives here for the reason `databricks-compat.ts` does: the LangGraph agent
 * bundles mark `@repo/ai` external and bundle this package. Pure, no
 * dependencies.
 */

export const CHATGPT_PLAN_ORIGIN = "https://api.openai.com";

// Verbatim from the "preview limitations" page, plus previous_response_id,
// which is not allowed over HTTP, and service_tier overrides.
export const CHATGPT_PLAN_FORBIDDEN_FIELDS = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
	"previous_response_id",
	"service_tier",
] as const;

/** The plan's usage window is spent; nothing but waiting for it to reset helps. */
export const CHATGPT_PLAN_EXHAUSTED_CODE =
	"subscription_sharing_usage_limit_exceeded";

// The AI SDK retries 408/409/429/5xx. OpenAI asks apps not to repeat these,
// so they are surfaced with a non-retryable status; the real status travels in
// x-chatgpt-plan-original-status and the code stays in the body.
const NON_RETRYABLE_STATUS: Record<string, number> = {
	subscription_sharing_usage_limit_exceeded: 402,
	subscription_sharing_user_not_eligible: 403,
	subscription_sharing_unsupported_capability: 400,
	subscription_sharing_route_not_supported: 403,
	subscription_sharing_invalid_user: 401,
	chatpass_v2_scope_not_authorized: 403,
	chatpass_v2_invalid_authorization_context: 403,
};

// Only these are worth a bounded retry; any other failure is final.
const RETRYABLE_FAILURE_CODES = new Set([
	"server_error",
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

// Events that arrive before any output; a failure among them can still be
// turned into an HTTP error, so the SDK sees one non-retryable error instead
// of a stream it would retry.
const PRE_OUTPUT_EVENTS = new Set([
	"response.created",
	"response.in_progress",
	"response.queued",
]);

const DROPPED_HEADERS = new Set([
	"content-length",
	"content-encoding",
	"transfer-encoding",
	"content-type",
]);

type JsonObject = Record<string, unknown>;

export function transformResponsesBody(body: JsonObject): JsonObject {
	const next: JsonObject = { ...body, stream: true, store: false };
	for (const field of CHATGPT_PLAN_FORBIDDEN_FIELDS) {
		delete next[field];
	}
	// Strict schemas must list every property in `required`; Fabric's optional
	// fields would be rejected, and not every client (LangChain) can opt out.
	if (Array.isArray(next.tools)) {
		next.tools = next.tools.map((tool) =>
			tool && typeof tool === "object" && "strict" in tool
				? { ...(tool as JsonObject), strict: false }
				: tool,
		);
	}
	const text = next.text as JsonObject | undefined;
	const format = text?.format as JsonObject | undefined;
	if (format && "strict" in format) {
		next.text = { ...text, format: { ...format, strict: false } };
	}
	if (Array.isArray(next.input)) {
		next.input = next.input.map((item) =>
			item &&
			typeof item === "object" &&
			(item as JsonObject).role === "system"
				? { ...(item as JsonObject), role: "developer" }
				: item,
		);
	}
	return next;
}

function jsonResponse(
	body: unknown,
	status: number,
	upstream: Headers | undefined,
	originalStatus?: number,
): Response {
	const headers = new Headers();
	upstream?.forEach((value, key) => {
		if (!DROPPED_HEADERS.has(key.toLowerCase())) {
			headers.set(key, value);
		}
	});
	headers.set("content-type", "application/json");
	if (originalStatus !== undefined) {
		headers.set("x-chatgpt-plan-original-status", String(originalStatus));
	}
	return new Response(JSON.stringify(body), { status, headers });
}

function toResetDate(value: unknown, now: number): Date | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return new Date(value < 1e12 ? value * 1000 : value);
	}
	if (typeof value === "string" && value.trim() !== "") {
		if (/^\d+$/.test(value.trim())) {
			return toResetDate(Number(value), now);
		}
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : new Date(parsed);
	}
	return null;
}

/**
 * When the spent window resets, if the reply says so. The documented error
 * carries no reset time, so every known spelling is tried and the absence of
 * all of them is a normal outcome.
 */
function planResetAt(
	error: JsonObject,
	headers: Headers | undefined,
	now = Date.now(),
): Date | null {
	const explicit =
		toResetDate(error.resets_at, now) ?? toResetDate(error.reset_at, now);
	if (explicit) {
		return explicit;
	}
	const inSeconds = Number(error.resets_in_seconds);
	if (Number.isFinite(inSeconds) && inSeconds > 0) {
		return new Date(now + inSeconds * 1000);
	}
	const retryAfter = Number(headers?.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return new Date(now + retryAfter * 1000);
	}
	return null;
}

function failureResponse(
	error: JsonObject,
	upstream: Headers | undefined,
): Response {
	const code = String(error.code ?? "response_failed");
	const status =
		NON_RETRYABLE_STATUS[code] ??
		(RETRYABLE_FAILURE_CODES.has(code) ? 503 : 400);
	const resetAt =
		code === CHATGPT_PLAN_EXHAUSTED_CODE
			? planResetAt(error, upstream)
			: null;
	return jsonResponse(
		{
			error: {
				code,
				message: String(error.message ?? code),
				param: error.param ?? null,
				...(resetAt && { resets_at: resetAt.toISOString() }),
			},
		},
		status,
		upstream,
		code === CHATGPT_PLAN_EXHAUSTED_CODE ? 429 : undefined,
	);
}

function eventError(event: JsonObject): JsonObject {
	const payload = event.response as JsonObject | undefined;
	return (
		((payload?.error ?? event.error ?? event) as JsonObject | null) ?? {}
	);
}

function parseSseBlock(block: string): JsonObject | null {
	const data = block
		.split(/\r\n|\r|\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
		.join("\n");
	if (!data || data === "[DONE]") {
		return null;
	}
	try {
		return JSON.parse(data) as JsonObject;
	} catch {
		return null;
	}
}

const BLOCK_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

function* parseSseEvents(text: string): Generator<JsonObject> {
	for (const block of text.split(BLOCK_SEPARATOR)) {
		const event = parseSseBlock(block);
		if (event) {
			yield event;
		}
	}
}

/**
 * Turns a streamed Responses reply into the JSON body of a non-streaming
 * call. Only `response.completed` counts as success; `response.incomplete`
 * is returned as an incomplete response, `response.failed` as an error, and a
 * stream that ends without a terminal event as an interrupted stream.
 */
export async function aggregateResponsesStream(
	response: Response,
): Promise<Response> {
	const text = await response.text();
	const doneItems: unknown[] = [];
	for (const event of parseSseEvents(text)) {
		const type = event.type;
		if (type === "response.output_item.done") {
			doneItems.push(event.item);
		}
		if (type === "response.completed" || type === "response.incomplete") {
			const payload = { ...(event.response as JsonObject) };
			// Some backends send the terminal event with an empty output list.
			if (!Array.isArray(payload.output) || payload.output.length === 0) {
				payload.output = doneItems;
			}
			return jsonResponse(payload, 200, response.headers);
		}
		if (type === "response.failed" || type === "error") {
			return failureResponse(eventError(event), response.headers);
		}
	}
	return jsonResponse(
		{
			error: {
				code: "stream_interrupted",
				message: "The stream ended without response.completed",
				param: null,
			},
		},
		502,
		response.headers,
	);
}

const encoder = new TextEncoder();

/**
 * Passes a stream through, with two guarantees the SDK does not give:
 * a failure before any output becomes one non-retryable HTTP error (the SDK
 * would map it to a retryable 500 and send the request again), and a stream
 * that closes without a terminal event ends with an explicit error event
 * instead of looking like a normal finish.
 */
export async function guardResponsesStream(
	response: Response,
): Promise<Response> {
	const body = response.body;
	if (!body) {
		return response;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const buffered: Uint8Array[] = [];
	let pending = "";
	let started = false;
	let terminal = false;

	const inspect = (event: JsonObject): Response | null => {
		const type = String(event.type ?? "");
		if (
			type === "response.completed" ||
			type === "response.incomplete" ||
			type === "response.failed" ||
			type === "error"
		) {
			terminal = true;
		}
		if (!started && (type === "response.failed" || type === "error")) {
			return failureResponse(eventError(event), response.headers);
		}
		if (!PRE_OUTPUT_EVENTS.has(type)) {
			started = true;
		}
		return null;
	};

	const scan = (chunk: string): Response | null => {
		pending += chunk;
		const blocks = pending.split(BLOCK_SEPARATOR);
		pending = blocks.pop() ?? "";
		for (const block of blocks) {
			const event = parseSseBlock(block);
			const early = event ? inspect(event) : null;
			if (early) {
				return early;
			}
		}
		return null;
	};

	while (!started) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffered.push(value);
		const early = scan(decoder.decode(value, { stream: true }));
		if (early) {
			await reader.cancel();
			return early;
		}
	}

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of buffered) {
				controller.enqueue(chunk);
			}
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (!done) {
				scan(decoder.decode(value, { stream: true }));
				controller.enqueue(value);
				return;
			}
			if (pending) {
				scan("\n\n");
			}
			if (!terminal) {
				controller.enqueue(
					encoder.encode(
						`event: error\ndata: ${JSON.stringify({
							type: "error",
							code: "stream_interrupted",
							message:
								"The stream ended without response.completed",
							param: null,
							sequence_number: 0,
						})}\n\n`,
					),
				);
			}
			controller.close();
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(stream, {
		status: response.status,
		headers: response.headers,
	});
}

async function remapErrorResponse(response: Response): Promise<Response> {
	let text = await response.text();
	let code: string | undefined;
	try {
		const parsed = JSON.parse(text) as { error?: JsonObject };
		code =
			typeof parsed.error?.code === "string"
				? parsed.error.code
				: undefined;
		if (code === CHATGPT_PLAN_EXHAUSTED_CODE && parsed.error) {
			const resetAt = planResetAt(parsed.error, response.headers);
			if (resetAt) {
				text = JSON.stringify({
					...parsed,
					error: {
						...parsed.error,
						resets_at: resetAt.toISOString(),
					},
				});
			}
		}
	} catch {}
	const status = code ? NON_RETRYABLE_STATUS[code] : undefined;
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	if (status !== undefined) {
		headers.set("x-chatgpt-plan-original-status", String(response.status));
	}
	return new Response(text, {
		status: status ?? response.status,
		headers,
	});
}

// Header names whose values may identify the account or authenticate as it.
const SENSITIVE_HEADER =
	/auth|cookie|token|secret|key|session|organization|project|user|email/i;

/**
 * A reply's headers with every value that could identify or authenticate the
 * account replaced, for diagnostics. A denylist on purpose: which headers
 * describe the plan's usage window is not documented, so an allowlist would
 * drop exactly what is being looked for.
 */
export function redactChatGptPlanHeaders(
	headers: Headers,
): Record<string, string> {
	const redacted: Record<string, string> = {};
	headers.forEach((value, name) => {
		redacted[name] = SENSITIVE_HEADER.test(name) ? "[redacted]" : value;
	});
	return redacted;
}

export interface ChatGptPlanFetchOptions {
	getAccessToken: () => Promise<string>;
	/** Forces a refresh when the server rejects `failedToken`; see token manager. */
	onUnauthorized?: (failedToken: string) => Promise<string>;
	/**
	 * Told the status and headers of every upstream reply, before its body is
	 * read. Diagnostics only: a throw here never fails the call.
	 */
	onResponseHeaders?: (status: number, headers: Headers) => void;
	/**
	 * Asked once for another plan's token when the plan refuses a call as
	 * spent before any output; the call is then sent again with it. Null, or
	 * a second refusal, is final.
	 */
	onExhausted?: () => Promise<string | null>;
	baseFetch?: typeof fetch;
}

/** Whether a reply this fetch produced is a spent plan window, before any output. */
function isExhaustedReply(response: Response): boolean {
	return (
		response.status === NON_RETRYABLE_STATUS[CHATGPT_PLAN_EXHAUSTED_CODE] &&
		response.headers.get("x-chatgpt-plan-original-status") === "429"
	);
}

/**
 * fetch for `createOpenAI({ fetch })`: adds the user's plan token (only for
 * api.openai.com), applies the request rules, guards streams and fakes
 * non-streaming calls by aggregating the stream.
 */
export function createChatGptPlanFetch({
	getAccessToken,
	onUnauthorized,
	onResponseHeaders,
	onExhausted,
	baseFetch = fetch,
}: ChatGptPlanFetchOptions): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (new URL(url).origin !== CHATGPT_PLAN_ORIGIN) {
			throw new Error(
				`Refusing to send a ChatGPT plan token to ${new URL(url).origin}`,
			);
		}

		const isResponses =
			new URL(url).pathname.endsWith("/responses") &&
			typeof init?.body === "string";
		const original = isResponses
			? (JSON.parse(init?.body as string) as JsonObject)
			: null;
		const body = original
			? JSON.stringify(transformResponsesBody(original))
			: init?.body;

		const send = async (token: string) => {
			const headers = new Headers(init?.headers);
			headers.set("authorization", `Bearer ${token}`);
			return baseFetch(input, { ...init, headers, body });
		};

		const attempt = async (token: string): Promise<Response> => {
			let response = await send(token);
			if (response.status === 401 && onUnauthorized) {
				await response.body?.cancel();
				response = await send(await onUnauthorized(token));
			}
			try {
				onResponseHeaders?.(response.status, response.headers);
			} catch {}

			if (!original) {
				return response;
			}
			if (!response.ok) {
				return remapErrorResponse(response);
			}
			return original.stream === true
				? guardResponsesStream(response)
				: aggregateResponsesStream(response);
		};

		const first = await attempt(await getAccessToken());
		if (!original || !onExhausted || !isExhaustedReply(first)) {
			return first;
		}
		const next = await onExhausted();
		if (next === null) {
			return first;
		}
		await first.body?.cancel();
		return attempt(next);
	}) as typeof fetch;
}

/**
 * The plan serving a call ran out after the call had already produced
 * output, so it could not be retried in place — but another plan can serve
 * it (Fizzy #2770). Deliberately NOT among the non-retryable AI error types:
 * Temporal retries the activity once, and the retry resolves the next plan.
 * When no other plan remains the error is `SubscriptionPlanExhaustedError`
 * instead.
 */
export class PlanSourceRotatedError extends Error {
	constructor(
		message = "The ChatGPT plan ran out mid-reply; retrying on another plan.",
	) {
		super(message);
		this.name = "PlanSourceRotatedError";
	}
}

/**
 * The member's ChatGPT plan has no usage left in its current window. Thrown
 * by the plan model wrappers (not by the fetch, which must keep answering with
 * an HTTP error so neither SDK retries it as a connection fault). The class
 * name is what Temporal records as the failure type, so it is listed as
 * non-retryable for model-calling activities.
 */
export class SubscriptionPlanExhaustedError extends Error {
	readonly code = CHATGPT_PLAN_EXHAUSTED_CODE;

	constructor(
		message: string,
		/** When the window resets, if the provider said; null otherwise. */
		readonly resetAt: Date | null,
	) {
		super(message);
		this.name = "SubscriptionPlanExhaustedError";
	}
}

function exhaustedFromBody(
	body: unknown,
	fallbackMessage: string,
): SubscriptionPlanExhaustedError | null {
	let parsed = body;
	if (typeof body === "string") {
		if (!body.includes(CHATGPT_PLAN_EXHAUSTED_CODE)) {
			return null;
		}
		try {
			parsed = JSON.parse(body);
		} catch {
			return new SubscriptionPlanExhaustedError(fallbackMessage, null);
		}
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	const envelope = parsed as JsonObject;
	const error = (
		envelope.error && typeof envelope.error === "object"
			? envelope.error
			: envelope
	) as JsonObject;
	if (error.code !== CHATGPT_PLAN_EXHAUSTED_CODE) {
		return null;
	}
	return new SubscriptionPlanExhaustedError(
		typeof error.message === "string" ? error.message : fallbackMessage,
		toResetDate(error.resets_at, Date.now()),
	);
}

/**
 * Recognizes a spent plan window in an error thrown by either SDK: the AI SDK
 * `APICallError` (`responseBody`), the OpenAI client's `APIError` (`error`,
 * `code`), or either of them wrapped as a `cause`. Returns null for anything
 * else.
 */
export function toSubscriptionPlanExhaustedError(
	error: unknown,
): SubscriptionPlanExhaustedError | null {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		if (current instanceof SubscriptionPlanExhaustedError) {
			return current;
		}
		if (typeof current !== "object") {
			return null;
		}
		const bag = current as JsonObject;
		const message =
			typeof bag.message === "string"
				? bag.message
				: "ChatGPT plan usage limit reached";
		const found =
			exhaustedFromBody(bag.responseBody, message) ??
			exhaustedFromBody(bag.error, message) ??
			(bag.code === CHATGPT_PLAN_EXHAUSTED_CODE
				? new SubscriptionPlanExhaustedError(message, null)
				: null);
		if (found) {
			return found;
		}
		// AI SDK `RetryError` keeps the provider error in `lastError`.
		current = bag.cause ?? bag.lastError;
	}
	return null;
}
