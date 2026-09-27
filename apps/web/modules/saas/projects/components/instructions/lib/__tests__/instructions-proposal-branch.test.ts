/**
 * The "Your branch" panel's policy (Fizzy #2738 spec §10 "Tab"): the branch
 * card's line, its actions, and when the panel polls.
 */
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";
import {
	branchCardLine,
	branchPanelPollInterval,
	offersBranchRefresh,
	offersClose,
	offersRetryOpening,
	offersStartOver,
	offersStopTracking,
	type ProposalBranchLite,
	type ProposalBranchState,
} from "../instructions-proposal-branch";

const branchCopy = en.projects.codingInstructions.proposalReview.branch;
const failureCopy =
	en.projects.codingInstructions.proposalReview.pullRequest.failures;

function branch(
	overrides: Partial<ProposalBranchLite> = {},
): ProposalBranchLite {
	return {
		id: "branch_1",
		ref: "fabric/instructions/members/reader-ab12/1",
		state: "OPEN",
		foreignCommits: false,
		membership: "done",
		failure: null,
		retired: false,
		pullRequest: null,
		...overrides,
	};
}

describe("branchCardLine (spec §10 Tab)", () => {
	it.each([
		"PENDING",
		"OPENING",
		"OPEN",
		"CLOSE_REQUESTED",
		"MERGED",
		"CLOSED",
		"CANCELED",
	] as const)("has copy in en.json for state %s", (state) => {
		const line = branchCardLine(branch({ state }));
		expect(line.key).toBe(`states.${state}`);
		expect((branchCopy.states as Record<string, string>)[state]).toBeTypeOf(
			"string",
		);
	});

	it("a failure replaces the state headline outright, reusing the shared failures.* copy", () => {
		const line = branchCardLine(
			branch({
				state: "BLOCKED",
				failure: { code: "PR_CREATION_REFUSED", retryable: false },
			}),
		);
		expect(line.key).toBe("failures.PR_CREATION_REFUSED");
		expect(line.tone).toBe("error");
		expect(
			(failureCopy as Record<string, string>)[
				line.key.replace("failures.", "")
			],
		).toBeTypeOf("string");
	});

	it.each([
		"PENDING",
		"OPENING",
		"OPEN",
		"CLOSE_REQUESTED",
		"MERGED",
		"CLOSED",
		"CANCELED",
	] as const)(
		"reads the de-personalized otherStates copy for state %s when readOnly (spec §10 reviewer visibility)",
		(state) => {
			const line = branchCardLine(branch({ state }), { readOnly: true });
			expect(line.key).toBe(`otherStates.${state}`);
			expect(
				(branchCopy.otherStates as Record<string, string>)[state],
			).toBeTypeOf("string");
		},
	);

	it("still reuses the shared failures.* copy when readOnly", () => {
		const line = branchCardLine(
			branch({
				state: "BLOCKED",
				failure: { code: "PR_CREATION_REFUSED", retryable: false },
			}),
			{ readOnly: true },
		);
		expect(line.key).toBe("failures.PR_CREATION_REFUSED");
	});

	it("passes a failure's params through as values, for {paths} interpolation", () => {
		const line = branchCardLine(
			branch({
				state: "BLOCKED",
				failure: {
					code: "BRANCH_NAME_UNAVAILABLE",
					retryable: false,
					params: { paths: "CLAUDE.md", count: 1 },
				},
			}),
		);
		expect(line.failureValues).toEqual({ paths: "CLAUDE.md", count: "1" });
	});
});

describe("branch actions (spec §10 Actions)", () => {
	it.each([
		["PENDING", true],
		["OPENING", true],
		["OPEN", true],
		["BLOCKED", true],
		["CLOSE_REQUESTED", false],
		["MERGED", false],
		["CLOSED", false],
		["CANCELED", false],
	] as const)("Close on %s: %s", (state, offered) => {
		expect(offersClose(branch({ state }))).toBe(offered);
	});

	it("Retry opening only on BLOCKED PR_CREATION_REFUSED", () => {
		expect(
			offersRetryOpening(
				branch({
					state: "BLOCKED",
					failure: { code: "PR_CREATION_REFUSED", retryable: false },
				}),
			),
		).toBe(true);
		expect(
			offersRetryOpening(
				branch({
					state: "BLOCKED",
					failure: { code: "BRANCH_WRITE_REFUSED", retryable: true },
				}),
			),
		).toBe(false);
		expect(offersRetryOpening(branch({ state: "OPEN" }))).toBe(false);
	});

	it("Start over only on a non-retryable CREATE_OUTCOME_UNKNOWN with no foreign commits", () => {
		expect(
			offersStartOver(
				branch({
					state: "BLOCKED",
					failure: {
						code: "CREATE_OUTCOME_UNKNOWN",
						retryable: false,
					},
				}),
			),
		).toBe(true);
		expect(
			offersStartOver(
				branch({
					state: "BLOCKED",
					failure: {
						code: "CREATE_OUTCOME_UNKNOWN",
						retryable: true,
					},
				}),
			),
		).toBe(false);
		expect(
			offersStartOver(
				branch({
					state: "BLOCKED",
					foreignCommits: true,
					failure: {
						code: "CREATE_OUTCOME_UNKNOWN",
						retryable: false,
					},
				}),
			),
		).toBe(false);
	});

	it("Stop tracking only on REPOSITORY_CHANGED, in any state", () => {
		expect(
			offersStopTracking(
				branch({
					state: "OPEN",
					failure: { code: "REPOSITORY_CHANGED", retryable: false },
				}),
			),
		).toBe(true);
		expect(offersStopTracking(branch({ state: "OPEN" }))).toBe(false);
	});

	it.each([
		["PENDING", true],
		["OPENING", true],
		["OPEN", true],
		["BLOCKED", true],
		["CLOSE_REQUESTED", true],
		["MERGED", false],
		["CLOSED", false],
		["CANCELED", false],
	] as const)("Refresh on %s: %s", (state, offered) => {
		expect(offersBranchRefresh(branch({ state }))).toBe(offered);
	});
});

describe("branchPanelPollInterval", () => {
	it("polls every 10s while any shown branch is unresolved", () => {
		for (const state of [
			"PENDING",
			"OPENING",
			"OPEN",
			"BLOCKED",
			"CLOSE_REQUESTED",
		] satisfies ProposalBranchState[]) {
			expect(branchPanelPollInterval([{ state }])).toBe(10_000);
		}
	});

	it("stops once every shown branch is settled, or there are none", () => {
		expect(branchPanelPollInterval([{ state: "MERGED" }])).toBe(false);
		expect(
			branchPanelPollInterval([
				{ state: "CLOSED" },
				{ state: "CANCELED" },
			]),
		).toBe(false);
		expect(branchPanelPollInterval([])).toBe(false);
		expect(branchPanelPollInterval(undefined)).toBe(false);
	});
});
