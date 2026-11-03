import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
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
 * Whether the code-repo/index source is available as a summary source: the
 * project's code search mode is RAG and at least one active repository is
 * included in code search (spec 2026-10-29 code-index-sync §6a). When not, the
 * source-selection UI hides it and the trigger drops it, so a summary never
 * folds repo signal the project does not index.
 */
export async function isCodeRepoSummarySourceEnabled(
	projectId: string,
): Promise<boolean> {
	const [settings, included] = await Promise.all([
		db.projectRagSettings.findUnique({
			where: { projectId },
			select: { codeSearchMode: true },
		}),
		db.projectRepositoryIntegration.count({
			where: { projectId, status: "ACTIVE", includedInCodeSearch: true },
		}),
	]);
	return settings?.codeSearchMode === "RAG" && included > 0;
}
