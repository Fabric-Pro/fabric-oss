/**
 * The pure planners of a member branch's settlement (Fizzy #2738 spec §6.6
 * step 3 and Decision 14, §6.7 step 4): what classification and a
 * no-pull-request settlement do to each non-terminal proposal on the
 * branch, and to a proposal CANCELED by an established revert that the pull
 * request raced. Every identifier is synthetic.
 */
import { describe, expect, it } from "vitest";
import {
	type ClassificationOp,
	type ClassificationProposal,
	planBranchCancellation,
	planBranchClassification,
} from "../prisma/queries/instruction-proposal-branch-settlement";

const BRANCH = "branch_example";
const OTHER = "branch_other";

let seq = 0;
function op(
	snapshotId: string,
	kind: "APPEND" | "REVERT",
	outcome: ClassificationOp["outcome"],
	membership: "included" | "unverified" | null = null,
	over: Partial<ClassificationOp> = {},
): ClassificationOp {
	seq++;
	return {
		id: `op_${seq}`,
		snapshotId,
		kind,
		executionSeq: seq,
		assignment: 1,
		branchId: BRANCH,
		outcome,
		membership,
		...over,
	};
}

function proposal(
	snapshotId: string,
	over: Partial<ClassificationProposal> = {},
): ClassificationProposal {
	return {
		snapshotId,
		state: "OPEN",
		assignment: 1,
		withdrawRequestedAt: null,
		...over,
	};
}

const WITHDRAWN = new Date("2026-09-26T12:00:00.000Z");

function classify(
	outcome: "MERGED" | "CLOSED",
	ops: ClassificationOp[],
	proposals: ClassificationProposal[],
) {
	return planBranchClassification({
		branchId: BRANCH,
		outcome,
		ops,
		proposals,
	});
}

describe("planBranchClassification (spec §6.6 step 3, Decision 14)", () => {
	it("an included append takes the pull request's outcome", () => {
		expect(
			classify(
				"MERGED",
				[op("snap_a", "APPEND", "acked", "included")],
				[proposal("snap_a")],
			),
		).toEqual([{ snapshotId: "snap_a", to: "MERGED", reason: "outcome" }]);
	});

	it("an unverified append takes the outcome with reason unverified (Propose again on the card)", () => {
		expect(
			classify(
				"CLOSED",
				[op("snap_a", "APPEND", "observed", "unverified")],
				[proposal("snap_a")],
			),
		).toEqual([
			{ snapshotId: "snap_a", to: "CLOSED", reason: "unverified" },
		]);
	});

	it("a current append or withdrawal unknown takes the outcome, unverified (§4.3 unresolved push)", () => {
		expect(
			classify(
				"MERGED",
				[
					op("snap_a", "APPEND", "unknown"),
					op("snap_b", "APPEND", "acked", "included"),
					op("snap_b", "REVERT", "unknown"),
				],
				[
					proposal("snap_a", { state: "BLOCKED" }),
					proposal("snap_b", { state: "CLOSE_REQUESTED" }),
				],
			),
		).toEqual([
			{ snapshotId: "snap_a", to: "MERGED", reason: "unverified" },
			{ snapshotId: "snap_b", to: "MERGED", reason: "unverified" },
		]);
	});

	it("an append and its established revert both included: CANCELED (reverted)", () => {
		expect(
			classify(
				"MERGED",
				[
					op("snap_a", "APPEND", "acked", "included"),
					op("snap_a", "REVERT", "acked", "included"),
				],
				[proposal("snap_a", { state: "CLOSE_REQUESTED" })],
			),
		).toEqual([
			{ snapshotId: "snap_a", to: "CANCELED", reason: "reverted" },
		]);
	});

	it("an included append whose established revert is not included takes the outcome", () => {
		expect(
			classify(
				"MERGED",
				[
					op("snap_a", "APPEND", "acked", "included"),
					op("snap_a", "REVERT", "acked", "unverified"),
				],
				[proposal("snap_a", { state: "CLOSE_REQUESTED" })],
			),
		).toEqual([{ snapshotId: "snap_a", to: "MERGED", reason: "outcome" }]);
	});

	describe("a merge racing the revert (Decision 14, spec line 869)", () => {
		const canceled = (snapshotId: string) =>
			proposal(snapshotId, {
				state: "CANCELED",
				withdrawRequestedAt: WITHDRAWN,
			});

		it.each(["MERGED", "CLOSED"] as const)(
			"a CANCELED proposal whose append is included and whose established revert is not takes %s",
			(outcome) => {
				expect(
					classify(
						outcome,
						[
							op("snap_a", "APPEND", "acked", "included"),
							op("snap_a", "REVERT", "observed", "unverified"),
						],
						[canceled("snap_a")],
					),
				).toEqual([
					{ snapshotId: "snap_a", to: outcome, reason: "outcome" },
				]);
			},
		);

		it("stays CANCELED when its append and its revert are both included", () => {
			expect(
				classify(
					"MERGED",
					[
						op("snap_a", "APPEND", "acked", "included"),
						op("snap_a", "REVERT", "acked", "included"),
					],
					[canceled("snap_a")],
				),
			).toEqual([]);
		});

		it("stays CANCELED when its append is not included, as before the branch settled (§4.3)", () => {
			expect(
				classify(
					"MERGED",
					[
						op("snap_a", "APPEND", "acked", "unverified"),
						op("snap_a", "REVERT", "acked", "unverified"),
						op("snap_b", "APPEND", "unknown"),
						op("snap_b", "REVERT", "acked", "unverified"),
					],
					[canceled("snap_a"), canceled("snap_b")],
				),
			).toEqual([]);
		});

		it("stays CANCELED unless its current withdrawal is a decided, established revert", () => {
			expect(
				classify(
					"MERGED",
					[
						// No withdrawal at all.
						op("snap_a", "APPEND", "acked", "included"),
						// The revert is unknown, still issued, or not pushed.
						op("snap_b", "APPEND", "acked", "included"),
						op("snap_b", "REVERT", "unknown"),
						op("snap_c", "APPEND", "acked", "included"),
						op("snap_c", "REVERT", null),
						op("snap_d", "APPEND", "acked", "included"),
						op("snap_d", "REVERT", "not_pushed"),
						// Established, its membership not yet decided.
						op("snap_e", "APPEND", "acked", "included"),
						op("snap_e", "REVERT", "acked", null),
						// The revert precedes the current append.
						op("snap_f", "REVERT", "acked", "unverified"),
						op("snap_f", "APPEND", "acked", "included"),
					],
					[
						"snap_a",
						"snap_b",
						"snap_c",
						"snap_d",
						"snap_e",
						"snap_f",
					].map(canceled),
				),
			).toEqual([]);
		});

		it("reads only its current submission: a revert under another assignment or branch does not count", () => {
			expect(
				classify(
					"MERGED",
					[
						op("snap_a", "APPEND", "acked", "included", {
							assignment: 2,
						}),
						op("snap_a", "REVERT", "acked", "unverified", {
							assignment: 1,
						}),
						op("snap_b", "APPEND", "acked", "included"),
						op("snap_b", "REVERT", "acked", "unverified", {
							branchId: OTHER,
						}),
					],
					[
						{ ...canceled("snap_a"), assignment: 2 },
						canceled("snap_b"),
					],
				),
			).toEqual([]);
		});

		it("never moves a MERGED or CLOSED proposal", () => {
			expect(
				classify(
					"CLOSED",
					[
						op("snap_a", "APPEND", "acked", "included"),
						op("snap_a", "REVERT", "acked", "unverified"),
						op("snap_b", "APPEND", "acked", "included"),
						op("snap_b", "REVERT", "acked", "unverified"),
					],
					[
						proposal("snap_a", { state: "MERGED" }),
						proposal("snap_b", { state: "CLOSED" }),
					],
				),
			).toEqual([]);
		});
	});

	it("an operation still issued leaves its proposal to recovery", () => {
		expect(
			classify(
				"MERGED",
				[
					op("snap_a", "APPEND", null),
					op("snap_b", "APPEND", "acked", "included"),
					op("snap_b", "REVERT", null),
				],
				[
					proposal("snap_a", { state: "OPENING" }),
					proposal("snap_b", { state: "CLOSE_REQUESTED" }),
				],
			),
		).toEqual([]);
	});

	it("never appended here: CANCELED when its intent was withdrawn, left for rehome otherwise", () => {
		expect(
			classify(
				"CLOSED",
				[],
				[
					proposal("snap_a", {
						state: "QUEUED",
						withdrawRequestedAt: WITHDRAWN,
					}),
					proposal("snap_b", { state: "QUEUED" }),
				],
			),
		).toEqual([
			{ snapshotId: "snap_a", to: "CANCELED", reason: "withdrawn" },
		]);
	});

	it("a not_pushed append is no append: the proposal is decided as never appended", () => {
		expect(
			classify(
				"MERGED",
				[op("snap_a", "APPEND", "not_pushed")],
				[proposal("snap_a", { state: "BLOCKED" })],
			),
		).toEqual([]);
	});

	it("only the current submission decides: another assignment's or branch's operations are ignored", () => {
		expect(
			classify(
				"MERGED",
				[
					op("snap_a", "APPEND", "acked", "included", {
						assignment: 1,
					}),
					op("snap_b", "APPEND", "acked", "included", {
						branchId: OTHER,
					}),
				],
				[
					proposal("snap_a", { state: "QUEUED", assignment: 2 }),
					proposal("snap_b", { state: "QUEUED" }),
				],
			),
		).toEqual([]);
	});
});

describe("planBranchCancellation (spec §6.7 step 4, no pull request)", () => {
	it("cancels every withdrawn proposal and leaves the ones holding intent (Start over rehomes them)", () => {
		expect(
			planBranchCancellation({
				proposals: [
					proposal("snap_a", { withdrawRequestedAt: WITHDRAWN }),
					proposal("snap_b"),
					proposal("snap_c", {
						state: "BLOCKED",
						withdrawRequestedAt: WITHDRAWN,
					}),
				],
			}),
		).toEqual([
			{ snapshotId: "snap_a", to: "CANCELED", reason: "withdrawn" },
			{ snapshotId: "snap_c", to: "CANCELED", reason: "withdrawn" },
		]);
	});
});
