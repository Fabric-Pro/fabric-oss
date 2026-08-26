import { ORPCError } from "@orpc/client";
import { isLivingDocsRefreshEnabled } from "@repo/utils/feature-flag";

/**
 * Feature gate. Living Documents auto-refresh is OFF unless
 * `FABRIC_FEATURE_LIVING_DOCS_REFRESH` is set (opt-in, default OFF). Every
 * auto-refresh procedure calls this first, so the API behaves as if the routes
 * don't exist when the flag is unset. The document-masthead control is gated
 * client-side by `NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH`.
 *
 * Mirrors `assertContextSummarizationEnabled`.
 */
export function assertLivingDocsRefreshEnabled(): void {
	if (!isLivingDocsRefreshEnabled()) {
		throw new ORPCError("NOT_FOUND", {
			message: "Living document auto-refresh is not enabled.",
		});
	}
}
