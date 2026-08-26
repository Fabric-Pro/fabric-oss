import { ORPCError } from "@orpc/client";
import { isPublishingSuiteEnabled } from "@repo/utils/feature-flag";

/**
 * Feature gate. The whole Publishing Suite is OFF unless
 * `FABRIC_FEATURE_PUBLISHING_SUITE` is opted in (default OFF, parsed by
 * `parseOptInFlag`). Every publishing-suite procedure calls this first, so
 * the API behaves as if the routes don't exist when the flag is unset. The
 * client tab/UI is gated separately by
 * `NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE`.
 *
 * Mirrors `assertTestCasesFeatureEnabled` / `assertContextSummarizationEnabled`.
 */
export function assertPublishingSuiteFeatureEnabled(): void {
	if (!isPublishingSuiteEnabled()) {
		throw new ORPCError("NOT_FOUND", {
			message: "Publishing Suite is not enabled",
		});
	}
}
