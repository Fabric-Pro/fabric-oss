import { ORPCError } from "@orpc/client";
import { isContextSummarizationEnabled } from "@repo/utils/feature-flag";

/**
 * Feature gate. Context Summarization is OFF unless
 * `FABRIC_FEATURE_CONTEXT_SUMMARIZATION` is set (opt-in, default OFF). Every
 * summarization procedure calls this first, so the API behaves as if the routes
 * don't exist when the flag is unset. The Context-tab control is gated
 * client-side by `NEXT_PUBLIC_FABRIC_FEATURE_CONTEXT_SUMMARIZATION`.
 *
 * Mirrors `assertTestCasesFeatureEnabled`.
 */
export function assertContextSummarizationEnabled(): void {
	if (!isContextSummarizationEnabled()) {
		throw new ORPCError("NOT_FOUND", {
			message: "Context summarization is not enabled.",
		});
	}
}

/**
 * Whether the code-repo/index source is available as a summary source. Gated by
 * the same server flag as code indexing (`FEATURE_CODE_INDEXING`) — when off, the
 * source-selection UI hides it and the trigger drops it, so a summary never folds
 * repo signal for a project whose code feature is disabled.
 */
export function isCodeRepoSummarySourceEnabled(): boolean {
	return process.env.FEATURE_CODE_INDEXING === "true";
}
