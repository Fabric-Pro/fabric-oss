/**
 * Dispatch-guard middleware for the models the factory returns.
 *
 * `getAIModelWithMetadata` and `getAIEmbeddingModelWithMetadata` wrap every
 * model they return with this middleware. It reads the ambient dispatch guard
 * (`@repo/utils/dispatch-guard`) at REQUEST time, not when the model was
 * created, and:
 *
 *   - with no guard active, passes the request through unchanged;
 *   - with a guard active, awaits `assertDispatchable()` before every physical
 *     `doGenerate`, `doStream` and `doEmbed`, and merges the guard's abort
 *     signal into the request's own `abortSignal`.
 *
 * It uses `transformParams` because the AI SDK runs it once per physical
 * request: `wrapLanguageModel` and `wrapEmbeddingModel` (ai v7) call it inside
 * the wrapped `doGenerate`/`doStream`/`doEmbed` and hand the returned params to
 * the inner model. The SDK's own retries and each step of a multi-step call go
 * back through those methods, so each one is checked again, and an embedding
 * call the SDK splits into several requests is checked per request.
 */

import {
	getDispatchGuard,
	markDispatchGuardedModel,
} from "@repo/utils/dispatch-guard";
import type {
	EmbeddingModel,
	EmbeddingModelMiddleware,
	LanguageModel,
	LanguageModelMiddleware,
} from "ai";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";

/**
 * Checks the active guard and returns `params` with the guard's abort signal
 * merged in. Returns `params` untouched when no guard is active.
 */
async function applyDispatchGuard<P extends { abortSignal?: AbortSignal }>(
	params: P,
): Promise<P> {
	const guard = getDispatchGuard();
	if (!guard) {
		return params;
	}
	await guard.assertDispatchable();
	const guardSignal = guard.abortSignal();
	if (!guardSignal || guardSignal === params.abortSignal) {
		return params;
	}
	return {
		...params,
		abortSignal: params.abortSignal
			? AbortSignal.any([params.abortSignal, guardSignal])
			: guardSignal,
	};
}

const dispatchGuardLanguageMiddleware: LanguageModelMiddleware = {
	specificationVersion: "v4",
	transformParams: ({ params }) => applyDispatchGuard(params),
};

const dispatchGuardEmbeddingMiddleware: EmbeddingModelMiddleware = {
	specificationVersion: "v4",
	transformParams: ({ params }) => applyDispatchGuard(params),
};

/**
 * Wraps a resolved language model so each physical request consults the
 * ambient dispatch guard. The result is marked, so an explicit per-call-site
 * check can tell this one already runs.
 */
export function wrapModelWithDispatchGuard(
	model: LanguageModel,
): LanguageModel {
	return markDispatchGuardedModel(
		wrapLanguageModel({
			model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
			middleware: dispatchGuardLanguageMiddleware,
		}),
	) as LanguageModel;
}

/** Embedding-model counterpart of {@link wrapModelWithDispatchGuard}. */
export function wrapEmbeddingModelWithDispatchGuard(
	model: EmbeddingModel,
): EmbeddingModel {
	return markDispatchGuardedModel(
		wrapEmbeddingModel({
			model: model as Parameters<typeof wrapEmbeddingModel>[0]["model"],
			middleware: dispatchGuardEmbeddingMiddleware,
		}),
	) as EmbeddingModel;
}
