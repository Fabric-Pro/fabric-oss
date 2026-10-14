/**
 * Per-request HARD usage-limit check for the language models the factory
 * returns.
 *
 * `getAIModelWithMetadata` checks HARD `AiUsageLimit`s once, when it resolves
 * a model. Callers reuse the resolved model (a multi-step `streamText` or
 * `generateText` with `stopWhen`, an agent loop, a batch activity), and a
 * limit can be reached partway through, so both language-model resolvers also
 * wrap the model with this middleware. Its `transformParams` awaits the limit
 * check, with the scope the resolver bound, before every physical request:
 * `wrapLanguageModel` (ai v7) runs `transformParams` inside each `doGenerate`
 * and `doStream`, which the SDK calls once per step and once per retry
 * attempt. A check that throws, a limit rejection or any other failure, ends
 * the request before the wrapped model is called, so nothing is dispatched
 * and, with the usage logger inside this wrapper, no usage row is written.
 * The resolution-time check stays: a limit that is already exhausted still
 * fails before any work starts.
 *
 * How a refusal reaches the caller: the first attempt of a step throws the
 * `AiUsageLimitExceededError` as it is. An attempt after a retryable provider
 * failure throws it inside the SDK's `RetryError`, so classify a caught error
 * with `findAiUsageLimitError` rather than `instanceof`. `streamText` does
 * not throw at all: the refusal becomes an `error` stream part and reaches
 * `onError`, and the text of earlier steps is kept.
 *
 * Cost: the check has no cache and no shortcut. When no limit applies it is
 * two sequential database queries per model request (the tenant's time zone
 * by primary key, then the limits, filtered on indexed tenant columns); each
 * applicable limit adds one counter read.
 *
 * A check reads the limit counters as they stand. Usage rows and counter
 * increments are written asynchronously after a call completes, so a request
 * that exhausts a limit stops later requests only once its usage is
 * recorded, and concurrent requests can each pass the check before that. In
 * aggregate usage mode (`usageLogging: "aggregate"`, the main direct chat)
 * the turn's usage is recorded once, after the whole turn, so a check between
 * that turn's steps does not see the turn's own spend; it catches a limit
 * exhausted by other usage.
 */

import type { LanguageModel, LanguageModelMiddleware } from "ai";
import { wrapLanguageModel } from "ai";

/**
 * Wraps a resolved language model so the HARD usage-limit check runs
 * immediately before each physical `doGenerate` and `doStream`.
 *
 * `assertWithinLimits` carries the caller's scope (tenant, provider config,
 * model, task type) and throws `AiUsageLimitExceededError` when a limit is
 * exhausted; any error it throws propagates unchanged and nothing is sent.
 */
export function wrapModelWithUsageLimits(
	model: LanguageModel,
	assertWithinLimits: () => Promise<void>,
): LanguageModel {
	const middleware: LanguageModelMiddleware = {
		specificationVersion: "v4",
		transformParams: async ({ params }) => {
			await assertWithinLimits();
			return params;
		},
	};
	return wrapLanguageModel({
		model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
		middleware,
	}) as LanguageModel;
}
