/**
 * Member proposal branches: the evidence predicates and the reducer (Fizzy
 * #2738 spec §4.1). Pure, no database: `reconcileProposalFromEvidence` runs
 * against a fake transaction client here and against Postgres in
 * `instruction-proposal-branch-reconcile.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const transitions = vi.hoisted(() => ({ transitionPullRequest: vi.fn() }));

vi.mock(
	"../prisma/queries/instruction-proposal-pull-requests",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../prisma/queries/instruction-proposal-pull-requests")
		>()),
		transitionPullRequest: transitions.transitionPullRequest,
	}),
);

import type { Prisma } from "../prisma/client";
import {
	acceptsAppends,
	commandSatisfied,
	currentAppend,
	currentWithdrawal,
	type EvidenceOp,
	hasDeletionAuthority,
	isEstablished,
	isLiveProposal,
	lifecycleColumns,
	lifecycleOfRow,
	type OpOutcome,
	outcomeTransition,
	type ProposalLifecycle,
	reconcileProposalFromEvidence,
	reduceProposalLifecycle,
} from "../prisma/queries/instruction-proposal-branch-evidence";
import type { PullRequestFailure } from "../prisma/queries/instruction-proposal-pull-requests";

const NOW = new Date("2026-09-27T00:00:00Z");
const A = "APPEND" as const;
const R = "REVERT" as const;

const op = (
	seq: number,
	kind: "APPEND" | "REVERT",
	outcome: OpOutcome,
	assignment = 1,
	branchId = "b1",
): EvidenceOp => ({
	id: `op${seq}`,
	kind,
	executionSeq: seq,
	assignment,
	branchId,
	outcome,
});

const base = (over: Partial<ProposalLifecycle> = {}): ProposalLifecycle => ({
	state: "OPEN",
	failure: null,
	intent: null,
	command: null,
	...over,
});

const run = (current: ProposalLifecycle, ops: EvidenceOp[]) =>
	reduceProposalLifecycle({
		current,
		ops,
		branchId: "b1",
		assignment: 1,
		now: NOW,
	});

const fail = (
	code: PullRequestFailure["code"],
	phase: PullRequestFailure["phase"],
	retryable = false,
): PullRequestFailure => ({
	code,
	phase,
	retryable,
	at: "2026-09-26T00:00:00.000Z",
	params: {},
});

const CHANGE = {
	at: new Date("2026-09-26T10:00:00Z"),
	scope: "change" as const,
};
const BRANCH = {
	at: new Date("2026-09-26T11:00:00Z"),
	scope: "branch" as const,
};
const S = { branchId: "b1", assignment: 1 };

describe("evidence predicates (spec §4.1 Shared predicates)", () => {
	it("establishes only acked and observed; only acked carries deletion authority", () => {
		for (const outcome of [
			"acked",
			"observed",
			"not_pushed",
			"unknown",
			null,
		] as const) {
			expect(isEstablished({ outcome })).toBe(
				outcome === "acked" || outcome === "observed",
			);
			expect(hasDeletionAuthority({ outcome })).toBe(outcome === "acked");
		}
	});

	it("picks the current append ignoring not_pushed and other assignments and branches", () => {
		const ops = [
			op(1, A, "acked"),
			op(2, A, "not_pushed"),
			op(3, A, "acked", 0),
			op(4, A, "acked", 1, "b2"),
		];
		expect(currentAppend(ops, S)?.id).toBe("op1");
	});

	it("counts only reverts after the current append as the current withdrawal", () => {
		const earlier = [
			op(1, A, "acked"),
			op(2, R, "acked"),
			op(3, A, "acked"),
		];
		expect(currentWithdrawal(earlier, S)).toBeNull();
		const later = [...earlier, op(4, R, "unknown"), op(5, R, "not_pushed")];
		expect(currentWithdrawal(later, S)?.id).toBe("op4");
		expect(currentWithdrawal([op(1, R, "acked")], S)).toBeNull();
	});

	it("satisfies a command only once the current operation of its kind reaches its sequence", () => {
		const a2 = op(2, A, "acked");
		const r4 = op(4, R, null);
		expect(commandSatisfied({ kind: "APPEND", seq: 2 }, a2, null)).toBe(
			true,
		);
		expect(commandSatisfied({ kind: "APPEND", seq: 3 }, a2, null)).toBe(
			false,
		);
		expect(commandSatisfied({ kind: "WITHDRAW", seq: 4 }, a2, r4)).toBe(
			true,
		);
		expect(commandSatisfied({ kind: "WITHDRAW", seq: 5 }, a2, r4)).toBe(
			false,
		);
		expect(commandSatisfied({ kind: "WITHDRAW", seq: 1 }, a2, null)).toBe(
			false,
		);
	});

	it("applies evidence monotonically", () => {
		const reported = [
			"acked",
			"observed",
			"not_pushed",
			"unknown",
		] as const;
		const table: Record<string, Record<string, string>> = {};
		for (const recorded of [null, ...reported]) {
			table[String(recorded)] = Object.fromEntries(
				reported.map((r) => [r, outcomeTransition(recorded, r)]),
			);
		}
		expect(table).toEqual({
			null: {
				acked: "apply",
				observed: "apply",
				not_pushed: "apply",
				unknown: "apply",
			},
			acked: {
				acked: "same",
				observed: "refuse",
				not_pushed: "refuse",
				unknown: "refuse",
			},
			observed: {
				acked: "apply",
				observed: "same",
				not_pushed: "refuse",
				unknown: "refuse",
			},
			not_pushed: {
				acked: "refuse",
				observed: "refuse",
				not_pushed: "same",
				unknown: "refuse",
			},
			unknown: {
				acked: "apply",
				observed: "apply",
				not_pushed: "refuse",
				unknown: "same",
			},
		});
	});

	it("accepts appends only on a live, tracked, unretired branch without a terminal failure", () => {
		const b = {
			state: "OPEN",
			retiredAt: null,
			untracked: false,
			failure: null,
		};
		expect(acceptsAppends(b)).toBe(true);
		expect(acceptsAppends({ ...b, state: "PENDING" })).toBe(true);
		expect(
			acceptsAppends({
				...b,
				state: "BLOCKED",
				failure: fail("PR_CREATION_REFUSED", "create"),
			}),
		).toBe(true);
		for (const state of [
			"CLOSE_REQUESTED",
			"MERGED",
			"CLOSED",
			"CANCELED",
		]) {
			expect(acceptsAppends({ ...b, state })).toBe(false);
		}
		expect(acceptsAppends({ ...b, retiredAt: NOW })).toBe(false);
		expect(acceptsAppends({ ...b, untracked: true })).toBe(false);
		expect(
			acceptsAppends({
				...b,
				state: "BLOCKED",
				failure: fail("ATTRIBUTION_REJECTED", "admission"),
			}),
		).toBe(false);
		expect(
			acceptsAppends({
				...b,
				state: "BLOCKED",
				failure: fail("REPOSITORY_CHANGED", "reconcile"),
			}),
		).toBe(false);
	});

	it("reads live(proposal) from an established unreverted append or a runnable state", () => {
		const p = {
			state: "OPEN" as const,
			failure: null,
			withdrawRequestedAt: null,
			ops: [op(1, A, "acked")],
			branchId: "b1",
			assignment: 1,
		};
		expect(isLiveProposal(p)).toBe(true);
		expect(
			isLiveProposal({
				...p,
				ops: [op(1, A, "acked"), op(2, R, "acked")],
			}),
		).toBe(false);
		expect(
			isLiveProposal({
				...p,
				ops: [op(1, A, "acked"), op(2, R, "unknown")],
			}),
		).toBe(true);
		expect(isLiveProposal({ ...p, withdrawRequestedAt: NOW })).toBe(false);
		expect(isLiveProposal({ ...p, state: "CANCELED" })).toBe(false);
		expect(isLiveProposal({ ...p, state: "QUEUED", ops: [] })).toBe(true);
		expect(
			isLiveProposal({
				...p,
				state: "BLOCKED",
				ops: [],
				failure: fail("BRANCH_CONFLICT", "append", true),
			}),
		).toBe(true);
		expect(
			isLiveProposal({
				...p,
				state: "BLOCKED",
				ops: [],
				failure: fail("PUSH_OUTCOME_UNKNOWN", "append"),
			}),
		).toBe(false);
	});
});

describe("reduceProposalLifecycle (spec §4.1 table, rows 1-9)", () => {
	it("row 1: an established withdrawal cancels and completes the command", () => {
		const r = run(
			base({
				state: "CLOSE_REQUESTED",
				intent: CHANGE,
				command: { kind: "WITHDRAW", seq: 2 },
			}),
			[op(1, A, "acked"), op(2, R, "acked")],
		);
		expect(r).toEqual({
			row: 1,
			changed: true,
			next: {
				state: "CANCELED",
				failure: null,
				intent: CHANGE,
				command: null,
			},
		});
	});

	it("row 1 via withdraw-again: an older established withdrawal still cancels", () => {
		const r = run(
			base({
				state: "CLOSE_REQUESTED",
				intent: CHANGE,
				command: { kind: "WITHDRAW", seq: 5 },
			}),
			[op(1, A, "acked"), op(2, R, "acked")],
		);
		expect(r.row).toBe(1);
		expect(r.next.state).toBe("CANCELED");
		expect(r.next.command).toBeNull();
	});

	it("row 2: an unsatisfied WITHDRAW keeps CLOSE_REQUESTED over an unknown revert (#61)", () => {
		const current = base({
			state: "OPEN",
			intent: CHANGE,
			command: { kind: "WITHDRAW", seq: 5 },
		});
		const r = run(current, [op(1, A, "acked"), op(2, R, "unknown")]);
		expect(r.row).toBe(2);
		expect(r.next).toEqual({ ...current, state: "CLOSE_REQUESTED" });
	});

	it("row 3: an issued revert with no outcome is CLOSE_REQUESTED", () => {
		const r = run(base({ intent: CHANGE }), [
			op(1, A, "acked"),
			op(2, R, null),
		]);
		expect(r.row).toBe(3);
		expect(r.next.state).toBe("CLOSE_REQUESTED");
		expect(r.next.intent).toEqual(CHANGE);
	});

	it("row 4: an unknown revert with a change intent reopens, clearing the intent", () => {
		const r = run(base({ state: "CLOSE_REQUESTED", intent: CHANGE }), [
			op(1, A, "acked"),
			op(2, R, "unknown"),
		]);
		expect(r.row).toBe(4);
		expect(r.next).toMatchObject({
			state: "OPEN",
			failure: {
				code: "WITHDRAW_OUTCOME_UNKNOWN",
				phase: "revert",
				retryable: false,
				at: NOW.toISOString(),
			},
			intent: null,
			command: null,
		});
	});

	it("row 4: a branch intent is kept for branch settlement (#66)", () => {
		const r = run(base({ state: "CLOSE_REQUESTED", intent: BRANCH }), [
			op(1, A, "acked"),
			op(2, R, "unknown"),
		]);
		expect(r.row).toBe(4);
		expect(r.next.state).toBe("OPEN");
		expect(r.next.failure?.code).toBe("WITHDRAW_OUTCOME_UNKNOWN");
		expect(r.next.intent).toEqual(BRANCH);
	});

	it("row 5: an established append opens and clears PUSH_OUTCOME_UNKNOWN", () => {
		const r = run(
			base({
				state: "BLOCKED",
				failure: fail("PUSH_OUTCOME_UNKNOWN", "append"),
			}),
			[op(1, A, "acked")],
		);
		expect(r).toMatchObject({
			row: 5,
			changed: true,
			next: { state: "OPEN", failure: null, command: null },
		});
	});

	it("row 5: clears a satisfied APPEND command and keeps a branch intent", () => {
		const withCommand = run(
			base({ state: "QUEUED", command: { kind: "APPEND", seq: 1 } }),
			[op(1, A, "acked")],
		);
		expect(withCommand.row).toBe(5);
		expect(withCommand.next.command).toBeNull();
		const withIntent = run(base({ state: "QUEUED", intent: BRANCH }), [
			op(1, A, "observed"),
		]);
		expect(withIntent.row).toBe(5);
		expect(withIntent.next).toMatchObject({
			state: "OPEN",
			intent: BRANCH,
		});
	});

	it("row 5: clears every append-phase conflict failure", () => {
		for (const code of [
			"BRANCH_CONFLICT",
			"SUPERSEDED_BY_LATER_CHANGE",
			"PUSH_OUTCOME_UNKNOWN",
			"BRANCH_MOVED",
		] as const) {
			const r = run(
				base({ state: "BLOCKED", failure: fail(code, "append") }),
				[op(1, A, "acked")],
			);
			expect(r.next.failure).toBeNull();
		}
	});

	it("row 5: keeps a failure-only REPOSITORY_CHANGED on OPEN", () => {
		const failure = fail("REPOSITORY_CHANGED", "reconcile");
		const r = run(base({ state: "OPEN", failure }), [op(1, A, "acked")]);
		expect(r.row).toBe(5);
		expect(r.next.failure).toEqual(failure);
		expect(r.changed).toBe(false);
	});

	it("row 6: an unknown append under an unsatisfied APPEND command is unchanged (#63)", () => {
		const current = base({
			state: "QUEUED",
			command: { kind: "APPEND", seq: 3 },
		});
		const r = run(current, [op(1, A, "unknown"), op(2, A, "unknown")]);
		expect(r).toEqual({ row: 6, next: current, changed: false });
	});

	it("row 7: an unknown append otherwise blocks, non-retryable", () => {
		const r = run(base({ state: "OPENING" }), [op(1, A, "unknown")]);
		expect(r.row).toBe(7);
		expect(r.next).toMatchObject({
			state: "BLOCKED",
			failure: {
				code: "PUSH_OUTCOME_UNKNOWN",
				phase: "append",
				retryable: false,
			},
		});
	});

	it("row 7 is not reached when the command's own append was not pushed: row 6", () => {
		const current = base({
			state: "QUEUED",
			command: { kind: "APPEND", seq: 3 },
		});
		const r = run(current, [op(1, A, "unknown"), op(3, A, "not_pushed")]);
		expect(r).toEqual({ row: 6, next: current, changed: false });
	});

	it("row 7 does not churn: the same non-retryable failure reduces to no change", () => {
		const first = run(base({ state: "OPENING" }), [op(1, A, "unknown")]);
		const again = reduceProposalLifecycle({
			current: first.next,
			ops: [op(1, A, "unknown")],
			branchId: "b1",
			assignment: 1,
			now: new Date("2026-09-28T00:00:00Z"),
		});
		expect(again).toEqual({ row: 7, next: first.next, changed: false });
	});

	it("row 8: an issued append with no outcome is unchanged", () => {
		const current = base({ state: "OPENING" });
		expect(run(current, [op(1, A, null)])).toEqual({
			row: 8,
			next: current,
			changed: false,
		});
	});

	it("row 9: no append is unchanged", () => {
		const current = base({ state: "QUEUED" });
		expect(run(current, [])).toEqual({
			row: 9,
			next: current,
			changed: false,
		});
	});

	it("#62: a refused withdrawal whose append becomes acked opens, never CLOSE_REQUESTED", () => {
		const current = base({ state: "OPEN" });
		expect(run(current, [op(1, A, "observed")]).row).toBe(5);
		const r = run(current, [op(1, A, "acked")]);
		expect(r.row).toBe(5);
		expect(r.next.state).toBe("OPEN");
	});

	it("never changes a terminal proposal", () => {
		for (const state of ["MERGED", "CLOSED", "CANCELED"] as const) {
			const current = base({ state });
			const r = run(current, [op(1, A, "unknown")]);
			expect(r).toEqual({ row: 7, next: current, changed: false });
		}
	});

	it("reports changed false whenever next equals current, including a failure read back from JSON", () => {
		const failure = fail("WITHDRAW_OUTCOME_UNKNOWN", "revert");
		const reread = JSON.parse(
			JSON.stringify({
				params: {},
				at: failure.at,
				retryable: false,
				phase: "revert",
				code: failure.code,
			}),
		) as PullRequestFailure;
		const r = run(base({ state: "OPEN", failure: reread }), [
			op(1, A, "acked"),
			op(2, R, "unknown"),
		]);
		expect(r).toMatchObject({ row: 4, changed: false });
		expect(r.next.failure).toBe(reread);
	});
});

describe("lifecycle columns", () => {
	it("round-trips a lifecycle through its columns, every pair together", () => {
		const lifecycle: ProposalLifecycle = {
			state: "CLOSE_REQUESTED",
			failure: fail("WITHDRAW_OUTCOME_UNKNOWN", "revert"),
			intent: BRANCH,
			command: { kind: "WITHDRAW", seq: 7 },
		};
		const cols = lifecycleColumns(lifecycle);
		expect(cols).toEqual({
			pullRequestFailure: lifecycle.failure,
			withdrawRequestedAt: BRANCH.at,
			withdrawScope: "branch",
			pendingCommand: "WITHDRAW",
			pendingCommandSeq: 7,
		});
		expect(
			lifecycleOfRow({
				state: "CLOSE_REQUESTED",
				failure: cols.pullRequestFailure,
				withdrawRequestedAt: cols.withdrawRequestedAt,
				withdrawScope: cols.withdrawScope,
				pendingCommand: cols.pendingCommand,
				pendingCommandSeq: cols.pendingCommandSeq,
			}),
		).toEqual(lifecycle);
		expect(lifecycleColumns(base())).toEqual({
			pullRequestFailure: null,
			withdrawRequestedAt: null,
			withdrawScope: null,
			pendingCommand: null,
			pendingCommandSeq: null,
		});
	});
});

describe("reconcileProposalFromEvidence (fake transaction)", () => {
	const ORG = "org_example";
	type Locked = Record<string, unknown>;
	let locked: Locked | null;
	let ops: EvidenceOp[];
	const findMany = vi.fn();
	const queryRaw = vi.fn();
	const tx = {
		$queryRaw: queryRaw,
		projectInstructionProposalBranchOperation: { findMany },
	} as unknown as Prisma.TransactionClient;

	beforeEach(() => {
		transitions.transitionPullRequest.mockReset();
		transitions.transitionPullRequest.mockResolvedValue({
			ok: true,
			attempt: 5,
		});
		findMany.mockReset();
		queryRaw.mockReset();
		locked = {
			id: "snap_1",
			projectId: "proj_1",
			version: 3,
			pullRequestOperationId: "opid_1",
			state: "CLOSE_REQUESTED",
			attempt: 4,
			failure: null,
			withdrawRequestedAt: CHANGE.at,
			withdrawScope: "change",
			pendingCommand: "WITHDRAW",
			pendingCommandSeq: 2,
			proposalBranchId: "b1",
			proposalAssignment: 1,
			databaseNow: NOW,
		};
		ops = [op(1, A, "acked"), op(2, R, "acked")];
		queryRaw.mockImplementation(async () => (locked ? [locked] : []));
		findMany.mockImplementation(async () => ops);
	});

	it("locks the row, reads only this submission's branch, and writes a changed lifecycle fenced on the attempt and assignment", async () => {
		const result = await reconcileProposalFromEvidence(tx, {
			snapshotId: "snap_1",
			organizationId: ORG,
		});
		expect(result).toEqual({ changed: true, row: 1, attempt: 5 });
		const sql = (queryRaw.mock.calls[0]?.[0] as string[]).join("?");
		expect(sql).toContain("FOR UPDATE");
		expect(findMany.mock.calls[0]?.[0]).toMatchObject({
			where: {
				organizationId: ORG,
				branchId: "b1",
				snapshotId: "snap_1",
			},
		});
		const [input, client] = transitions.transitionPullRequest.mock
			.calls[0] as [Record<string, unknown>, unknown];
		expect(client).toBe(tx);
		expect(input).toMatchObject({
			snapshotId: "snap_1",
			organizationId: ORG,
			event: "branch_evidence",
			from: ["CLOSE_REQUESTED"],
			expectedAttempt: 4,
			to: "CANCELED",
			bumpAttempt: true,
			branch: { id: "b1", assignment: 1 },
			data: {
				pullRequestFailure: null,
				withdrawRequestedAt: CHANGE.at,
				withdrawScope: "change",
				pendingCommand: null,
				pendingCommandSeq: null,
			},
			audit: {
				action: "project.instructions.pull_request_reconciled",
				actor: { type: "system" },
				organizationId: ORG,
				resource: {
					type: "project_instruction_snapshot",
					id: "snap_1",
				},
				metadata: {
					outcome: "canceled",
					branchId: "b1",
					operationId: "opid_1",
				},
			},
		});
	});

	it("writes nothing and keeps the attempt when the reduction is unchanged", async () => {
		locked = {
			...locked,
			state: "OPEN",
			pendingCommand: null,
			pendingCommandSeq: null,
			withdrawRequestedAt: null,
			withdrawScope: null,
		};
		ops = [op(1, A, "acked")];
		expect(
			await reconcileProposalFromEvidence(tx, {
				snapshotId: "snap_1",
				organizationId: ORG,
			}),
		).toEqual({ changed: false, row: 5, attempt: 4 });
		expect(transitions.transitionPullRequest).not.toHaveBeenCalled();
	});

	it("names the state unchanged when only failure or intent change, with no audit", async () => {
		locked = {
			...locked,
			state: "OPEN",
			pendingCommand: null,
			pendingCommandSeq: null,
		};
		ops = [op(1, A, "acked"), op(2, R, "unknown")];
		const result = await reconcileProposalFromEvidence(tx, {
			snapshotId: "snap_1",
			organizationId: ORG,
		});
		expect(result).toEqual({ changed: true, row: 4, attempt: 5 });
		expect(
			transitions.transitionPullRequest.mock.calls[0]?.[0],
		).toMatchObject({
			to: "unchanged",
			audit: undefined,
			data: { withdrawRequestedAt: null, withdrawScope: null },
		});
	});

	it("answers no change, never a throw, when the fenced write finds no row", async () => {
		transitions.transitionPullRequest.mockResolvedValue({ ok: false });
		expect(
			await reconcileProposalFromEvidence(tx, {
				snapshotId: "snap_1",
				organizationId: ORG,
			}),
		).toEqual({ changed: false, row: 1, attempt: 4 });
	});

	it("does nothing for a missing row or a proposal with no branch", async () => {
		locked = null;
		expect(
			await reconcileProposalFromEvidence(tx, {
				snapshotId: "snap_1",
				organizationId: ORG,
			}),
		).toEqual({ changed: false, row: 9, attempt: 0 });
		locked = {
			id: "snap_1",
			state: "QUEUED",
			attempt: 2,
			proposalBranchId: null,
			proposalAssignment: 0,
		};
		expect(
			await reconcileProposalFromEvidence(tx, {
				snapshotId: "snap_1",
				organizationId: ORG,
			}),
		).toEqual({ changed: false, row: 9, attempt: 2 });
		expect(findMany).not.toHaveBeenCalled();
	});
});
