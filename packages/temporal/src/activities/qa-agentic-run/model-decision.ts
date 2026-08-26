/**
 * One structured decision from the model, for the QA agentic runner.
 *
 * ## Why this is not just `generateObject`
 *
 * It was, and no test case could pass: the first step of every case blocked with
 * *"No object generated: could not parse the response."* That sentence is the
 * same one whether the model answered in prose, ran out of tokens midway through
 * valid JSON, or returned nothing — and `generateObject` has no way to continue
 * from any of them.
 *
 * Three things were wrong, and each is fixed here:
 *
 * 1. **No output budget was sent.** The AI SDK omits `max_tokens` entirely
 *    unless a caller sets `maxOutputTokens`, and a reasoning deployment spends
 *    its allowance on hidden reasoning before it emits a single character of the
 *    answer. The response then ends at the deployment default with
 *    `finishReason: "length"` and a truncated or empty body. The prompt here
 *    carries a page snapshot, so it reasons for far longer than the short
 *    prose-in / small-object-out calls elsewhere in the codebase that kept
 *    working — which is why this call path failed alone. Same failure class the
 *    backlog analyzer already guards with an explicit budget.
 * 2. **A provider that ignores `response_format` had nowhere to go.** Some
 *    OpenAI-compatible deployments answer a `json_schema` request in prose. The
 *    text fallback below asks for JSON in words and parses it tolerantly, which
 *    is the same retreat `deep-researcher` already makes for this stack.
 * 3. **The diagnosis was only in the logs.** Whoever is testing reads the run
 *    detail, not Log Analytics, so {@link describeModelFailure} puts the finish
 *    reason and the shape of the reply into the sentence the step shows.
 *
 * The strategy that answered is returned as `via`, so a single run says which of
 * the three causes was real without anyone reading a log.
 */

import { generateObject, generateText, NoObjectGeneratedError } from "@repo/ai";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import type { LanguageModel } from "ai";
import type { z } from "zod";
import { safeHeartbeat } from "../lib/activity-liveness";

/**
 * Output allowance for one decision, when the model catalog has no cap of its
 * own to clamp to.
 *
 * The answer is a handful of short fields, so this is not sized for the answer —
 * it is sized for a reasoning model's hidden thinking, which is charged against
 * the same allowance and which produced an empty response at the deployment
 * default. Half the shared maximal ceiling: far above anything that truncates,
 * still bounded for providers that reserve the request against their quota.
 */
export const DECISION_OUTPUT_TOKEN_CEILING = 16_384;

/** How much of the model's raw reply to keep when reporting a failure. */
const RAW_REPLY_DETAIL_LIMIT = 400;

/** How often to check in while a model call is outstanding. */
const MODEL_CALL_HEARTBEAT_MS = 20_000;

/** Which strategy produced the decision. */
export type DecisionStrategy = "object" | "text";

export interface ModelDecision<T> {
	value: T;
	via: DecisionStrategy;
	/**
	 * Provider calls actually made — 1 normally, 2 when the text fallback ran.
	 *
	 * The run bills per model call and refuses above a cost cap, so counting the
	 * fallback's call is not bookkeeping: reporting 1 when 2 were spent makes the
	 * cap leak by exactly the amount a struggling deployment costs most.
	 */
	calls: number;
}

/**
 * Pull a JSON object out of a reply that was asked for JSON but may not be only
 * JSON — a markdown fence, a lead-in sentence, or trailing commentary.
 *
 * Scans for the first `{` and walks to its matching `}`, respecting strings and
 * escapes so a brace inside `"observation"` text cannot end the object early.
 * Returns null when there is no balanced object, which the caller reports rather
 * than guesses around.
 *
 * Exported for its own tests: the tolerance is the whole point of it, so the
 * shapes it must survive are what get asserted.
 */
export function extractJsonObject(raw: string): unknown | null {
	const start = raw.indexOf("{");
	if (start === -1) {
		return null;
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(raw.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}

	return null;
}

/**
 * A sentence naming what the model actually did, for the step observation.
 *
 * `NoObjectGeneratedError`'s own message is identical for every cause, so a
 * person reading a blocked step learned nothing from it. These three branches
 * are the three different fixes: a length cap is a budget problem, prose is a
 * provider that ignores the schema, and an empty reply is capacity or auth.
 *
 * Exported for its own tests — the value of this function is the sentence.
 */
export function describeModelFailure(err: unknown): string {
	if (!NoObjectGeneratedError.isInstance(err)) {
		return err instanceof Error ? err.message : String(err);
	}

	const reply = err.text?.trim() ?? "";
	if (err.finishReason === "length") {
		return "the reply was cut off by the model's output limit before it produced a complete answer";
	}
	if (reply.length === 0) {
		return `the model returned an empty reply (finish reason: ${err.finishReason ?? "unknown"})`;
	}
	return `the model answered with something that is not the expected JSON (finish reason: ${
		err.finishReason ?? "unknown"
	}): ${reply.slice(0, RAW_REPLY_DETAIL_LIMIT)}`;
}

/**
 * Run `work` while checking in, so a slow model call cannot look like a dead
 * activity.
 *
 * The runner's activity declares a two-minute heartbeat timeout and previously
 * heartbeat once per step — with two model calls per step, a deployment that
 * reasons for a while could exceed it and have the whole case killed and
 * retried. Raising the token budget makes slow calls more likely, not less, so
 * this ships with it rather than after it.
 */
async function withHeartbeat<T>(
	details: unknown,
	work: () => Promise<T>,
): Promise<T> {
	const ticker = setInterval(
		() => safeHeartbeat(details),
		MODEL_CALL_HEARTBEAT_MS,
	);
	try {
		return await work();
	} finally {
		clearInterval(ticker);
	}
}

export interface DecideWithModelInput<S extends z.ZodType> {
	model: LanguageModel;
	/** Catalog metadata for the resolved model, for the budget clamp. */
	metadata: {
		provider: string;
		maxOutputTokens?: number;
		contextWindow?: number;
	};
	schema: S;
	prompt: string;
	/**
	 * Plain-English description of the JSON to return, appended only on the text
	 * fallback. The schema cannot carry this: the fallback's whole premise is a
	 * provider that ignored the schema.
	 */
	jsonContract: string;
	/** Passed through to heartbeat details so a stuck call is identifiable. */
	heartbeatDetails: unknown;
}

/**
 * Ask the model for one structured decision.
 *
 * Throws only when BOTH strategies fail; the thrown error is the original
 * `generateObject` failure, so {@link describeModelFailure} can still name the
 * cause. A partial answer is preferred to no answer everywhere here — the
 * schemas are all-optional by design, so `{}` is a legitimate result that the
 * caller normalises into a safe no-op.
 */
export async function decideWithModel<S extends z.ZodType>(
	input: DecideWithModelInput<S>,
): Promise<ModelDecision<z.infer<S>>> {
	const { model, metadata, schema, prompt, jsonContract } = input;

	// Always send a budget. The shared helper returns undefined for providers it
	// judges not to need one, which is the case that produced an empty reply
	// here, so its answer is a clamp rather than a veto.
	const maxOutputTokens =
		computeMaxOutputTokenBudget(metadata, {
			promptChars: prompt.length,
			ceilingTokens: DECISION_OUTPUT_TOKEN_CEILING,
		}) ?? DECISION_OUTPUT_TOKEN_CEILING;

	try {
		const { object } = await withHeartbeat(input.heartbeatDetails, () =>
			generateObject({
				model,
				schema,
				prompt,
				maxOutputTokens,
				// The Azure fetch shim already relaxes this for Azure. Sending it
				// explicitly covers every other OpenAI-compatible deployment,
				// which gets no shim and rejects an optional-heavy schema under
				// strict mode.
				providerOptions: { openai: { strictJsonSchema: false } },
			}),
		);
		return { value: object as z.infer<S>, via: "object", calls: 1 };
	} catch (err) {
		if (!NoObjectGeneratedError.isInstance(err)) {
			// A transport, auth or quota failure is not something a differently
			// phrased prompt fixes. Retrying it would just spend the budget twice
			// to reach the same answer.
			throw err;
		}

		let text: string;
		try {
			({ text } = await withHeartbeat(input.heartbeatDetails, () =>
				generateText({
					model,
					prompt: `${prompt}\n\n${jsonContract}`,
					maxOutputTokens,
				}),
			));
		} catch {
			// The fallback's own failure is the less informative of the two: the
			// ORIGINAL error carries finishReason, usage and the raw reply, which
			// is what names the cause for whoever reads the step. Throwing the
			// fallback's error would replace a diagnosis with a symptom.
			throw err;
		}

		const extracted = extractJsonObject(text);
		if (extracted === null) {
			throw err;
		}

		const parsed = schema.safeParse(extracted);
		if (!parsed.success) {
			throw err;
		}

		return { value: parsed.data as z.infer<S>, via: "text", calls: 2 };
	}
}
