import { assertTestCasesFeatureEnabled } from "./test-cases-feature";

/**
 * Feature gate for automated-test pipeline-result ingestion (cards 1834 / 1688).
 *
 * The dark-launch flag (`FABRIC_FEATURE_TEST_PIPELINE_RESULTS`) was dropped once
 * the feature graduated — pipeline results are part of the QA surface
 * (they attach to cases), so they now ride the base QA feature gate. An
 * environment with Test Cases enabled gets pipeline results; one without it fails
 * closed here. The client surface renders wherever the QA tab does.
 *
 * The function is kept (rather than inlining `assertTestCasesFeatureEnabled` at
 * every call site) so the procedures read as pipeline-results-gated and a future
 * re-gate is a one-line change here.
 */
export function assertPipelineResultsEnabled(): void {
	assertTestCasesFeatureEnabled();
}
