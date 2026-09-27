/**
 * A member branch proposal's withdrawal, decided (Fizzy #2738 spec Decision
 * 10, §4.3 "Withdraw" rows, §6.8 "Request"). Pure: `decideBranchWithdraw`
 * reads the proposal, its branch, the branch's journal and the branch's
 * other non-terminal proposals, and names the one write to make.
 * `instruction-admission-branch.integration.test.ts` runs the writes.
 */
import { describe, expect, it } from "vitest";
import type { OpOutcome } from "../prisma/queries/instruction-proposal-branch-evidence";
import {
	decideBranchWithdraw,
	type WithdrawOp,
} from "../prisma/queries/instructions";

const B = "branch_1";
const ME = "snap_me";
const OTHER = "snap_other";

const op = (
	executionSeq: number,
	kind: "APPEND" | "REVERT",
	outcome: OpOutcome,
	paths: string[],
	snapshotId = ME,
	assignment = 1,
): WithdrawOp => ({
	id: `op${executionSeq}`,
	snapshotId,
	kind,
	executionSeq,
	assignment,
	branchId: B,
	outcome,
	paths,
});

type Proposal = Parameters<typeof decideBranchWithdraw>[0]["proposal"];
type Other = Parameters<typeof decideBranchWithdraw>[0]["others"][number];

const me = (over: Partial<Proposal> = {}): Proposal => ({
	id: ME,
	state: "OPEN",
	proposalStatus: "PENDING",
	status: "READY",
	failure: null,
	withdrawRequestedAt: null,
	withdrawScope: null,
	branchId: B,
	assignment: 1,
	...over,
});

const other = (over: Partial<Other> = {}): Other => ({
	id: OTHER,
	state: "QUEUED",
	failure: null,
	withdrawRequestedAt: null,
	withdrawScope: null,
	branchId: B,
	assignment: 1,
	...over,
});

const branch = (
	over: Partial<
		NonNullable<Parameters<typeof decideBranchWithdraw>[0]["branch"]>
	> = {},
) => ({
	state: "OPEN",
	closeIntent: null,
	untracked: false,
	nextExecutionSeq: 7,
	...over,
});

const failure = (code: string, phase: string, retryable: boolean) => ({
	code,
	phase,
	retryable,
	at: "2026-09-27T00:00:00.000Z",
	params: {},
});

const decide = (
	proposal: Proposal,
	ops: WithdrawOp[] = [],
	others: Other[] = [],
	b: ReturnType<typeof branch> | null = branch(),
) => decideBranchWithdraw({ proposal, branch: b, ops, others });

describe("withdraw, not appended (spec §4.3): CANCELED", () => {
	it("cancels a QUEUED proposal not yet on a branch", () => {
		expect(
			decide(me({ state: "QUEUED", branchId: null }), [], [], null),
		).toEqual({ kind: "cancel" });
	});

	it("cancels a QUEUED proposal whose queued retry stands on an unknown push", () => {
		expect(
			decide(me({ state: "QUEUED" }), [
				op(1, "APPEND", "unknown", ["a.md"]),
			]),
		).toEqual({ kind: "cancel" });
	});

	it("cancels a BLOCKED proposal with no established append (a conflict)", () => {
		expect(
			decide(
				me({
					state: "BLOCKED",
					failure: failure("BRANCH_CONFLICT", "append", false),
				}),
				[op(1, "APPEND", "not_pushed", ["a.md"])],
			),
		).toEqual({ kind: "cancel" });
	});

	it("cancels a proposal still uploading, as #2563's cancel does", () => {
		expect(decide(me({ state: "QUEUED", status: "RECEIVING" }))).toEqual({
			kind: "cancel",
		});
	});

	it("does not withdraw a BLOCKED proposal whose change is on the branch", () => {
		expect(
			decide(
				me({
					state: "BLOCKED",
					failure: failure(
						"CONFIGURATION_CHANGED",
						"admission",
						false,
					),
				}),
				[op(1, "APPEND", "acked", ["a.md"])],
			),
		).toEqual({ kind: "refuse", reason: "already_decided" });
	});
});

describe("withdraw, appended (spec §6.8): CLOSE_REQUESTED with a WITHDRAW command", () => {
	it("asks for its own revert at the branch's next execution sequence while another change is live", () => {
		expect(
			decide(
				me(),
				[op(1, "APPEND", "acked", ["a.md"])],
				[other({ state: "QUEUED" })],
			),
		).toEqual({ kind: "request_change", seq: 7 });
	});

	it("counts another OPEN change that is on the branch as live", () => {
		expect(
			decide(
				me(),
				[
					op(1, "APPEND", "acked", ["a.md"]),
					op(2, "APPEND", "observed", ["b.md"], OTHER),
				],
				[other({ state: "OPEN" })],
			),
		).toEqual({ kind: "request_change", seq: 7 });
	});

	it("withdraws again from OPEN WITHDRAW_OUTCOME_UNKNOWN by recording the command again", () => {
		expect(
			decide(
				me({
					failure: failure(
						"WITHDRAW_OUTCOME_UNKNOWN",
						"revert",
						false,
					),
				}),
				[
					op(1, "APPEND", "acked", ["a.md"]),
					op(3, "REVERT", "unknown", ["a.md"]),
				],
				[other({ state: "QUEUED" })],
			),
		).toEqual({ kind: "request_change", seq: 7 });
	});
});

describe("withdraw of the last live change (spec §6.8): the branch closes", () => {
	it("closes the branch when no other proposal on it is live", () => {
		expect(decide(me(), [op(1, "APPEND", "acked", ["a.md"])])).toEqual({
			kind: "request_branch_close",
		});
	});

	it("does not count a proposal already withdrawing, or a non-retryable BLOCKED one, as live", () => {
		expect(
			decide(
				me(),
				[
					op(1, "APPEND", "acked", ["a.md"]),
					op(2, "APPEND", "acked", ["b.md"], OTHER),
				],
				[
					other({
						state: "CLOSE_REQUESTED",
						withdrawRequestedAt: new Date("2026-09-27T00:00:00Z"),
						withdrawScope: "change",
					}),
					other({
						id: "snap_third",
						state: "BLOCKED",
						failure: failure(
							"PUSH_OUTCOME_UNKNOWN",
							"append",
							false,
						),
					}),
				],
			),
		).toEqual({ kind: "request_branch_close" });
	});

	it("reads each other proposal's own journal, not the withdrawing one's", () => {
		// The other proposal is OPEN in name only: no operation of its own is
		// established, so it is not live; mine must not stand in for it.
		expect(
			decide(
				me(),
				[op(1, "APPEND", "acked", ["a.md"])],
				[other({ state: "OPEN" })],
			),
		).toEqual({ kind: "request_branch_close" });
	});
});

describe("refused by a later change (spec §6.8, WITHDRAW_BLOCKED_BY_LATER_CHANGE)", () => {
	it("names the paths a later established operation of another proposal wrote", () => {
		expect(
			decide(
				me(),
				[
					op(1, "APPEND", "acked", ["a.md", "b.md", "c.md"]),
					op(2, "APPEND", "acked", ["c.md", "a.md", "z.md"], OTHER),
				],
				[other({ state: "OPEN" })],
			),
		).toEqual({
			kind: "blocked_by_later_change",
			paths: ["a.md", "c.md"],
			count: 2,
		});
	});

	it("counts an observed later write, and a later revert of another change", () => {
		expect(
			decide(
				me(),
				[
					op(1, "APPEND", "acked", ["a.md", "b.md"]),
					op(2, "APPEND", "acked", ["a.md"], OTHER),
					op(4, "REVERT", "observed", ["b.md"], OTHER),
				],
				[other({ state: "OPEN" })],
			),
		).toMatchObject({ kind: "blocked_by_later_change", count: 2 });
	});

	it("ignores an earlier write, an unestablished later one and its own revert", () => {
		expect(
			decide(
				me(),
				[
					op(1, "APPEND", "acked", ["a.md"], OTHER),
					op(2, "APPEND", "acked", ["a.md"]),
					op(3, "APPEND", "unknown", ["a.md"], "snap_third"),
					op(4, "APPEND", "not_pushed", ["a.md"], "snap_third"),
					op(5, "APPEND", null, ["a.md"], "snap_third"),
					op(6, "REVERT", "unknown", ["a.md"]),
				],
				[other({ state: "OPEN" }), other({ id: "snap_third" })],
			),
		).toEqual({ kind: "request_change", seq: 7 });
	});

	it("names the first 20 paths, sorted, and counts them all", () => {
		const paths = Array.from(
			{ length: 25 },
			(_, n) => `f${String(n).padStart(2, "0")}.md`,
		);
		const result = decide(
			me(),
			[
				op(1, "APPEND", "acked", paths),
				op(2, "APPEND", "acked", [...paths].reverse(), OTHER),
			],
			[other({ state: "OPEN" })],
		);
		expect(result).toEqual({
			kind: "blocked_by_later_change",
			paths: paths.slice(0, 20),
			count: 25,
		});
	});

	it("is decided before the last-live rule: a blocked withdrawal never closes the branch", () => {
		expect(
			decide(me(), [
				op(1, "APPEND", "acked", ["a.md"]),
				op(2, "APPEND", "acked", ["a.md"], OTHER),
			]),
		).toMatchObject({ kind: "blocked_by_later_change" });
	});
});

describe("repeats and refusals", () => {
	it("answers a CANCELED proposal as already canceled", () => {
		expect(
			decide(me({ state: "CANCELED", proposalStatus: "REJECTED" })),
		).toEqual({ kind: "already_canceled" });
	});

	it.each(["MERGED", "CLOSED"] as const)("refuses a %s proposal", (state) => {
		expect(decide(me({ state, proposalStatus: state }))).toEqual({
			kind: "refuse",
			reason: "already_decided",
		});
	});

	it("answers CLOSE_REQUESTED from the scope it holds", () => {
		expect(
			decide(
				me({
					state: "CLOSE_REQUESTED",
					withdrawRequestedAt: new Date(),
					withdrawScope: "change",
				}),
			),
		).toEqual({ kind: "already_close_requested", scope: "change" });
	});

	it("answers an OPEN proposal whose branch is closing for it", () => {
		expect(
			decide(
				me({
					withdrawRequestedAt: new Date(),
					withdrawScope: "branch",
				}),
				[op(1, "APPEND", "acked", ["a.md"])],
				[],
				branch({ state: "CLOSE_REQUESTED", closeIntent: "WITHDRAW" }),
			),
		).toEqual({ kind: "already_close_requested", scope: "branch" });
	});

	it("answers a withdrawal on a branch a Close is already withdrawing", () => {
		expect(
			decide(
				me(),
				[op(1, "APPEND", "acked", ["a.md"])],
				[other()],
				branch({ state: "CLOSE_REQUESTED", closeIntent: "WITHDRAW" }),
			),
		).toEqual({ kind: "already_close_requested", scope: "branch" });
	});

	it("refuses while a Start over settles the branch", () => {
		expect(
			decide(
				me(),
				[op(1, "APPEND", "acked", ["a.md"])],
				[other()],
				branch({ state: "CLOSE_REQUESTED", closeIntent: "START_OVER" }),
			),
		).toEqual({ kind: "refuse", reason: "in_progress" });
	});

	it.each([
		["a terminal branch", branch({ state: "MERGED" })],
		["an untracked branch", branch({ state: "CLOSED", untracked: true })],
	])("refuses an OPEN proposal on %s", (_, b) => {
		expect(
			decide(me(), [op(1, "APPEND", "acked", ["a.md"])], [other()], b),
		).toEqual({ kind: "refuse", reason: "already_decided" });
	});

	it("refuses while an append is in flight (OPENING)", () => {
		expect(decide(me({ state: "OPENING" }))).toEqual({
			kind: "refuse",
			reason: "in_progress",
		});
	});

	it("refuses validating work, as #2563's cancel does", () => {
		expect(decide(me({ state: "QUEUED", status: "VALIDATING" }))).toEqual({
			kind: "refuse",
			reason: "in_progress",
		});
	});

	it("refuses an OPEN proposal with no established append of its current submission", () => {
		expect(
			decide(me({ assignment: 2 }), [op(1, "APPEND", "acked", ["a.md"])]),
		).toEqual({ kind: "refuse", reason: "already_decided" });
	});
});
