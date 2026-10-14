/**
 * The `proxyActivities` options of every workflow activity that sends a PM
 * create under the PM create claim (Fizzy #3045), one constant per workflow
 * that proxies one. Each workflow passes its constant to `proxyActivities`
 * as it is, so these are the options the activities run under.
 *
 * Kept here, pure constants with no imports at runtime, so the test that
 * holds the create's send ceiling (`PM_CREATE_SEND_TIMEOUT_MS`) under each
 * activity's start-to-close
 * (`packages/temporal/__tests__/pm-create-claim-recovery-bound.test.ts`)
 * reads the real values: changing a start-to-close here changes it in the
 * workflow, and that test fails if it falls to the ceiling or below.
 * Moving them here changed no value and no command a workflow issues.
 */
import type { ActivityOptions } from "@temporalio/workflow";

/** `storySyncWorkflow`'s `createStoryInPmWithClaim` (bulk story push). */
export const STORY_SYNC_CREATE_ACTIVITY_OPTIONS: ActivityOptions = {
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
};

/** `testCaseSyncWorkflow`'s `createTestCaseInPmWithClaim` (test-case push). */
export const TEST_CASE_SYNC_CREATE_ACTIVITY_OPTIONS: ActivityOptions = {
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
};

/**
 * `pmSyncSingleStoryWorkflow`'s `syncWorkItemToPM` (single-item push: auto
 * push, retry, Unlink & re-create), whose create may also run on the GitLab
 * REST path (`syncGitLabStoryViaRest`).
 */
export const PM_SYNC_SINGLE_STORY_SYNC_ACTIVITY_OPTIONS: ActivityOptions = {
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		nonRetryableErrorTypes: [
			"PmAuthError",
			"PmNotFoundError",
			"PmCapabilitiesError",
			"PmCreateError",
			"PmUpdateError",
			"PmStampError",
		],
	},
};

/** `backlogApplyChangesWorkflow`'s `syncWorkItemToPM` (applied backlog changes). */
export const BACKLOG_APPLY_SYNC_ACTIVITY_OPTIONS: ActivityOptions = {
	startToCloseTimeout: "60 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		nonRetryableErrorTypes: [
			"PmAuthError",
			"PmNotFoundError",
			"PmCapabilitiesError",
			"PmCreateError",
			"PmUpdateError",
			"PmStampError",
		],
	},
};
