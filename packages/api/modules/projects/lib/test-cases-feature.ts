import { ORPCError } from "@orpc/client";

/**
 * Feature gate. The whole QA feature is OFF unless
 * `FABRIC_FEATURE_TEST_CASES` is exactly "true" (false by default). Every
 * test-cases + test-plans procedure calls this first, so the API behaves as if
 * the routes don't exist when the flag is unset. The tab itself is gated
 * client-side by `NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES`.
 *
 * Mirrors `assertAtlasEnabled` (packages/api/modules/atlas/lib.ts).
 */
export function assertTestCasesFeatureEnabled(): void {
	if (process.env.FABRIC_FEATURE_TEST_CASES !== "true") {
		throw new ORPCError("NOT_FOUND", {
			message: "Test Cases is not enabled.",
		});
	}
}
