/**
 * The member's branch commands, decided purely (Fizzy #2738 spec §4.3
 * "Branch close requested (WITHDRAW)"; §10 `append`; Decision 14):
 * `decideBranchCloseForProposal` names what a Close, or the withdrawal of a
 * branch's last live change, does to one proposal, and
 * `proposalAppendSummary` what a proposal's append did.
 * `instruction-proposal-branch-commands.integration.test.ts` runs the writes.
 */
import { describe, expect, it } from "vitest";
import { proposalAppendSummary } from "../prisma/queries/instruction-proposal-branch-commands";
import type {
	EvidenceOp,
	OpOutcome,
	ProposalLifecycle,
} from "../prisma/queries/instruction-proposal-branch-evidence";
import type { BranchRow } from "../prisma/queries/instruction-proposal-branches";
import { decideBranchCloseForProposal } from "../prisma/queries/instructions";

const B = "branch_1";
const NOW = new Date("2026-09-27T12:00:00Z");
const EARLIER = new Date("2026-09-27T10:00:00Z");

const op = (
	executionSeq: number,
	kind: "APPEND" | "REVERT",
	outcome: OpOutcome,
	assignment = 1,
): EvidenceOp => ({
	id: `op${executionSeq}`,
	kind,
	executionSeq,
	assignment,
	branchId: B,
	outcome,
});

const lifecycle = (over: Partial<ProposalLifecycle>): ProposalLifecycle => ({
	state: "OPEN",
	failure: null,
	intent: null,
	command: null,
	...over,
});

const decide = (current: ProposalLifecycle, ops: EvidenceOp[] = []) =>
	decideBranchCloseForProposal({
		current,
		ops,
		branchId: B,
		assignment: 1,
		now: NOW,
	});

const BRANCH_INTENT = { at: NOW, scope: "branch" as const };

describe("decideBranchCloseForProposal (spec §4.3 Branch close requested)", () => {
	it("cancels a QUEUED proposal with intent branch", () => {
		expect(decide(lifecycle({ state: "QUEUED" }))).toEqual({
			kind: "cancel",
			intent: BRANCH_INTENT,
		});
	});

	it("cancels a QUEUED Try again, its APPEND command cleared by the cancel", () => {
		expect(
			decide(
				lifecycle({
					state: "QUEUED",
					command: { kind: "APPEND", seq: 4 },
				}),
				[op(1, "APPEND", "unknown")],
			),
		).toEqual({ kind: "cancel", intent: BRANCH_INTENT });
	});

	it("cancels a pre-append BLOCKED proposal (no established current append)", () => {
		const blocked = lifecycle({
			state: "BLOCKED",
			failure: {
				phase: "append",
				code: "BRANCH_CONFLICT",
				retryable: false,
				at: EARLIER.toISOString(),
				params: {},
			},
		});
		expect(decide(blocked)).toEqual({
			kind: "cancel",
			intent: BRANCH_INTENT,
		});
		expect(decide(blocked, [op(1, "APPEND", "not_pushed")])).toEqual({
			kind: "cancel",
			intent: BRANCH_INTENT,
		});
	});

	it("keeps an OPEN proposal OPEN with intent branch and no command", () => {
		expect(decide(lifecycle({}), [op(1, "APPEND", "acked")])).toEqual({
			kind: "lifecycle",
			next: lifecycle({ intent: BRANCH_INTENT }),
		});
	});

	it("returns a CLOSE_REQUESTED proposal with no issued revert to OPEN, its change leaving with the branch", () => {
		const withdrawing = lifecycle({
			state: "CLOSE_REQUESTED",
			intent: { at: EARLIER, scope: "change" },
			command: { kind: "WITHDRAW", seq: 3 },
		});
		expect(decide(withdrawing, [op(1, "APPEND", "acked")])).toEqual({
			kind: "lifecycle",
			next: lifecycle({ state: "OPEN", intent: BRANCH_INTENT }),
		});
	});

	it("keeps CLOSE_REQUESTED while its revert is issued, taking intent branch and clearing the command", () => {
		const withdrawing = lifecycle({
			state: "CLOSE_REQUESTED",
			intent: { at: EARLIER, scope: "change" },
			command: { kind: "WITHDRAW", seq: 2 },
		});
		expect(
			decide(withdrawing, [
				op(1, "APPEND", "acked"),
				op(2, "REVERT", null),
			]),
		).toEqual({
			kind: "lifecycle",
			next: lifecycle({
				state: "CLOSE_REQUESTED",
				intent: BRANCH_INTENT,
			}),
		});
	});

	it("keeps an OPENING proposal where it stands with intent branch", () => {
		expect(
			decide(lifecycle({ state: "OPENING" }), [op(1, "APPEND", null)]),
		).toEqual({
			kind: "lifecycle",
			next: lifecycle({ state: "OPENING", intent: BRANCH_INTENT }),
		});
	});

	it("keeps an existing branch intent's time, and changes nothing twice", () => {
		const already = lifecycle({ intent: { at: EARLIER, scope: "branch" } });
		expect(decide(already, [op(1, "APPEND", "acked")])).toEqual({
			kind: "none",
		});
	});

	it("leaves a terminal proposal alone", () => {
		for (const state of ["MERGED", "CLOSED", "CANCELED"] as const) {
			expect(decide(lifecycle({ state }))).toEqual({ kind: "none" });
		}
	});
});

function branchRow(over: Partial<BranchRow> = {}): BranchRow {
	return { id: B, state: "OPEN", ...over } as BranchRow;
}

const aop = (
	executionSeq: number,
	kind: "APPEND" | "REVERT",
	outcome: OpOutcome,
	membership: string | null = null,
) => ({
	...op(executionSeq, kind, outcome),
	sha: String(executionSeq).repeat(40),
	membership,
});

describe("proposalAppendSummary (spec §10 append)", () => {
	it("is appended with the commit once the current append is established", () => {
		expect(
			proposalAppendSummary({
				branch: branchRow(),
				assignment: 1,
				failure: null,
				ops: [
					aop(1, "APPEND", "not_pushed"),
					aop(2, "APPEND", "observed"),
				],
			}),
		).toEqual({
			outcome: "appended",
			commitSha: "2".repeat(40),
			membership: null,
		});
	});

	it("is already_on_branch for the informational no-op cancel", () => {
		expect(
			proposalAppendSummary({
				branch: branchRow(),
				assignment: 1,
				failure: { code: "ALREADY_ON_BRANCH", retryable: false },
				ops: [],
			}),
		).toEqual({
			outcome: "already_on_branch",
			commitSha: null,
			membership: null,
		});
	});

	it("reads only the current submission", () => {
		expect(
			proposalAppendSummary({
				branch: branchRow(),
				assignment: 2,
				failure: null,
				ops: [aop(1, "APPEND", "acked", "included")],
			}),
		).toEqual({ outcome: null, commitSha: null, membership: null });
	});

	it("carries the append's classification", () => {
		expect(
			proposalAppendSummary({
				branch: branchRow({ state: "MERGED" }),
				assignment: 1,
				failure: null,
				ops: [aop(1, "APPEND", "acked", "unverified")],
			}).membership,
		).toBe("unverified");
	});

	it("is unverified for an unresolved current push on a terminal branch, never on a live one", () => {
		const unknownAppend = [aop(1, "APPEND", "unknown")];
		expect(
			proposalAppendSummary({
				branch: branchRow({ state: "CLOSED" }),
				assignment: 1,
				failure: null,
				ops: unknownAppend,
			}).membership,
		).toBe("unverified");
		expect(
			proposalAppendSummary({
				branch: branchRow({ state: "OPEN" }),
				assignment: 1,
				failure: null,
				ops: unknownAppend,
			}).membership,
		).toBeNull();
		expect(
			proposalAppendSummary({
				branch: branchRow({ state: "MERGED" }),
				assignment: 1,
				failure: null,
				ops: [aop(1, "APPEND", "acked"), aop(2, "REVERT", "unknown")],
			}).membership,
		).toBe("unverified");
	});
});
