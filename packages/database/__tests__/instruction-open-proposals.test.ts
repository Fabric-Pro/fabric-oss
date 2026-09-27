/**
 * The open-proposals selection (Fizzy #2738 spec §14.2), pure: which of the
 * member's PENDING proposals `GET .../instructions/proposals/open` returns,
 * and which paths each lists. Latest intent only, current destination only:
 * a path is listed on the proposal holding the member's newest intent for
 * it, and only while that proposal positively carries it toward review;
 * otherwise it is omitted and never falls back to an older intent.
 * `instruction-open-proposals.integration.test.ts` runs the loader.
 */
import { describe, expect, it } from "vitest";
import {
	ProjectInstructionPullRequestState,
	ProjectInstructionSnapshotStatus,
} from "../prisma/generated/client";
import {
	effectiveDelta,
	OPEN_PROPOSAL_PULL_REQUEST_STATES,
	OPEN_PROPOSAL_STATUSES,
	type OpenProposalBranch,
	type OpenProposalCandidate,
	type OpenProposalOp,
	selectOpenProposals,
} from "../prisma/queries/instruction-open-proposals";
import type { OpOutcome } from "../prisma/queries/instruction-proposal-branch-evidence";
import type { BranchDestinationRecord } from "../prisma/queries/instruction-proposal-branches";

const DEST: BranchDestinationRecord = {
	integrationId: "int_1",
	syncId: "sync_1",
	repositoryKey: "github:example-org/example-repo",
	provider: "GITHUB",
	repository: {
		provider: "GITHUB",
		owner: "example-org",
		repo: "example-repo",
	},
	targetRef: "main",
	rootPath: "",
};

const put = (path: string, sha: string) => ({
	path,
	op: "put" as const,
	sha256: sha.repeat(64),
});

let version = 0;
function candidate(
	over: Partial<OpenProposalCandidate> = {},
): OpenProposalCandidate {
	version += 1;
	return {
		snapshotId: `snap_${version}`,
		version,
		baseSnapshotId: "base_1",
		status: "READY",
		pullRequestState: "QUEUED",
		pullRequestUrl: null,
		contextVersion: 2,
		frozenDestination: DEST,
		branchId: "branch_1",
		assignment: 1,
		intentOrder: BigInt(version),
		withdrawRequestedAt: null,
		changes: [put("AGENTS.md", "a")],
		...over,
	};
}

function branch(over: Partial<OpenProposalBranch> = {}): OpenProposalBranch {
	return {
		id: "branch_1",
		state: "OPEN",
		retiredAt: null,
		untracked: false,
		failure: null,
		membership: null,
		pullRequestUrl: "https://example.com/example-org/example-repo/pull/7",
		...over,
	};
}

function op(
	snapshotId: string,
	executionSeq: number,
	kind: "APPEND" | "REVERT",
	outcome: OpOutcome,
	paths: string[] = ["AGENTS.md"],
	over: Partial<OpenProposalOp> = {},
): OpenProposalOp {
	return {
		id: `op_${snapshotId}_${executionSeq}`,
		snapshotId,
		kind,
		executionSeq,
		assignment: 1,
		branchId: "branch_1",
		outcome,
		paths,
		...over,
	};
}

function select(
	candidates: OpenProposalCandidate[],
	o: {
		branches?: OpenProposalBranch[];
		ops?: OpenProposalOp[];
		current?: BranchDestinationRecord | null;
		limit?: number;
	} = {},
) {
	return selectOpenProposals({
		candidates,
		branches: new Map((o.branches ?? [branch()]).map((b) => [b.id, b])),
		ops: o.ops ?? [],
		current: o.current === undefined ? DEST : o.current,
		limit: o.limit,
	});
}

const listed = (rows: ReturnType<typeof select>) =>
	rows.map((r) => ({
		id: r.candidate.snapshotId,
		paths: r.changes.map((c) => c.path),
	}));

describe("effectiveDelta", () => {
	it("puts changed and new paths with their hash and deletes with sha256 exactly null", () => {
		const base = new Map([
			["AGENTS.md", "a".repeat(64)],
			["gone.md", "b".repeat(64)],
			["same.md", "c".repeat(64)],
		]);
		const files = new Map([
			["AGENTS.md", "d".repeat(64)],
			["new.md", "e".repeat(64)],
			["same.md", "c".repeat(64)],
		]);
		const delta = effectiveDelta(base, files);
		expect(delta).toEqual([
			{ path: "AGENTS.md", op: "put", sha256: "d".repeat(64) },
			{ path: "gone.md", op: "delete", sha256: null },
			{ path: "new.md", op: "put", sha256: "e".repeat(64) },
		]);
		const deleted = delta.find((c) => c.op === "delete");
		expect(deleted).toHaveProperty("sha256");
		expect(deleted?.sha256).toBeNull();
	});
});

describe("enum strictness (spec §14.2)", () => {
	it("keeps every snapshot status within the CLI's union", () => {
		for (const value of Object.values(ProjectInstructionSnapshotStatus)) {
			expect(OPEN_PROPOSAL_STATUSES).toContain(value);
		}
		expect([...OPEN_PROPOSAL_STATUSES].sort()).toEqual(
			["FAILED", "READY", "RECEIVING", "REJECTED", "VALIDATING"].sort(),
		);
	});

	it("keeps every pull-request state within ProposalPullRequestState", () => {
		for (const value of Object.values(ProjectInstructionPullRequestState)) {
			expect(OPEN_PROPOSAL_PULL_REQUEST_STATES).toContain(value);
		}
		expect([...OPEN_PROPOSAL_PULL_REQUEST_STATES].sort()).toEqual(
			[
				"BLOCKED",
				"CANCELED",
				"CLOSED",
				"CLOSE_REQUESTED",
				"MERGED",
				"OPEN",
				"OPENING",
				"QUEUED",
			].sort(),
		);
	});

	it("never returns a row whose status or state is outside those unions", () => {
		const rows = select(
			[
				candidate({
					status: "STAGING",
					contextVersion: null,
					pullRequestState: null,
				}),
				candidate({
					contextVersion: 1,
					pullRequestState: "SOMETHING_NEW" as never,
				}),
				candidate({ contextVersion: null, pullRequestState: null }),
			],
			{ branches: [] },
		);
		expect(rows).toHaveLength(1);
		for (const row of rows) {
			expect(OPEN_PROPOSAL_STATUSES).toContain(row.status);
		}
	});
});

describe("rows", () => {
	it("skips a row with a null base", () => {
		expect(
			select([
				candidate({
					baseSnapshotId: null,
					contextVersion: null,
					pullRequestState: null,
				}),
			]),
		).toEqual([]);
	});

	it("orders version desc and keeps at most 20 after supersession", () => {
		const many = Array.from({ length: 25 }, (_, n) =>
			candidate({
				contextVersion: null,
				pullRequestState: null,
				changes: [put(`f${n}.md`, "a")],
			}),
		);
		const rows = select(many, { branches: [] });
		expect(rows).toHaveLength(20);
		const versions = rows.map((r) => r.candidate.version);
		expect(versions).toEqual([...versions].sort((a, b) => b - a));
		expect(versions[0]).toBe(many[24]?.version);
	});

	it("applies the limit after superseded rows are left out, not before", () => {
		// 20 newer proposals whose one path a still newer one supersedes on a
		// retired branch: none of them is listed, so the older row is.
		const old = candidate({ changes: [put("keep.md", "a")] });
		const superseded = Array.from({ length: 20 }, () =>
			candidate({ changes: [put("AGENTS.md", "b")] }),
		);
		const newest = candidate({
			branchId: "branch_retired",
			changes: [put("AGENTS.md", "c")],
		});
		const rows = select([old, ...superseded, newest], {
			branches: [
				branch(),
				branch({ id: "branch_retired", retiredAt: new Date() }),
			],
		});
		expect(listed(rows)).toEqual([
			{ id: old.snapshotId, paths: ["keep.md"] },
		]);
	});

	it("lists a proposal Fabric reviews itself with its whole delta and no pull request", () => {
		const c = candidate({
			contextVersion: null,
			pullRequestState: null,
			branchId: null,
			changes: [
				put("a.md", "a"),
				{ path: "b.md", op: "delete", sha256: null },
			],
		});
		const [row] = select([c], { branches: [] });
		expect(row?.pullRequest).toBeNull();
		expect(row?.branch).toBeNull();
		expect(row?.changes).toEqual(c.changes);
	});

	it("gives a branch proposal its branch's pull-request url and the proposal's own state", () => {
		const c = candidate({ pullRequestState: "OPEN" });
		const [row] = select([c], {
			ops: [op(c.snapshotId, 1, "APPEND", "acked")],
		});
		expect(row?.pullRequest).toEqual({
			state: "OPEN",
			url: "https://example.com/example-org/example-repo/pull/7",
		});
		expect(row?.branch?.id).toBe("branch_1");
	});
});

describe("current destination only", () => {
	it("omits a v2 proposal whose frozen destination is not the current one", () => {
		const c = candidate({
			frozenDestination: { ...DEST, targetRef: "develop" },
		});
		expect(select([c])).toEqual([]);
	});

	it("omits every v2 proposal when the project has no current destination", () => {
		expect(select([candidate()], { current: null })).toEqual([]);
	});

	it("lets a stale newer intent suppress an older proposal's path, never listing either", () => {
		const older = candidate();
		const stale = candidate({
			frozenDestination: { ...DEST, rootPath: "docs" },
		});
		expect(select([older, stale])).toEqual([]);
	});
});

describe("newest intent per path", () => {
	it("lists a path only on the newest intent, whatever the version order", () => {
		const a = candidate({
			intentOrder: BigInt(50),
			changes: [put("AGENTS.md", "a"), put("x.md", "a")],
		});
		const b = candidate({
			intentOrder: BigInt(10),
			changes: [put("AGENTS.md", "b")],
		});
		expect(listed(select([a, b]))).toEqual([
			{ id: a.snapshotId, paths: ["AGENTS.md", "x.md"] },
		]);
	});

	it("counts an OPENING proposal's intent", () => {
		const a = candidate({ changes: [put("AGENTS.md", "a")] });
		const opening = candidate({
			pullRequestState: "OPENING",
			changes: [put("AGENTS.md", "b")],
		});
		expect(listed(select([a, opening]))).toEqual([
			{ id: opening.snapshotId, paths: ["AGENTS.md"] },
		]);
	});

	it("never suppresses a B -> C -> B re-send: the newest intent is C", () => {
		const b1 = candidate({ changes: [put("AGENTS.md", "b")] });
		const c = candidate({ changes: [put("AGENTS.md", "c")] });
		const rows = select([b1, c]);
		expect(listed(rows)).toEqual([
			{ id: c.snapshotId, paths: ["AGENTS.md"] },
		]);
		expect(rows[0]?.changes[0]?.sha256).toBe("c".repeat(64));
	});

	it("never falls back to an older intent when the newest one does not carry the path, across a retired branch", () => {
		const b1 = candidate({ changes: [put("AGENTS.md", "b")] });
		const c = candidate({
			branchId: "branch_retired",
			changes: [put("AGENTS.md", "c")],
		});
		expect(
			select([b1, c], {
				branches: [
					branch(),
					branch({ id: "branch_retired", retiredAt: new Date() }),
				],
			}),
		).toEqual([]);
	});

	it("lets a later established operation on the branch drop the path", () => {
		const mine = candidate({ pullRequestState: "OPEN" });
		const other = candidate({ withdrawRequestedAt: new Date() });
		const rows = select([mine, other], {
			ops: [
				op(mine.snapshotId, 1, "APPEND", "acked"),
				op(other.snapshotId, 2, "APPEND", "acked"),
			],
		});
		expect(rows).toEqual([]);
	});

	it("keeps the path when the later operation is not established", () => {
		const mine = candidate({ pullRequestState: "OPEN" });
		const other = candidate({ withdrawRequestedAt: new Date() });
		const rows = select([mine, other], {
			ops: [
				op(mine.snapshotId, 1, "APPEND", "acked"),
				op(other.snapshotId, 2, "APPEND", "not_pushed"),
			],
		});
		expect(listed(rows)).toEqual([
			{ id: mine.snapshotId, paths: ["AGENTS.md"] },
		]);
	});

	it("keeps each path on at most one row", () => {
		const a = candidate({ changes: [put("a.md", "a"), put("b.md", "a")] });
		const b = candidate({ changes: [put("b.md", "b"), put("c.md", "b")] });
		const rows = select([a, b]);
		const paths = rows.flatMap((r) => r.changes.map((c) => c.path));
		expect(new Set(paths).size).toBe(paths.length);
		expect(listed(rows)).toEqual([
			{ id: b.snapshotId, paths: ["b.md", "c.md"] },
			{ id: a.snapshotId, paths: ["a.md"] },
		]);
	});
});

describe("positively carries toward review: each disqualifier alone", () => {
	const carried = (
		c: OpenProposalCandidate,
		o: {
			branch?: Partial<OpenProposalBranch>;
			ops?: OpenProposalOp[];
		} = {},
	) => select([c], { branches: [branch(o.branch)], ops: o.ops ?? [] }).length;

	it("carries a QUEUED proposal on an accepting branch, and an OPEN one on an OPEN branch", () => {
		expect(carried(candidate())).toBe(1);
		const open = candidate({ pullRequestState: "OPEN" });
		expect(
			carried(open, { ops: [op(open.snapshotId, 1, "APPEND", "acked")] }),
		).toBe(1);
		const opening = candidate({ pullRequestState: "OPEN" });
		expect(
			carried(opening, {
				branch: { state: "OPENING" },
				ops: [op(opening.snapshotId, 1, "APPEND", "observed")],
			}),
		).toBe(1);
	});

	it("withdrawal requested", () => {
		expect(carried(candidate({ withdrawRequestedAt: new Date() }))).toBe(0);
	});

	it("current append unknown", () => {
		const c = candidate({ pullRequestState: "OPENING" });
		expect(
			carried(c, { ops: [op(c.snapshotId, 1, "APPEND", "unknown")] }),
		).toBe(0);
	});

	it("any current withdrawal: issued, unknown or established", () => {
		for (const outcome of [null, "unknown", "acked"] as const) {
			const c = candidate({ pullRequestState: "OPEN" });
			expect(
				carried(c, {
					ops: [
						op(c.snapshotId, 1, "APPEND", "acked"),
						op(c.snapshotId, 2, "REVERT", outcome),
					],
				}),
			).toBe(0);
		}
	});

	it("a not_pushed revert is no current withdrawal", () => {
		const c = candidate({ pullRequestState: "OPEN" });
		expect(
			carried(c, {
				ops: [
					op(c.snapshotId, 1, "APPEND", "acked"),
					op(c.snapshotId, 2, "REVERT", "not_pushed"),
				],
			}),
		).toBe(1);
	});

	it("branch not accepting appends (closing)", () => {
		expect(
			carried(candidate(), { branch: { state: "CLOSE_REQUESTED" } }),
		).toBe(0);
	});

	it("ATTRIBUTION_REJECTED on the branch", () => {
		expect(
			carried(candidate(), {
				branch: {
					state: "BLOCKED",
					failure: { code: "ATTRIBUTION_REJECTED", retryable: false },
				},
			}),
		).toBe(0);
	});

	it("PR_CREATION_REFUSED on the branch", () => {
		expect(
			carried(candidate(), {
				branch: {
					state: "BLOCKED",
					failure: { code: "PR_CREATION_REFUSED", retryable: false },
				},
			}),
		).toBe(0);
	});

	it("a retryable branch failure does not disqualify", () => {
		expect(
			carried(candidate(), {
				branch: {
					state: "BLOCKED",
					failure: { code: "PROVIDER_UNAVAILABLE", retryable: true },
				},
			}),
		).toBe(1);
	});

	it("retired", () => {
		expect(
			carried(candidate(), { branch: { retiredAt: new Date() } }),
		).toBe(0);
	});

	it("untracked", () => {
		expect(carried(candidate(), { branch: { untracked: true } })).toBe(0);
	});

	it("membership pending", () => {
		expect(
			carried(candidate(), {
				branch: {
					membership: {
						status: "pending",
						at: "2026-09-26T00:00:00Z",
						attempts: 0,
					},
				},
			}),
		).toBe(0);
	});

	it("an OPEN proposal on a branch that is not OPENING or OPEN", () => {
		const c = candidate({ pullRequestState: "OPEN" });
		expect(
			carried(c, {
				branch: { state: "BLOCKED" },
				ops: [op(c.snapshotId, 1, "APPEND", "acked")],
			}),
		).toBe(0);
	});

	it("a BLOCKED or CLOSE_REQUESTED proposal", () => {
		expect(
			carried(
				candidate({
					pullRequestState: "BLOCKED",
				}),
			),
		).toBe(0);
		expect(
			carried(candidate({ pullRequestState: "CLOSE_REQUESTED" })),
		).toBe(0);
	});

	it("a proposal not joined to a branch yet", () => {
		expect(carried(candidate({ branchId: null }))).toBe(0);
	});
});

describe("#2563 (v1) rows", () => {
	it("keep their whole delta while heading to their own pull request's review", () => {
		for (const state of ["QUEUED", "OPENING", "OPEN"] as const) {
			const c = candidate({
				contextVersion: 1,
				branchId: null,
				intentOrder: null,
				pullRequestState: state,
				pullRequestUrl: "https://example.com/pull/1",
			});
			const [row] = select([c], { branches: [] });
			expect(row?.changes).toEqual(c.changes);
			expect(row?.pullRequest).toEqual({
				state,
				url: "https://example.com/pull/1",
			});
		}
	});

	it("list nothing once blocked or closing", () => {
		for (const state of ["BLOCKED", "CLOSE_REQUESTED"] as const) {
			expect(
				select(
					[
						candidate({
							contextVersion: 1,
							branchId: null,
							pullRequestState: state,
						}),
					],
					{ branches: [] },
				),
			).toEqual([]);
		}
	});
});
