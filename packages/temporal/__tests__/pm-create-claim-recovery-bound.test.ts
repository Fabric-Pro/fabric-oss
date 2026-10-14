/**
 * The recovery bound and the send ceiling it is derived from stay apart: a
 * user's recovery (Link to existing item, Unlink & re-create) clears a held
 * PM create claim only once it is older than
 * PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS, which must stay well past
 * PM_CREATE_SEND_TIMEOUT_MS, the longest a claim's holder can still send its
 * create. And the ceiling stays under the start-to-close of every workflow
 * activity that sends a create, read from the options the workflows pass to
 * `proxyActivities`, so the activity can report a send that ran to it.
 */
import { PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS } from "@repo/database";
import { msToNumber } from "@temporalio/common/lib/time";
import { describe, expect, it } from "vitest";
import { PM_CREATE_SEND_TIMEOUT_MS } from "../src/activities/pm-integration/pm-create-claim";
import {
	BACKLOG_APPLY_SYNC_ACTIVITY_OPTIONS,
	PM_SYNC_SINGLE_STORY_SYNC_ACTIVITY_OPTIONS,
	STORY_SYNC_CREATE_ACTIVITY_OPTIONS,
	TEST_CASE_SYNC_CREATE_ACTIVITY_OPTIONS,
} from "../src/workflows/pm-create-activity-options";

const CREATE_ACTIVITY_OPTIONS = {
	"storySyncWorkflow createStoryInPmWithClaim":
		STORY_SYNC_CREATE_ACTIVITY_OPTIONS,
	"testCaseSyncWorkflow createTestCaseInPmWithClaim":
		TEST_CASE_SYNC_CREATE_ACTIVITY_OPTIONS,
	"pmSyncSingleStoryWorkflow syncWorkItemToPM":
		PM_SYNC_SINGLE_STORY_SYNC_ACTIVITY_OPTIONS,
	"backlogApplyChangesWorkflow syncWorkItemToPM":
		BACKLOG_APPLY_SYNC_ACTIVITY_OPTIONS,
};

describe("PM create claim recovery bound", () => {
	it.each(Object.entries(CREATE_ACTIVITY_OPTIONS))(
		"the send ceiling sits under %s's start-to-close",
		(_label, options) => {
			const startToClose = options.startToCloseTimeout;
			expect(startToClose).toBeDefined();
			expect(PM_CREATE_SEND_TIMEOUT_MS).toBeLessThan(
				msToNumber(startToClose as NonNullable<typeof startToClose>),
			);
		},
	);

	it("the recovery bound exceeds the send ceiling by at least two minutes of margin", () => {
		expect(
			PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS - PM_CREATE_SEND_TIMEOUT_MS,
		).toBeGreaterThanOrEqual(2 * 60_000);
	});
});
