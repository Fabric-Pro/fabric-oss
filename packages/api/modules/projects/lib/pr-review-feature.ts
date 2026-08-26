import { assertTestCasesFeatureEnabled } from "./test-cases-feature";

/**
 * Feature gate for AI PR review (the pull-request review work).
 *
 * Rides the base QA feature gate for the same reason pipeline results do: the
 * surface lives inside the Testing tab, so an environment where that tab is
 * hidden must not expose procedures the UI has no way to reach. Failing closed
 * here keeps server and surface in agreement rather than leaving an endpoint
 * live behind a hidden page.
 *
 * Kept as its own function — rather than inlining the QA gate at each call site
 * — so the procedures read as PR-review-gated and giving this feature its own
 * flag later is a one-line change here.
 */
export function assertPrReviewEnabled(): void {
	assertTestCasesFeatureEnabled();
}
