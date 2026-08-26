// Test Cases — CRUD, work-item links, coverage rollup, plans, and AI drafting.
// The `sync/*` PM-integration surface is registered separately (see the
// `testCases.sync` slot in the projects router).

export { addCaseToPlanProcedure } from "./add-case-to-plan";
export { aiDraftTestCasesProcedure } from "./ai-draft-test-cases";
export {
	bulkDeleteTestCasesProcedure,
	bulkMutateTestCasesProcedure,
} from "./bulk-mutate-test-cases";
export { cancelTestCaseDraftJobProcedure } from "./cancel-test-case-draft-job";
export { cloneTestCaseProcedure } from "./clone-test-case";
export { coverageForStoryProcedure } from "./coverage-for-story";
export {
	getCoverageIndexProcedure,
	setTestCaseCoverageTypeProcedure,
} from "./coverage-index";
export { createTestCaseProcedure } from "./create-test-case";
export { createTestPlanProcedure } from "./create-test-plan";
export { deleteTestCaseProcedure } from "./delete-test-case";
export { deleteTestPlanProcedure } from "./delete-test-plan";
export { generatePlaywrightScriptProcedure } from "./generate-playwright-script";
export { getActivityHistoryProcedure } from "./get-activity-history";
export { getResultHistoryProcedure } from "./get-result-history";
export { getTestCaseProcedure } from "./get-test-case";
export { getTestCaseDraftJobProcedure } from "./get-test-case-draft-job";
export { getTestPlanProcedure } from "./get-test-plan";
export { linkWorkItemProcedure } from "./link-work-item";
export { listFeatureCoverageProcedure } from "./list-feature-coverage";
export { listFeatureDraftRunsProcedure } from "./list-feature-draft-runs";
export { listTestCaseDraftJobsProcedure } from "./list-test-case-draft-jobs";
export { listTestCasesProcedure } from "./list-test-cases";
export { listTestPlansProcedure } from "./list-test-plans";
export {
	getPlaywrightScriptRevisionProcedure,
	listPlaywrightScriptRevisionsProcedure,
	listPlaywrightScriptSourcesProcedure,
	restorePlaywrightScriptRevisionProcedure,
} from "./playwright-script-history";
export { recordResultProcedure } from "./record-result";
export { removeCaseFromPlanProcedure } from "./remove-case-from-plan";
export { reorderPlanCasesProcedure } from "./reorder-plan-cases";
export { reorderTestCasesProcedure } from "./reorder-test-cases";
export { resetResultsProcedure } from "./reset-results";
export {
	getQaSignOffsProcedure,
	recordQaSignOffProcedure,
	revokeQaSignOffProcedure,
} from "./sign-offs";
export {
	acceptTestCaseStepsProcedure,
	listDriftedTestCasesProcedure,
	proposeTestCaseStepsFromImplementationProcedure,
	proposeTestCaseStepsProcedure,
	rejectTestCaseStepsProcedure,
} from "./test-case-drift";
export { testingSectionCountsProcedure } from "./testing-section-counts";
export { unlinkWorkItemProcedure } from "./unlink-work-item";
export { updateTestCaseProcedure } from "./update-test-case";
export { updateTestPlanProcedure } from "./update-test-plan";
