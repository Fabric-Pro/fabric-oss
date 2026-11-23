/**
 * The Proposal Inbox's duplicate verifier on a spent ChatGPT plan: the run
 * waits for the estimated reset and verifies once more, as the roadmap's
 * automatic duplicate check does. Any other failure is not waited on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verify: vi.fn(),
	estimate: vi.fn(),
	sleep: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	patched: () => true,
	sleep: mocks.sleep,
	workflowInfo: () => ({ workflowId: "inbox-dup-verify-p", runId: "r" }),
	proxyActivities: () => ({
		verifyInboxDuplicatesActivity: mocks.verify,
		estimatePlanPoolResetActivity: mocks.estimate,
		notifyPlanWaitWorkStoppedActivity: vi.fn(),
	}),
}));

import { verifyInboxDuplicatesWorkflow } from "../verify-inbox-duplicates";

const HOUR = 60 * 60_000;

const input = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	pairs: [],
};

/** A spent plan, as the workflow receives the activity's failure. */
const planSpent = Object.assign(new Error("every plan is spent"), {
	name: "ActivityFailure",
	cause: { type: "SubscriptionPlanExhaustedError" },
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sleep.mockResolvedValue(undefined);
	mocks.estimate.mockResolvedValue({
		waitMs: HOUR,
		jitterMs: 0,
		resetKnown: true,
	});
});

describe("verifyInboxDuplicatesWorkflow", () => {
	it("waits for the plan reset and verifies once more", async () => {
		mocks.verify.mockRejectedValueOnce(planSpent).mockResolvedValueOnce({});

		await verifyInboxDuplicatesWorkflow(input);

		expect(mocks.estimate).toHaveBeenCalledWith({
			organizationId: "org-1",
			userId: "user-1",
		});
		expect(mocks.sleep).toHaveBeenCalledWith(HOUR);
		expect(mocks.verify).toHaveBeenCalledTimes(2);
		expect(mocks.verify).toHaveBeenNthCalledWith(2, input);
	});

	it("does not wait on any other failure", async () => {
		mocks.verify.mockRejectedValue(new Error("verifier failed"));

		await expect(verifyInboxDuplicatesWorkflow(input)).rejects.toThrow(
			"verifier failed",
		);
		expect(mocks.estimate).not.toHaveBeenCalled();
		expect(mocks.verify).toHaveBeenCalledTimes(1);
	});
});
