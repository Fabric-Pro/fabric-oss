/**
 * Request-size ESTIMATES for the turn token ledger (turn-budget-middleware.ts).
 *
 * The ledger reserves `inputEstimate + outputCap` before each physical
 * request and settles the provider's reported usage after. The input side is
 * an estimate, not an upper bound: characters are not tokens, providers add
 * framing of their own, and an image's or a file's token cost depends on the
 * provider and on the content. It is sized to over-reserve ordinary text
 * (about one token per three characters, plus a quarter), so concurrent
 * reservations rarely under-reserve, and what a request actually used
 * replaces its reservation when it settles. The per-turn allowance is
 * therefore a token-accounting ceiling, never a dollar guarantee.
 *
 * Every constant the ledger's request sizing uses lives here.
 */

import type { ModelMessage } from "ai";
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal";

export const TURN_BUDGET_ESTIMATE = {
	/** Characters per token assumed for serialized text. */
	charsPerToken: 3,
	/** Head-room multiplied onto the character-based count. */
	safetyFactor: 1.25,
	/** Tokens of provider framing counted per message (role, separators). */
	perMessageFramingTokens: 8,
	/** Tokens of provider framing counted once per request. */
	perRequestFramingTokens: 64,
	/**
	 * Fixed tokens counted per image part. Current providers bill a single
	 * image at their default resize well under this (Anthropic about 1,600
	 * tokens for a 1.15-megapixel image; OpenAI high detail at most a few
	 * thousand); an unusual image can still exceed it.
	 */
	imagePartTokens: 3_000,
	/**
	 * Fixed tokens counted per non-image file part (a PDF, a document). Its
	 * real cost scales with the file's pages, so this is a floor-like
	 * estimate for a short file, not a bound.
	 */
	filePartTokens: 32_000,
	/** Tokens counted per embedded value on top of its text. */
	perEmbeddingValueTokens: 4,
	/**
	 * Output tokens assumed when a request names no `maxOutputTokens` (the
	 * value the Advisor's rounds send).
	 */
	defaultRequestedOutputTokens: 16_384,
	/** The smallest output cap worth sending; less room refuses the request. */
	minOutputTokens: 1_024,
	/**
	 * Output tokens a typed decision (`doDecide`) reserves per question. A
	 * decision takes no output cap; its answer is bounded by its questions
	 * (one typed answer each: a choice, a score or a boolean, with its
	 * probabilities), and this allowance per question is that bound as the
	 * ledger reserves it. It is an allowance, not a guarantee: the attempt
	 * settles to the usage the provider reports, which may exceed it.
	 */
	decisionOutputTokensPerQuestion: 1_024,
	/**
	 * How long a stream's `finish` is held waiting for its settlement. Past
	 * it the `finish` is forwarded and the settlement is left in flight: the
	 * attempt stays RESERVED (charged at its reservation) until the write
	 * lands, and a late settlement with complete usage then reconciles it.
	 */
	settlementTimeoutMs: 10_000,
} as const;

function charsToTokens(chars: number): number {
	return Math.ceil(
		(chars / TURN_BUDGET_ESTIMATE.charsPerToken) *
			TURN_BUDGET_ESTIMATE.safetyFactor,
	);
}

/** JSON length of `value` with binary payloads left out. */
function serializedLength(value: unknown): number {
	try {
		return (
			JSON.stringify(value, (_key, inner) =>
				inner instanceof Uint8Array || inner instanceof ArrayBuffer
					? ""
					: inner,
			) ?? ""
		).length;
	} catch {
		return 0;
	}
}

function isFilePart(part: unknown): part is { mediaType?: unknown } {
	const type = (part as { type?: unknown } | null)?.type;
	return type === "file" || type === "reasoning-file" || type === "image";
}

function filePartTokens(part: { mediaType?: unknown }): number {
	const mediaType =
		typeof part.mediaType === "string" ? part.mediaType : "image/";
	return mediaType.startsWith("image/")
		? TURN_BUDGET_ESTIMATE.imagePartTokens
		: TURN_BUDGET_ESTIMATE.filePartTokens;
}

/**
 * Estimated input tokens of one language-model request: the serialized
 * prompt and tool definitions at `charsPerToken` with `safetyFactor`, plus
 * framing per message and per request, plus a fixed count per image or file
 * part (whose bytes are not counted as text).
 */
export function estimateLanguageRequestInputTokens(params: {
	prompt?: unknown;
	tools?: unknown;
}): number {
	let chars = 0;
	let fixed = TURN_BUDGET_ESTIMATE.perRequestFramingTokens;
	const messages = Array.isArray(params.prompt) ? params.prompt : [];
	for (const message of messages) {
		fixed += TURN_BUDGET_ESTIMATE.perMessageFramingTokens;
		const content = (message as { content?: unknown } | null)?.content;
		if (typeof content === "string") {
			chars += content.length;
			continue;
		}
		if (!Array.isArray(content)) {
			chars += serializedLength(content);
			continue;
		}
		for (const part of content) {
			if (isFilePart(part)) {
				fixed += filePartTokens(part);
				continue;
			}
			const text = (part as { text?: unknown } | null)?.text;
			chars +=
				typeof text === "string" &&
				Object.keys(part as object).length <= 3
					? text.length
					: serializedLength(part);
		}
	}
	if (Array.isArray(params.tools)) {
		for (const tool of params.tools) {
			chars += serializedLength(tool);
		}
	}
	return charsToTokens(chars) + fixed;
}

/**
 * The input estimate the turn-budget middleware will compute for a request
 * sent with `instructions` and `messages` and no tools, for a caller sizing
 * the request before it sends it (the Advisor's finalization synthesis).
 *
 * It converts the request the way the SDK does before the request reaches
 * the model middleware (`standardizePrompt` and
 * `convertToLanguageModelPrompt`, the same calls `streamText` and
 * `generateText` make) and runs `estimateLanguageRequestInputTokens` on the
 * result, so for a text-only request it is the very number the middleware
 * reserves: the factory's wrappers outside the middleware (the dispatch
 * guard, the usage limit check, the ChatGPT plan's request middleware)
 * leave the prompt as it is. A file or image part a message references by
 * URL is not downloaded here (it counts at its fixed estimate either way).
 */
export async function estimateModelRequestInputTokens(request: {
	instructions?: string;
	messages: ModelMessage[];
}): Promise<number> {
	return estimateLanguageRequestInputTokens({
		prompt: await toLanguageModelPrompt(request),
	});
}

/**
 * The prompt the model middleware receives for a request sent with
 * `instructions` and `messages`: the SDK's own conversion (see
 * {@link estimateModelRequestInputTokens}). A request sizer hands it to the
 * turn-budget middleware as the prompt to send.
 */
export async function toLanguageModelPrompt(request: {
	instructions?: string;
	messages: ModelMessage[];
}): Promise<Awaited<ReturnType<typeof convertToLanguageModelPrompt>>> {
	const standardized = await standardizePrompt({
		instructions: request.instructions,
		messages: request.messages,
	});
	return convertToLanguageModelPrompt({
		prompt: standardized,
		// Every URL counts as supported, so nothing is fetched to size it.
		supportedUrls: { "*/*": [/.*/] },
		download: undefined,
	});
}

/** Estimated input tokens of one embedding request. */
export function estimateEmbeddingRequestInputTokens(values: unknown): number {
	const list = Array.isArray(values) ? values : [];
	let chars = 0;
	for (const value of list) {
		chars +=
			typeof value === "string" ? value.length : serializedLength(value);
	}
	return (
		charsToTokens(chars) +
		list.length * TURN_BUDGET_ESTIMATE.perEmbeddingValueTokens
	);
}

/** Estimated input tokens of one typed decision request (`doDecide`). */
export function estimateDecisionRequestInputTokens(params: {
	state?: unknown;
	questions?: unknown;
}): number {
	const questionCount = decisionQuestionCount(params.questions);
	return (
		charsToTokens(
			serializedLength(params.state) + serializedLength(params.questions),
		) +
		TURN_BUDGET_ESTIMATE.perRequestFramingTokens +
		questionCount * TURN_BUDGET_ESTIMATE.perMessageFramingTokens
	);
}

/** The output allowance one typed decision request reserves. */
export function decisionOutputAllowance(questions: unknown): number {
	return (
		Math.max(decisionQuestionCount(questions), 1) *
		TURN_BUDGET_ESTIMATE.decisionOutputTokensPerQuestion
	);
}

function decisionQuestionCount(questions: unknown): number {
	return questions && typeof questions === "object"
		? Object.keys(questions).length
		: 0;
}
