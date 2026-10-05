/**
 * What a move of uploaded instructions into a repository looks like to a
 * client (Fizzy #2878 §9): the two stored states plus the four derived from
 * the move's proposal and its branch.
 */
import { describe, expect, it } from "vitest";
import {
	repositoryMigrationState,
	repositoryMigrationView,
} from "../migration-view";

const POINTER = {
	v: 1 as const,
	state: "PROPOSING" as const,
	branchId: "branch_1",
	snapshotId: "snap_move",
	syncId: "sync_1",
	pullRequestUrl: null,
	startedAt: "2026-10-03T10:00:00.000Z",
	userId: "user_1",
};

type Proposal = Parameters<typeof repositoryMigrationView>[1];

function proposal(over: Record<string, unknown> = {}): NonNullable<Proposal> {
	return {
		operationId: "op_1",
		state: "OPEN",
		url: "https://github.com/example-org/instructions/pull/7",
		externalId: "7",
		failure: null,
		lastCheckedAt: null,
		branch: null,
		append: null,
		...over,
	} as NonNullable<Proposal>;
}

describe("repositoryMigrationState", () => {
	it("is SWITCHING for a stored switching move, whatever the pull request says", () => {
		expect(
			repositoryMigrationState(
				{ state: "SWITCHING" },
				proposal({ state: "MERGED" }),
			),
		).toBe("SWITCHING");
	});

	it("is PROPOSING while there is no proposal row yet", () => {
		expect(repositoryMigrationState({ state: "PROPOSING" }, null)).toBe(
			"PROPOSING",
		);
	});

	it.each([
		["QUEUED", null, "PROPOSING"],
		["OPENING", null, "PROPOSING"],
		[
			"QUEUED",
			{ code: "BRANCH_WRITE_REFUSED", retryable: true },
			"BLOCKED",
		],
		[
			"OPENING",
			{ code: "AUTHENTICATION_FAILED", retryable: true },
			"BLOCKED",
		],
		["OPEN", null, "OPEN"],
		["CLOSE_REQUESTED", null, "OPEN"],
		[
			"BLOCKED",
			{ code: "PR_CREATION_REFUSED", retryable: false },
			"BLOCKED",
		],
		["MERGED", null, "MERGED"],
		["CLOSED", null, "ABANDONED"],
		["CANCELED", null, "ABANDONED"],
	])(
		"reads a proposal that is %s with failure %j as %s",
		(state, failure, expected) => {
			expect(
				repositoryMigrationState(
					{ state: "PROPOSING" },
					proposal({ state, failure }),
				),
			).toBe(expected);
		},
	);

	it("takes the failure from the branch when the proposal has none", () => {
		expect(
			repositoryMigrationState(
				{ state: "PROPOSING" },
				proposal({
					state: "QUEUED",
					branch: {
						failure: {
							code: "BRANCH_WRITE_REFUSED",
							retryable: true,
						},
					},
				}),
			),
		).toBe("BLOCKED");
	});
});

describe("repositoryMigrationView", () => {
	it("is the contract a client reads: state, who and when, the ids, the pull request and the failure", () => {
		const view = repositoryMigrationView(POINTER, proposal(), "branch_1");

		expect(view).toEqual({
			state: "OPEN",
			closing: false,
			startedAt: "2026-10-03T10:00:00.000Z",
			startedByUserId: "user_1",
			snapshotId: "snap_move",
			branchId: "branch_1",
			syncId: "sync_1",
			pullRequest: {
				url: "https://github.com/example-org/instructions/pull/7",
				externalId: "7",
				state: "OPEN",
			},
			targetMismatch: false,
			failure: null,
		});
	});

	describe("what only the project and the branch can say", () => {
		const flipped = { sourceFlipped: true, targetMismatch: false };
		const mismatch = { sourceFlipped: false, targetMismatch: true };

		it("reads a proposing move whose project was flipped to the repository as BLOCKED, SOURCE_FLIPPED, whatever its pull request says", () => {
			for (const state of [
				"QUEUED",
				"OPEN",
				"MERGED",
				"CLOSED",
			] as const) {
				const view = repositoryMigrationView(
					POINTER,
					proposal({ state }),
					"branch_1",
					flipped,
				);

				expect(view.state).toBe("BLOCKED");
				expect(view.failure).toEqual({
					code: "SOURCE_FLIPPED",
					retryable: false,
				});
			}
		});

		it("lets a switching move be switching: the flip is the move's own", () => {
			const view = repositoryMigrationView(
				{ ...POINTER, state: "SWITCHING" },
				proposal({ state: "MERGED" }),
				"branch_1",
				flipped,
			);

			expect(view.state).toBe("SWITCHING");
			expect(view.failure).toBeNull();
		});

		it("reads a pull request merged into another branch as ABANDONED and says so, rather than MERGED", () => {
			const view = repositoryMigrationView(
				POINTER,
				proposal({ state: "MERGED" }),
				"branch_1",
				mismatch,
			);

			expect(view).toMatchObject({
				state: "ABANDONED",
				targetMismatch: true,
				pullRequest: { state: "MERGED" },
			});
		});

		it("does not read an open or closed pull request as merged elsewhere", () => {
			for (const state of ["OPEN", "CLOSED"] as const) {
				const view = repositoryMigrationView(
					POINTER,
					proposal({ state }),
					"branch_1",
					mismatch,
				);

				expect(view.state).toBe(
					state === "OPEN" ? "OPEN" : "ABANDONED",
				);
			}
		});

		it("defaults to no evidence: the state a move's own rows give", () => {
			const view = repositoryMigrationView(
				POINTER,
				proposal({ state: "MERGED" }),
				"branch_1",
			);

			expect(view.state).toBe("MERGED");
			expect(view.targetMismatch).toBe(false);
		});
	});

	it("says the pull request is closing while its close settles, and stays OPEN", () => {
		const view = repositoryMigrationView(
			POINTER,
			proposal({ state: "CLOSE_REQUESTED" }),
			"branch_1",
		);

		expect(view).toMatchObject({ state: "OPEN", closing: true });
	});

	it("gives a typed failure and nothing else of it: never a phase's params or a time", () => {
		const view = repositoryMigrationView(
			POINTER,
			proposal({
				state: "BLOCKED",
				failure: {
					code: "PR_CREATION_REFUSED",
					retryable: false,
					phase: "create",
					at: "2026-10-03T10:00:00.000Z",
					params: { detail: "x" },
				},
			}),
			"branch_1",
		);

		expect(view.failure).toEqual({
			code: "PR_CREATION_REFUSED",
			retryable: false,
		});
	});

	it("takes the pull request's own state from its branch when there is one", () => {
		const view = repositoryMigrationView(
			POINTER,
			proposal({
				state: "OPEN",
				branch: { pullRequest: { state: "MERGED" }, failure: null },
			}),
			"branch_1",
		);

		expect(view.pullRequest?.state).toBe("MERGED");
	});

	it("has no pull request before one exists, and keeps the address the pointer recorded after the merge", () => {
		expect(
			repositoryMigrationView(POINTER, null, null).pullRequest,
		).toBeNull();
		expect(
			repositoryMigrationView(
				{
					...POINTER,
					state: "SWITCHING",
					pullRequestUrl: "https://example.com/pull/7",
				},
				proposal({ url: null, externalId: "7", state: "MERGED" }),
				"branch_1",
			).pullRequest,
		).toEqual({
			url: "https://example.com/pull/7",
			externalId: "7",
			state: "MERGED",
		});
	});

	it("reports the branch the proposal is on now, not the pointer's", () => {
		expect(
			repositoryMigrationView(POINTER, proposal(), "branch_2").branchId,
		).toBe("branch_2");
	});
});
