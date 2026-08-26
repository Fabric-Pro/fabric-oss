import { classifyLimitError } from "@repo/utils/classify-limit-error";

/**
 * Turns any failed AI response into copy a user can act on.
 *
 * The rule this module exists to enforce: **no AI failure is ever silent.**
 * The previous interceptor mapped a hand-picked set of status codes
 * (429 / 400 / 401 / 503 / 5xx) through an `else if` chain with no final
 * `else`, so everything it did not name — most importantly **402, the code a
 * provider returns when the account is out of credit** — fell through and the
 * user saw nothing at all. The assistant simply stopped answering, which is
 * indistinguishable from it being broken.
 *
 * Two independent things decide the copy:
 *
 *   1. `classifyLimitError` — the shared, provider-agnostic classifier, so a
 *      quota / rate-limit / overload / context-length condition reads the same
 *      whether it came from the gateway, a direct provider, or a BYOK key.
 *      This is why the copy does not need a per-vendor branch.
 *   2. The HTTP status — a fallback for everything that is not a limit signal.
 *
 * Whatever the provider actually said is preferred over our generic sentence
 * wherever we have it: after the error-envelope fix, a schema rejection now
 * carries a field-level reason instead of arriving as an empty body, and that
 * reason is far more useful to the user than "check your settings".
 */

export interface AiErrorToastCopy {
	title: string;
	description: string;
	/**
	 * True when the copy asks someone to go and top up an account — the one
	 * failure here with a destination attached. The caller owns routing (it
	 * needs the active organization to build the URL), so this only says that an
	 * action is warranted, not where it goes.
	 */
	billingActionable?: boolean;
}

/**
 * Pull the provider's own explanation out of whatever envelope it arrived in.
 *
 * Shapes seen in practice: our own `{ error: "…" }`, the OpenAI-compatible
 * `{ error: { message } }`, the gateway's `{ error_code, message }`, and a bare
 * `{ message }`. Anything else yields `undefined` so the caller falls back to
 * status-based copy rather than rendering `[object Object]`.
 */
export function extractProviderMessage(body: unknown): string | undefined {
	if (typeof body === "string") {
		return body.trim() || undefined;
	}
	if (!body || typeof body !== "object") {
		return undefined;
	}
	const bag = body as {
		error?: unknown;
		message?: unknown;
		detail?: unknown;
	};
	if (typeof bag.error === "string" && bag.error.trim()) {
		return bag.error.trim();
	}
	if (bag.error && typeof bag.error === "object") {
		const nested = (bag.error as { message?: unknown }).message;
		if (typeof nested === "string" && nested.trim()) {
			return nested.trim();
		}
	}
	for (const candidate of [bag.message, bag.detail]) {
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return undefined;
}

/**
 * Copy for a failure that never reached the server at all (offline, DNS,
 * connection reset). Kept here so both call paths word it identically.
 */
/**
 * Copy for a run that opened fine and then went quiet — no frames, no error, no
 * close. Worded as an observation rather than a verdict, because at this point
 * that is all we know: the request may still be alive. It is retracted if the
 * run speaks again, and replaced if a real error arrives.
 */
export const AI_STREAM_SILENT: AiErrorToastCopy = {
	title: "The assistant has gone quiet",
	description:
		"No response has arrived for a while and the request may be stuck. You can keep waiting, or send it again.",
};

/**
 * Shown briefly when a run that had gone quiet starts answering again.
 *
 * Its job is accessibility, not decoration. Retracting the stall notice
 * silently tells a sighted user "that resolved" the moment the toast vanishes,
 * but sonner's live region is `aria-relevant="additions text"` — a removal is
 * never announced. A screen-reader user who heard "the assistant has gone
 * quiet" would be left with that as the last thing they were told. An addition
 * *is* announced, so the resolution replaces the notice rather than deleting it.
 */
export const AI_STREAM_RESUMED: AiErrorToastCopy = {
	title: "The assistant is responding again",
	description: "The request was not stuck after all.",
};

export const AI_NETWORK_FAILURE: AiErrorToastCopy = {
	title: "Connection failed",
	description:
		"Could not reach the AI service. Please check your internet connection and try again.",
};

/**
 * Slug → the name an administrator would recognise on a billing page.
 *
 * `classifyLimitError` reports the provider it detected as a lowercase slug.
 * Naming it is the difference between "some AI account is out of credit" and
 * knowing which console to open — the whole action this copy asks for. Falls
 * back to the generic wording when detection found nothing, rather than
 * guessing at a name that would send someone to the wrong billing page.
 */
function describeProvider(slug: string | undefined): string {
	switch (slug) {
		case "openai":
			return "OpenAI";
		case "anthropic":
			return "Anthropic";
		case "azure":
			return "Azure";
		case "groq":
			return "Groq";
		case "google":
			return "Google";
		case "deepseek":
			return "DeepSeek";
		case "cerebras":
			return "Cerebras";
		default:
			return "AI provider";
	}
}

function withProviderDetail(
	base: AiErrorToastCopy,
	providerMessage: string | undefined,
): AiErrorToastCopy {
	if (!providerMessage) {
		return base;
	}
	// The provider's own sentence is the actionable part; our copy is context.
	return { title: base.title, description: providerMessage };
}

/**
 * Map a non-ok AI response to toast copy. Always returns copy — callers can
 * render the result unconditionally, which is what keeps failures visible.
 */
export function describeAiError(
	status: number,
	body: unknown,
): AiErrorToastCopy {
	const providerMessage = extractProviderMessage(body);

	// Classify first: a limit condition is worth naming precisely even when the
	// status alone would look like a generic 400 — an exhausted balance is
	// reported as 402 by the gateway but as 400 by at least one upstream
	// provider, so status is not sufficient on its own.
	const signal = classifyLimitError({
		status,
		message: providerMessage ?? "",
	});

	switch (signal?.kind) {
		case "provider_quota":
			return {
				title: "AI provider out of credit",
				description: `The ${describeProvider(signal.provider)} account has no credit left, so the request was rejected. An administrator needs to top it up — retrying will not help until then.`,
				billingActionable: true,
			};
		case "provider_rate_limit":
			return withProviderDetail(
				{
					title: "AI service is busy",
					description:
						"The AI provider is rate-limiting requests. Please try again in a moment.",
				},
				providerMessage,
			);
		case "provider_overloaded":
			return {
				title: "AI service overloaded",
				description:
					"The AI provider is temporarily overloaded. Please try again in a moment.",
			};
		case "context_length":
			return {
				title: "Conversation too long",
				description:
					"This conversation exceeded the model's context window. Start a new conversation, or narrow the request, and try again.",
			};
		default:
			break;
	}

	switch (true) {
		case status === 401:
			return {
				title: "Session expired",
				description:
					"Your session has expired. Please refresh the page to continue.",
			};
		case status === 403:
			return withProviderDetail(
				{
					title: "Not allowed",
					description:
						"You do not have permission to use the AI service here.",
				},
				providerMessage,
			);
		case status === 404:
			return withProviderDetail(
				{
					title: "AI service not found",
					description:
						"The configured AI model or endpoint could not be reached. Check your AI provider settings.",
				},
				providerMessage,
			);
		case status === 408 || status === 504:
			return {
				title: "AI request timed out",
				description:
					"The AI service took too long to respond. Please try again.",
			};
		case status === 413:
			// Deliberately NOT `withProviderDetail`. What arrives here is the
			// hosting platform's own words plus a request id — in production,
			// "Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE arn1::…" —
			// which names neither the cause nor anything the user can do. This
			// is one of the few cases where our sentence beats the upstream one.
			//
			// An attachment is effectively always the reason: an image travels
			// as a base64 data URL, and prose alone does not approach a
			// serverless request-body cap. The second sentence matters as much
			// as the first — the attachment stays in the conversation's context,
			// so once a turn is refused every later turn is refused too, plain
			// text included, and the only way out is a new chat (Fizzy #2167).
			return {
				title: "Message too large to send",
				description:
					"This message exceeded the request size limit, usually because of an attached image. Try a smaller or lower-resolution attachment. If the conversation already contains one, start a new chat — otherwise later messages will keep failing.",
			};
		case status === 503:
			return withProviderDetail(
				{
					title: "AI service unavailable",
					description:
						"The AI service is temporarily unavailable. Please try again in a moment.",
				},
				providerMessage,
			);
		case status >= 500:
			return withProviderDetail(
				{
					title: "Server error",
					description:
						"The AI service encountered an internal error. Please try again.",
				},
				providerMessage,
			);
		case status >= 400:
			// Covers 400/422 and every other client error we have not named.
			return withProviderDetail(
				{
					title: "AI request rejected",
					description:
						"The AI service could not process the request. Please check your AI provider settings.",
				},
				providerMessage,
			);
		default:
			// A non-ok status outside 4xx/5xx should not happen, but returning
			// copy anyway is the whole point of this module.
			return withProviderDetail(
				{
					title: "AI request failed",
					description:
						"The AI service could not complete the request. Please try again.",
				},
				providerMessage,
			);
	}
}

/**
 * Sentinel status for a failure that never had one. It falls through every
 * status branch above to the generic copy, which is the honest outcome: an
 * in-stream failure has no HTTP status to describe.
 */
const NO_HTTP_STATUS = 0;

/**
 * Copy for a failure that arrived *inside* a 200 — the AG-UI stream's own
 * `RUN_ERROR` frame (see `../components/copilot/ag-ui-run-error`).
 *
 * Routing it through `describeAiError` rather than writing separate copy is the
 * point: `classifyLimitError` matches on wording as well as status, so an
 * exhausted provider balance reported mid-stream reads exactly as it does when
 * the same condition arrives as a 402 before the stream opens.
 *
 * The frame's `code` is deliberately NOT used as copy. It was, on the reasoning
 * that `INCOMPLETE_STREAM` beats saying nothing identifiable — but a
 * SCREAMING_SNAKE token is not identifiable to the person reading it, it reads
 * as a bug in the error message itself. A frame carrying only a code now falls
 * through to the generic sentence; the code is still in the logs, where the
 * person who needs it is looking.
 */
export function describeAiStreamError(runError: {
	message?: string;
	code?: string;
}): AiErrorToastCopy {
	return describeAiError(NO_HTTP_STATUS, { message: runError.message });
}
