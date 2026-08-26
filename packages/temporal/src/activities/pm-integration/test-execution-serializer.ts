/**
 * Test-execution PM serializer (the run-result PUSH mapping contract).
 *
 * PURE module: imports NOTHING at runtime (mirrors `test-case-serializer.ts`) so
 * the deterministic `testCaseSyncWorkflow` can import the PUSH mapping from one
 * source of truth.
 *
 * PUSH: `mapTestResultToAdoOutcome` + `buildAdoTestResultPayload` turn a Fabric
 * case's current result into the Azure DevOps Test Results shape. Azure DevOps is
 * the only provider with a native executions API this phase; a future provider
 * plugs in by extending these maps.
 *
 * The live ADO Test Results POST is DEFERRED (see `pushTestCaseExecutionToPM`);
 * the mapping below is real and unit-tested.
 */

/** The Fabric run-result vocabulary (mirrors the Prisma `TestResult` enum). */
export type TestResultValue =
	| "NOT_RUN"
	| "PASSED"
	| "FAILED"
	| "BLOCKED"
	| "SKIPPED";

/**
 * Map a Fabric result to the Azure DevOps Test outcome vocabulary
 * (`Microsoft.VSTS…` / Test Results REST `outcome`). ADO's enum includes
 * Passed / Failed / Blocked / NotExecuted among others; NOT_RUN maps to
 * `NotExecuted` (the case has no recorded run).
 *
 * SKIPPED maps to ADO's own `NotApplicable`, NOT to `NotExecuted`: ADO
 * distinguishes "nobody ran it yet" from "this one does not apply to this run",
 * and a deliberate skip is the latter. Collapsing the two would make a suite
 * that skips by design look permanently un-run on the ADO side.
 */
export function mapTestResultToAdoOutcome(result: TestResultValue): string {
	switch (result) {
		case "PASSED":
			return "Passed";
		case "FAILED":
			return "Failed";
		case "BLOCKED":
			return "Blocked";
		case "SKIPPED":
			return "NotApplicable";
		default:
			return "NotExecuted";
	}
}

/** The Azure DevOps Test Result payload we would POST for a single case. */
export interface AdoTestResultPayload {
	/** The linked ADO Test Case work-item id (Fabric `externalId`). */
	testCaseId: string;
	/** ADO outcome vocabulary (Passed/Failed/Blocked/NotExecuted). */
	outcome: string;
	/** Optional short comment carried onto the result. */
	comment?: string;
	/** The Fabric result the outcome was derived from (round-trip aid). */
	sourceResult: TestResultValue;
}

/**
 * Build the Azure DevOps Test Result payload for a case's current result. This
 * is the real, unit-tested mapping; the thin activity that POSTs it to the ADO
 * Test Results REST API is DEFERRED (see `pushTestCaseExecutionToPM`).
 */
export function buildAdoTestResultPayload(opts: {
	externalId: string;
	result: TestResultValue;
	comment?: string | null;
}): AdoTestResultPayload {
	return {
		testCaseId: opts.externalId,
		outcome: mapTestResultToAdoOutcome(opts.result),
		...(opts.comment ? { comment: opts.comment } : {}),
		sourceResult: opts.result,
	};
}
