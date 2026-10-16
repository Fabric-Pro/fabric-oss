/**
 * Rolling Anthropic cache breakpoint plus in-flight compaction for AI SDK
 * multi-step tool loops.
 *
 * The breakpoint itself lives in `@repo/ai/prompt-cache`
 * ({@link withStepCacheBreakpoint}, and `makeStepCacheBreakpoint` for loops
 * that never compact), where it explains why each step removes the markers
 * earlier steps added. This module pairs it with the temporal-only compactor.
 */

import {
	isPromptCacheTarget,
	withStepCacheBreakpoint,
} from "@repo/ai/prompt-cache";
import type { ModelMessage } from "ai";
import { makeInFlightToolCompactor } from "./in-flight-tool-compaction";

/**
 * The `prepareStep` for a multi-step tool loop: in-flight tool-result
 * compaction, plus a rolling cache breakpoint when the resolved model takes
 * one. Same gate as direct chat and the Advisor rounds: Bedrock, Foundry and
 * other gateways use request adapters that do not take the marker.
 *
 * A call with no tools runs one step, so nothing reads back the prefix a
 * breakpoint would write, and Anthropic bills a cache write above the normal
 * input price. Such a call gets compaction only.
 */
export function makeToolLoopPrepareStep(model: {
	provider: string;
	modelString: string;
	hasTools: boolean;
}): (options: { messages: ModelMessage[] }) => { messages?: ModelMessage[] } {
	const compactor = makeInFlightToolCompactor();
	return model.hasTools &&
		isPromptCacheTarget(model.provider, model.modelString)
		? withStepCacheBreakpoint(compactor)
		: compactor;
}
