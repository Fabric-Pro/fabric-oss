import { describe, expect, it } from "vitest";
import {
	approvalProgressOf,
	approvalRefusal,
	countedApprovals,
	DEFAULT_INSTRUCTION_REVIEW_POLICY,
	reviewPolicyOfSettings,
} from "../prisma/queries/instruction-proposal-approvals";

describe("reviewPolicyOfSettings", () => {
	it("is the default, one approval and no list, when nothing is stored", () => {
		expect(reviewPolicyOfSettings(null)).toEqual(
			DEFAULT_INSTRUCTION_REVIEW_POLICY,
		);
		expect(reviewPolicyOfSettings({ ignoreGlobs: ["a/**"] })).toEqual({
			requiredApprovals: 1,
			approverUserIds: null,
		});
	});

	it("reads a stored policy and drops duplicate approvers", () => {
		expect(
			reviewPolicyOfSettings({
				reviewPolicy: {
					requiredApprovals: 3,
					approverUserIds: ["a", "b", "a", "c"],
				},
			}),
		).toEqual({ requiredApprovals: 3, approverUserIds: ["a", "b", "c"] });
	});

	it("falls back field by field on anything malformed, never blocking a review", () => {
		expect(
			reviewPolicyOfSettings({
				reviewPolicy: { requiredApprovals: 0, approverUserIds: [] },
			}),
		).toEqual(DEFAULT_INSTRUCTION_REVIEW_POLICY);
		expect(
			reviewPolicyOfSettings({
				reviewPolicy: { requiredApprovals: 2.5, approverUserIds: [7] },
			}),
		).toEqual(DEFAULT_INSTRUCTION_REVIEW_POLICY);
		expect(
			reviewPolicyOfSettings({ reviewPolicy: { requiredApprovals: 99 } }),
		).toEqual(DEFAULT_INSTRUCTION_REVIEW_POLICY);
	});
});

describe("approvalRefusal", () => {
	it("allows anyone, the proposer included, under the default policy", () => {
		expect(
			approvalRefusal({
				policy: DEFAULT_INSTRUCTION_REVIEW_POLICY,
				reviewerUserId: "author",
				proposerUserId: "author",
			}),
		).toBeNull();
	});

	it("refuses the proposer above one required approval", () => {
		expect(
			approvalRefusal({
				policy: { requiredApprovals: 2, approverUserIds: null },
				reviewerUserId: "author",
				proposerUserId: "author",
			}),
		).toBe("own_proposal");
	});

	it("refuses anyone the approver list does not name", () => {
		expect(
			approvalRefusal({
				policy: { requiredApprovals: 1, approverUserIds: ["lead"] },
				reviewerUserId: "someone",
				proposerUserId: "author",
			}),
		).toBe("not_an_approver");
	});
});

describe("countedApprovals", () => {
	it("counts the proposer's own approval only under one required approval", () => {
		expect(
			countedApprovals({
				approverUserIds: ["author"],
				proposerUserId: "author",
				policy: DEFAULT_INSTRUCTION_REVIEW_POLICY,
			}),
		).toBe(1);
		expect(
			countedApprovals({
				approverUserIds: ["author", "b"],
				proposerUserId: "author",
				policy: { requiredApprovals: 2, approverUserIds: null },
			}),
		).toBe(1);
	});

	it("counts only listed approvers once a list is set", () => {
		expect(
			countedApprovals({
				approverUserIds: ["a", "b", "c"],
				proposerUserId: "author",
				policy: { requiredApprovals: 2, approverUserIds: ["a", "c"] },
			}),
		).toBe(2);
	});
});

describe("approvalProgressOf", () => {
	it("reports the count, the requirement and everyone who approved", () => {
		expect(
			approvalProgressOf({
				approverUserIds: ["a", "author"],
				proposerUserId: "author",
				settings: { reviewPolicy: { requiredApprovals: 3 } },
			}),
		).toEqual({ count: 1, required: 3, approverUserIds: ["a", "author"] });
	});
});
