/**
 * The "Your branch" panel's policy (Fizzy #2738 spec §10 "Tab"): the branch
 * card's line, its actions, and when the panel polls.
 */
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";
import {
	branchCardLine,
	branchPanelPollInterval,
	inFlightRowStates,
	listInFlightStates,
	nextTransitionSince,
	offersBranchRefresh,
	offersClose,
	offersRetryOpening,
	offersStartOver,
	offersStopTracking,
	type ProposalBranchLite,
	type ProposalBranchState,
	TRANSITION_POLL_MS,
	TRANSITION_POLL_WINDOW_MS,
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

const openPr = {
	url: "https://github.com/example-org/example-repo/pull/9",
	externalId: "9",
	state: "OPEN",
	lastCheckedAt: null,
} as const;

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
		const line = branchCardLine(branch({ state, pullRequest: openPr }));
		expect(line.key).toBe(`states.${state}`);
		expect((branchCopy.states as Record<string, string>)[state]).toBeTypeOf(
			"string",
		);
	});

	it.each([
		[
			false,
			"states.CLOSE_REQUESTED_NO_PR",
			"otherStates.CLOSE_REQUESTED_NO_PR",
		],
		[true, "states.CLOSE_REQUESTED", "otherStates.CLOSE_REQUESTED"],
	])(
		"a closing branch with pullRequest=%s reads %s (%s when readOnly)",
		(hasPr, own, other) => {
			const closing = branch({
				state: "CLOSE_REQUESTED",
				pullRequest: hasPr ? openPr : null,
			});
			expect(branchCardLine(closing).key).toBe(own);
			expect(branchCardLine(closing, { readOnly: true }).key).toBe(other);
			expect(
				(branchCopy.states as Record<string, string>)[
					own.replace("states.", "")
				],
			).toBeTypeOf("string");
			expect(
				(branchCopy.otherStates as Record<string, string>)[
					other.replace("otherStates.", "")
				],
			).toBeTypeOf("string");
		},
	);

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
			const line = branchCardLine(
				branch({ state, pullRequest: openPr }),
				{
					readOnly: true,
				},
			);
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

describe("fast poll while a branch is in flight", () => {
	it("polls every 2s for PENDING, OPENING and CLOSE_REQUESTED inside the window", () => {
		for (const state of [
			"PENDING",
			"OPENING",
			"CLOSE_REQUESTED",
		] satisfies ProposalBranchState[]) {
			expect(
				branchPanelPollInterval([{ state }], 1_000, 1_000 + 5_000),
			).toBe(TRANSITION_POLL_MS);
		}
	});

	it("keeps 10s for steady unresolved states even inside the window", () => {
		for (const state of [
			"OPEN",
			"BLOCKED",
		] satisfies ProposalBranchState[]) {
			expect(branchPanelPollInterval([{ state }], 1_000, 2_000)).toBe(
				10_000,
			);
		}
	});

	it("falls back to 10s once the window has passed", () => {
		expect(
			branchPanelPollInterval(
				[{ state: "OPENING" }],
				1_000,
				1_000 + TRANSITION_POLL_WINDOW_MS,
			),
		).toBe(10_000);
	});

	it("tracks when a run of in-flight branches began", () => {
		expect(nextTransitionSince(null, [{ state: "OPENING" }], 50)).toBe(50);
		expect(
			nextTransitionSince(50, [{ state: "CLOSE_REQUESTED" }], 90),
		).toBe(50);
		expect(nextTransitionSince(50, [{ state: "OPEN" }], 90)).toBeNull();
		expect(nextTransitionSince(50, undefined, 90)).toBeNull();
	});
});

describe("inFlightRowStates (proposal list rows)", () => {
	it("maps QUEUED, OPENING and CLOSE_REQUESTED rows to their branch-like states", () => {
		expect(
			inFlightRowStates([
				{ pullRequest: { state: "QUEUED" } },
				{ pullRequest: { state: "OPENING" } },
				{ pullRequest: { state: "CLOSE_REQUESTED" } },
			]),
		).toEqual([
			{ state: "PENDING" },
			{ state: "OPENING" },
			{ state: "CLOSE_REQUESTED" },
		]);
	});

	it("ignores steady, settled and pull-request-less rows", () => {
		expect(
			inFlightRowStates([
				{ pullRequest: { state: "OPEN" } },
				{ pullRequest: { state: "BLOCKED" } },
				{ pullRequest: { state: "CLOSED" } },
				{ pullRequest: null },
				{},
			]),
		).toEqual([]);
		expect(inFlightRowStates(undefined)).toEqual([]);
	});

	it("drives the 2s rule inside the window and hands back to the steady poll after it", () => {
		const rows = [{ pullRequest: { state: "CLOSE_REQUESTED" } }];
		expect(
			branchPanelPollInterval(inFlightRowStates(rows), 1_000, 4_000),
		).toBe(TRANSITION_POLL_MS);
		expect(
			branchPanelPollInterval(
				inFlightRowStates(rows),
				1_000,
				1_000 + TRANSITION_POLL_WINDOW_MS,
			),
		).toBe(10_000);
	});
});

describe("listInFlightStates (member proposal list)", () => {
	const onYourBranch = [
		{ pullRequest: { state: "OPEN" } },
		{ pullRequest: { state: "OPEN" } },
	];

	it("polls at 2s while the branch is in flight even if every row reads steady", () => {
		for (const state of [
			"PENDING",
			"OPENING",
			"CLOSE_REQUESTED",
		] satisfies ProposalBranchState[]) {
			const shown = listInFlightStates(onYourBranch, [{ state }]);
			expect(branchPanelPollInterval(shown, 1_000, 4_000)).toBe(
				TRANSITION_POLL_MS,
			);
		}
	});

	it("does not speed up for a steady or settled branch with steady rows", () => {
		for (const state of [
			"OPEN",
			"BLOCKED",
			"CLOSED",
		] satisfies ProposalBranchState[]) {
			expect(listInFlightStates(onYourBranch, [{ state }])).toEqual([]);
		}
		expect(listInFlightStates(onYourBranch, undefined)).toEqual([]);
	});

	it("falls back after the window", () => {
		const shown = listInFlightStates(onYourBranch, [{ state: "OPENING" }]);
		expect(
			branchPanelPollInterval(
				shown,
				1_000,
				1_000 + TRANSITION_POLL_WINDOW_MS,
			),
		).toBe(10_000);
	});
});
