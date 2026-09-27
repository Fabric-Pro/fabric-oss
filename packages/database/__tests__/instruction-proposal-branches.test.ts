/**
 * Member proposal branches: the pure cores of the branch queries (Fizzy #2738
 * spec §4.1 facts, §4.4 branch states, §5 destinations, §6 loop precedence,
 * §6.1 claim, §10 projection) and the guards that fire before any statement.
 * The transactional behaviour is pinned against Postgres in
 * `instruction-proposal-branches.integration.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../prisma/client";
import type { EvidenceOp } from "../prisma/queries/instruction-proposal-branch-evidence";
import {
	BRANCH_STATE_MOVES,
	type BranchOperationEntryRecord,
	type BranchQueueEntry,
	type BranchWorkInput,
	currentDestination,
	decideBranchWork,
	isLegalBranchMove,
	isReleasableBranch,
	isRetryableTransactionError,
	type ProposalBranchNaming,
	type ProposalRepositoryIdentity,
	parseBranchDestination,
	parseOperationEntries,
	pickRunnableHead,
	planOutcomeFact,
	projectEntries,
	proposalDestination,
	rehomableProposals,
	reserveNextRef,
	sameBranchDestination,
	transitionBranch,
} from "../prisma/queries/instruction-proposal-branches";

const NOW = new Date("2026-09-27T12:00:00Z");
const LATER = new Date("2026-09-27T13:00:00Z");
const EARLIER = new Date("2026-09-27T11:00:00Z");

/** A stand-in for `repositoryKey` of `@repo/integrations`: only equality matters here. */
const key = (r: ProposalRepositoryIdentity): string =>
	r.provider === "GITHUB"
		? `github:${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`
		: r.provider === "GITLAB"
			? `gitlab:${r.projectPath}`
			: `azure_devops:${r.apiOrigin}/${r.organization}/${r.project}/${r.repository}`;

const naming: ProposalBranchNaming = {
	memberBranchRef: ({ userId, n }) =>
		`fabric/instructions/members/dev-example-${userId.slice(0, 4)}/${n}`,
	repositoryIdentity: (provider, url) => {
		const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/.exec(
			url,
		);
		return provider === "GITHUB" && m
			? {
					provider: "GITHUB",
					owner: m[1] as string,
					repo: m[2] as string,
				}
			: null;
	},
	repositoryKey: key,
};

const GH: ProposalRepositoryIdentity = {
	provider: "GITHUB",
	owner: "example-org",
	repo: "example-repo",
};

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

describe("destinations (spec Decision 15, §5 steps 2-3)", () => {
	const context = {
		v: 2,
		provider: "GITHUB",
		repository: GH,
		integrationId: "int_1",
		syncId: "sync_1",
		targetRef: "main",
		rootPath: ".claude",
		generation: 4,
		baseCommitSha: "a".repeat(40),
	};

	it("reads the destination a v2 proposal froze, keyed canonically", () => {
		expect(proposalDestination(context, naming)).toEqual({
			integrationId: "int_1",
			syncId: "sync_1",
			repositoryKey: "github:example-org/example-repo",
			provider: "GITHUB",
			repository: GH,
			targetRef: "main",
			rootPath: ".claude",
		});
	});

	it("reads no destination from a v1 or malformed context", () => {
		expect(proposalDestination({ ...context, v: 1 }, naming)).toBeNull();
		expect(proposalDestination(null, naming)).toBeNull();
		expect(
			proposalDestination({ ...context, provider: "GITLAB" }, naming),
		).toBeNull();
		expect(
			proposalDestination(
				{ ...context, repository: { provider: "GITHUB" } },
				naming,
			),
		).toBeNull();
		expect(
			proposalDestination({ ...context, syncId: "" }, naming),
		).toBeNull();
	});

	const current = (
		over: Partial<Parameters<typeof currentDestination>[0]> = {},
	) =>
		currentDestination(
			{
				projectId: "proj_1",
				sourceOfTruth: "REPOSITORY",
				sync: {
					id: "sync_1",
					repositoryIntegrationId: "int_1",
					ref: "main",
					rootPath: ".claude",
				},
				integration: {
					projectId: "proj_1",
					provider: "GITHUB",
					repositoryUrl:
						"https://github.com/Example-Org/Example-Repo.git",
				},
				...over,
			},
			naming,
		);

	it("equals the frozen destination whatever the case of a GitHub URL, and ignores the generation", () => {
		const frozen = proposalDestination(context, naming);
		const live = current();
		expect(frozen && live && sameBranchDestination(frozen, live)).toBe(
			true,
		);
	});

	it("differs on the integration, sync row, repository, target ref or root", () => {
		const frozen = proposalDestination(context, naming);
		if (!frozen) {
			throw new Error("unreachable");
		}
		for (const other of [
			{ ...frozen, integrationId: "int_2" },
			{ ...frozen, syncId: "sync_2" },
			{ ...frozen, repositoryKey: "github:example-org/other" },
			{ ...frozen, targetRef: "develop" },
			{ ...frozen, rootPath: "" },
		]) {
			expect(sameBranchDestination(frozen, other)).toBe(false);
		}
	});

	it("has no current destination when the project is not repository-backed or the integration is not its own", () => {
		expect(current({ sourceOfTruth: "FABRIC" })).toBeNull();
		expect(current({ sync: null })).toBeNull();
		expect(current({ integration: null })).toBeNull();
		expect(
			current({
				integration: {
					projectId: "proj_other",
					provider: "GITHUB",
					repositoryUrl:
						"https://github.com/example-org/example-repo",
				},
			}),
		).toBeNull();
		expect(
			current({
				integration: {
					projectId: "proj_1",
					provider: "GITHUB",
					repositoryUrl: "https://example.com/not-a-repository",
				},
			}),
		).toBeNull();
	});

	it("round-trips a frozen branch destination and refuses a malformed one", () => {
		const frozen = proposalDestination(context, naming);
		expect(
			parseBranchDestination(JSON.parse(JSON.stringify(frozen))),
		).toEqual(frozen);
		expect(
			parseBranchDestination({ ...frozen, repositoryKey: "" }),
		).toBeNull();
		expect(
			parseBranchDestination({ ...frozen, provider: "GITLAB" }),
		).toBeNull();
		expect(parseBranchDestination("nope")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Branch states
// ---------------------------------------------------------------------------

describe("branch state moves (spec §4.4)", () => {
	it("allows exactly the table's moves", () => {
		expect(BRANCH_STATE_MOVES).toEqual({
			PENDING: [
				"OPENING",
				"BLOCKED",
				"CLOSE_REQUESTED",
				"CLOSED",
				"unchanged",
			],
			OPENING: [
				"OPEN",
				"MERGED",
				"CLOSED",
				"BLOCKED",
				"CLOSE_REQUESTED",
				"unchanged",
			],
			OPEN: ["MERGED", "CLOSED", "CLOSE_REQUESTED", "unchanged"],
			BLOCKED: [
				"OPEN",
				"MERGED",
				"CLOSED",
				"OPENING",
				"CLOSE_REQUESTED",
				"CANCELED",
				"unchanged",
			],
			CLOSE_REQUESTED: [
				"CLOSED",
				"CANCELED",
				"MERGED",
				"OPEN",
				"BLOCKED",
				"unchanged",
			],
			MERGED: ["CLOSED", "unchanged"],
			CLOSED: ["unchanged"],
			CANCELED: ["CLOSED", "MERGED", "unchanged"],
		});
	});

	it("never leaves CLOSED, and never reopens a merged or canceled branch", () => {
		expect(isLegalBranchMove("CLOSED", "OPEN")).toBe(false);
		expect(isLegalBranchMove("MERGED", "OPEN")).toBe(false);
		expect(isLegalBranchMove("CANCELED", "OPENING")).toBe(false);
		expect(isLegalBranchMove("OPEN", "BLOCKED")).toBe(false);
		expect(isLegalBranchMove("CLOSE_REQUESTED", "OPEN")).toBe(true);
	});

	it("refuses an illegal move, a fact column and an identity column before any statement", async () => {
		const updateMany = vi.fn();
		const tx = {
			projectInstructionProposalBranch: { updateMany },
		} as unknown as Prisma.TransactionClient;
		const base = {
			branchId: "b1",
			organizationId: "org_1",
			expectedAttempt: 2,
			bumpAttempt: true,
		};
		await expect(
			transitionBranch({ ...base, from: ["CLOSED"], to: "OPEN" }, tx),
		).rejects.toThrow(/Illegal branch transition/);
		for (const column of [
			"headSha",
			"startSha",
			"factsRevision",
			"foreignTipAt",
			"ref",
			"attempt",
			"untracked",
		]) {
			await expect(
				transitionBranch(
					{
						...base,
						from: ["OPEN"],
						to: "MERGED",
						data: { [column]: null } as never,
					},
					tx,
				),
			).rejects.toThrow(/never writes/);
		}
		await expect(
			transitionBranch({ ...base, from: [], to: "OPEN" }, tx),
		).rejects.toThrow(/names no source state/);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("writes one fenced update: state set, attempt bumped, JSON nulls as SQL NULL, never an untracked row", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			projectInstructionProposalBranch: { updateMany },
		} as unknown as Prisma.TransactionClient;
		const result = await transitionBranch(
			{
				branchId: "b1",
				organizationId: "org_1",
				from: ["OPENING", "BLOCKED"],
				expectedAttempt: 2,
				to: "OPEN",
				bumpAttempt: true,
				data: { failure: null, pullRequestExternalId: "7" },
			},
			tx,
		);
		expect(result).toEqual({ ok: true, attempt: 3 });
		const call = updateMany.mock.calls[0]?.[0];
		expect(call.where).toEqual({
			id: "b1",
			organizationId: "org_1",
			state: { in: ["OPENING", "BLOCKED"] },
			attempt: 2,
			untracked: false,
		});
		expect(call.data).toMatchObject({
			state: "OPEN",
			attempt: { increment: 1 },
			pullRequestExternalId: "7",
		});
		expect(call.data.failure).not.toBeNull();
		updateMany.mockResolvedValue({ count: 0 });
		expect(
			await transitionBranch(
				{
					branchId: "b1",
					organizationId: "org_1",
					from: ["OPEN"],
					expectedAttempt: 2,
					to: "unchanged",
					bumpAttempt: false,
				},
				tx,
			),
		).toEqual({ ok: false });
		expect(updateMany.mock.calls[1]?.[0].data).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// The queue head
// ---------------------------------------------------------------------------

const entry = (
	sequence: number,
	state: BranchQueueEntry["state"],
	over: Partial<BranchQueueEntry & { attempt: number }> = {},
): BranchQueueEntry & { assignment: number; attempt: number } => ({
	snapshotId: `s${sequence}`,
	sequence,
	state,
	status: "READY",
	proposalStatus: "PENDING",
	withdrawRequestedAt: null,
	failure: null,
	nextAttemptAt: null,
	assignment: 1,
	attempt: 4,
	...over,
});

const failure = (code: string, phase: string, retryable: boolean) => ({
	code,
	phase,
	retryable,
	at: "2026-09-27T10:00:00.000Z",
	params: {},
});

describe("pickRunnableHead (spec §6.1)", () => {
	it("claims the lowest QUEUED or OPENING sequence, READY and PENDING", () => {
		expect(
			pickRunnableHead([entry(3, "QUEUED"), entry(2, "QUEUED")], NOW),
		).toEqual({ kind: "claim", snapshotId: "s2" });
		expect(pickRunnableHead([entry(1, "OPENING")], NOW)).toEqual({
			kind: "claim",
			snapshotId: "s1",
		});
	});

	it("skips OPEN proposals and never lets a BLOCKED one hold the queue", () => {
		expect(
			pickRunnableHead(
				[
					entry(1, "OPEN"),
					entry(2, "BLOCKED", {
						failure: failure(
							"PUSH_OUTCOME_UNKNOWN",
							"append",
							false,
						),
					}),
					entry(3, "QUEUED"),
				],
				NOW,
			),
		).toEqual({ kind: "claim", snapshotId: "s3" });
	});

	it("claims a retryable, due BLOCKED proposal in phase append or validation", () => {
		const blocked = (phase: string, nextAttemptAt: Date | null) =>
			entry(1, "BLOCKED", {
				failure: failure("BRANCH_CONFLICT", phase, true),
				nextAttemptAt,
			});
		expect(pickRunnableHead([blocked("append", EARLIER)], NOW)).toEqual({
			kind: "claim",
			snapshotId: "s1",
		});
		expect(pickRunnableHead([blocked("validation", null)], NOW).kind).toBe(
			"claim",
		);
		expect(pickRunnableHead([blocked("append", LATER)], NOW).kind).toBe(
			"none",
		);
		expect(pickRunnableHead([blocked("create", null)], NOW).kind).toBe(
			"none",
		);
		expect(
			pickRunnableHead(
				[
					entry(1, "BLOCKED", {
						failure: failure("BRANCH_CONFLICT", "append", true),
						withdrawRequestedAt: EARLIER,
					}),
				],
				NOW,
			).kind,
		).toBe("none");
	});

	it("stops at a lower CLOSE_REQUESTED, and at a lower withdrawn QUEUED or OPENING", () => {
		expect(
			pickRunnableHead(
				[entry(1, "CLOSE_REQUESTED"), entry(2, "QUEUED")],
				NOW,
			),
		).toEqual({ kind: "none" });
		expect(
			pickRunnableHead(
				[
					entry(1, "QUEUED", { withdrawRequestedAt: EARLIER }),
					entry(2, "QUEUED"),
				],
				NOW,
			),
		).toEqual({ kind: "none" });
	});

	it("waits for a head still validating, and does not skip it", () => {
		expect(
			pickRunnableHead(
				[
					entry(1, "QUEUED", { status: "VALIDATING" }),
					entry(2, "QUEUED"),
				],
				NOW,
			),
		).toEqual({ kind: "wait", snapshotId: "s1" });
		expect(
			pickRunnableHead([entry(1, "QUEUED", { status: "RECEIVING" })], NOW)
				.kind,
		).toBe("wait");
		expect(
			pickRunnableHead(
				[
					entry(1, "QUEUED", { proposalStatus: "REJECTED" }),
					entry(2, "QUEUED"),
				],
				NOW,
			),
		).toEqual({ kind: "none" });
	});
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

describe("planOutcomeFact (spec §4.1 facts)", () => {
	const plan = (
		over: {
			op?: Partial<Parameters<typeof planOutcomeFact>[0]["op"]>;
			branch?: Partial<Parameters<typeof planOutcomeFact>[0]["branch"]>;
			outcome?: "acked" | "observed" | "not_pushed" | "unknown";
			foreignTip?: boolean;
		} = {},
	) =>
		planOutcomeFact({
			op: {
				kind: "APPEND",
				executionSeq: 2,
				sha: "c".repeat(40),
				parentSha: "b".repeat(40),
				outcome: null,
				...over.op,
			},
			branch: {
				state: "OPENING",
				headExecutionSeq: 1,
				startSha: "a".repeat(40),
				membership: null,
				foreignTipAt: null,
				...over.branch,
			},
			outcome: over.outcome ?? "acked",
			foreignTip: over.foreignTip ?? false,
			baseCommitSha: "f".repeat(40),
			now: NOW,
		});

	it("establishes an issued append: revision, head by sequence, pushAckedAt", () => {
		expect(plan()).toEqual({
			apply: true,
			refused: false,
			established: true,
			op: { outcome: "acked", pushAckedAt: NOW },
			branch: {
				factsRevisionIncrement: true,
				head: { sha: "c".repeat(40), executionSeq: 2 },
				startSha: null,
				pendingToOpening: false,
				membershipToPending: false,
				foreignTip: false,
			},
		});
	});

	it("never regresses the head for a late fact about an older operation", () => {
		const late = plan({
			op: { executionSeq: 1 },
			branch: { headExecutionSeq: 2 },
		});
		expect(late.established).toBe(true);
		expect(late.branch.head).toBeNull();
		expect(late.branch.factsRevisionIncrement).toBe(true);
	});

	it("records an observation with observedAt, and observed then acked without a second establishment", () => {
		expect(plan({ outcome: "observed" }).op).toEqual({
			outcome: "observed",
			observedAt: NOW,
		});
		const upgrade = plan({ op: { outcome: "observed" }, outcome: "acked" });
		expect(upgrade).toMatchObject({ apply: true, established: false });
		expect(upgrade.op).toEqual({ outcome: "acked", pushAckedAt: NOW });
		expect(upgrade.branch.factsRevisionIncrement).toBe(false);
		expect(upgrade.branch.head).toBeNull();
	});

	it("refuses a downgrade and writes nothing", () => {
		const refused = plan({ op: { outcome: "acked" }, outcome: "unknown" });
		expect(refused).toMatchObject({
			apply: false,
			refused: true,
			established: false,
			op: {},
		});
		expect(
			plan({ op: { outcome: "unknown" }, outcome: "not_pushed" }).refused,
		).toBe(true);
		expect(
			plan({ op: { outcome: "acked" }, outcome: "acked" }),
		).toMatchObject({
			apply: false,
			refused: false,
		});
	});

	it("writes an unknown or not_pushed outcome without establishing anything", () => {
		for (const outcome of ["unknown", "not_pushed"] as const) {
			const p = plan({ outcome });
			expect(p).toMatchObject({
				apply: true,
				established: false,
				op: { outcome },
			});
			expect(p.branch.factsRevisionIncrement).toBe(false);
		}
	});

	it("sets the first append's start and moves PENDING to OPENING; the create-only push starts at the base commit", () => {
		const first = plan({
			op: { executionSeq: 1, parentSha: null },
			branch: { state: "PENDING", headExecutionSeq: 0, startSha: null },
		});
		expect(first.branch).toMatchObject({
			startSha: "f".repeat(40),
			pendingToOpening: true,
		});
		const withParent = plan({
			branch: { state: "PENDING", startSha: null },
		});
		expect(withParent.branch.startSha).toBe("b".repeat(40));
		const revert = plan({
			op: { kind: "REVERT" },
			branch: { state: "PENDING", startSha: null },
		});
		expect(revert.branch).toMatchObject({
			startSha: null,
			pendingToOpening: false,
		});
	});

	it("resets a terminal branch's settled membership to pending on a new establishment", () => {
		for (const status of ["done", "unverified"]) {
			expect(
				plan({ branch: { state: "MERGED", membership: { status } } })
					.branch.membershipToPending,
			).toBe(true);
		}
		expect(
			plan({
				branch: { state: "MERGED", membership: { status: "pending" } },
			}).branch.membershipToPending,
		).toBe(false);
		expect(
			plan({ branch: { state: "OPEN", membership: { status: "done" } } })
				.branch.membershipToPending,
		).toBe(false);
	});

	it("marks a foreign tip once", () => {
		expect(plan({ foreignTip: true }).branch.foreignTip).toBe(true);
		expect(
			plan({ foreignTip: true, branch: { foreignTipAt: EARLIER } }).branch
				.foreignTip,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const blob = (oid: string) => ({ type: "blob" as const, mode: "100644", oid });

const e = (
	path: string,
	over: Partial<BranchOperationEntryRecord> = {},
): BranchOperationEntryRecord => ({
	path,
	rawPath: `.claude/${path}`,
	before: null,
	after: null,
	afterSha256: null,
	afterSource: null,
	beforeSource: null,
	...over,
});

describe("projectEntries (spec §10)", () => {
	it("projects established operations only, in execution order", () => {
		const ops = [
			{
				kind: "APPEND" as const,
				executionSeq: 2,
				outcome: "acked" as const,
				entries: [
					e("a.md", {
						before: blob("o1"),
						after: blob("o2"),
						afterSha256: "h2",
						afterSource: "s2",
						beforeSource: "s1",
					}),
				],
			},
			{
				kind: "APPEND" as const,
				executionSeq: 1,
				outcome: "observed" as const,
				entries: [
					e("a.md", {
						after: blob("o1"),
						afterSha256: "h1",
						afterSource: "s1",
					}),
					e("gone.md", { before: blob("o9") }),
				],
			},
			...(["unknown", "not_pushed", null] as const).map((outcome, n) => ({
				kind: "APPEND" as const,
				executionSeq: 10 + n,
				outcome,
				entries: [
					e("ignored.md", { after: blob("x"), afterSource: "sx" }),
				],
			})),
		];
		expect(projectEntries(ops)).toEqual([
			{ path: "a.md", state: "written", sha256: "h2", snapshotId: "s2" },
			{
				path: "gone.md",
				state: "deleted",
				sha256: null,
				snapshotId: null,
			},
		]);
	});

	it("restores a revert's before: written from its source with the recorded hash, deleted, or unavailable", () => {
		const append = {
			kind: "APPEND" as const,
			executionSeq: 1,
			outcome: "acked" as const,
			entries: [
				e("a.md", {
					after: blob("o1"),
					afterSha256: "h1",
					afterSource: "s1",
				}),
			],
		};
		const second = {
			kind: "APPEND" as const,
			executionSeq: 2,
			outcome: "acked" as const,
			entries: [
				e("a.md", {
					before: blob("o1"),
					beforeSource: "s1",
					after: blob("o2"),
					afterSha256: "h2",
					afterSource: "s2",
				}),
				e("new.md", {
					after: blob("o3"),
					afterSha256: "h3",
					afterSource: "s2",
				}),
				e("start.md", {
					before: blob("o0"),
					beforeSource: null,
					after: blob("o4"),
					afterSha256: "h4",
					afterSource: "s2",
				}),
			],
		};
		const revert = {
			kind: "REVERT" as const,
			executionSeq: 3,
			outcome: "acked" as const,
			entries: second.entries,
		};
		expect(projectEntries([append, second, revert])).toEqual([
			{ path: "a.md", state: "written", sha256: "h1", snapshotId: "s1" },
			{
				path: "new.md",
				state: "deleted",
				sha256: null,
				snapshotId: null,
			},
			{
				path: "start.md",
				state: "restored_unavailable",
				sha256: null,
				snapshotId: null,
			},
		]);
	});

	it("ignores an unestablished revert", () => {
		const append = {
			kind: "APPEND" as const,
			executionSeq: 1,
			outcome: "acked" as const,
			entries: [
				e("a.md", {
					after: blob("o1"),
					afterSha256: "h1",
					afterSource: "s1",
				}),
			],
		};
		expect(
			projectEntries([
				append,
				{
					kind: "REVERT",
					executionSeq: 2,
					outcome: "unknown",
					entries: append.entries,
				},
			]),
		).toEqual([
			{ path: "a.md", state: "written", sha256: "h1", snapshotId: "s1" },
		]);
	});

	it("parses stored entries, keeping only well-formed ones", () => {
		const good = e("a.md", {
			after: blob("o1"),
			afterSha256: "h1",
			afterSource: "s1",
		});
		expect(
			parseOperationEntries([
				good,
				{ ...good, path: "" },
				{ ...good, after: { type: "tree", mode: "040000", oid: "x" } },
				{ ...good, afterSource: 3 },
				"nope",
			]),
		).toEqual([good]);
		expect(parseOperationEntries(null)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The loop's next item
// ---------------------------------------------------------------------------

type BranchInput = BranchWorkInput["branch"];
const branch = (over: Partial<BranchInput> = {}): BranchInput => ({
	id: "b1",
	state: "OPEN",
	untracked: false,
	retiredAt: null,
	failure: null,
	closeIntent: null,
	createIssuedAt: null,
	pullRequestExternalId: "12",
	headSha: "c".repeat(40),
	membership: null,
	confirmationDueAt: null,
	nextAttemptAt: null,
	retryRequestedAt: null,
	settledAt: null,
	deletedAt: null,
	factsRevision: 3,
	...over,
});

const evop = (
	seq: number,
	outcome: EvidenceOp["outcome"],
	snapshotId = "s1",
	kind: EvidenceOp["kind"] = "APPEND",
): EvidenceOp & { snapshotId: string } => ({
	id: `op${seq}`,
	kind,
	executionSeq: seq,
	assignment: 1,
	branchId: "b1",
	outcome,
	snapshotId,
});

const work = (
	b: Partial<BranchInput>,
	ops: Array<EvidenceOp & { snapshotId: string }> = [],
	proposals: Array<
		BranchQueueEntry & { assignment: number; attempt: number }
	> = [],
) => decideBranchWork({ branch: branch(b), ops, proposals, now: NOW });

describe("decideBranchWork (spec §6 precedence)", () => {
	it("idles an untracked branch whatever else is due", () => {
		expect(
			work({ untracked: true, state: "CLOSE_REQUESTED" }, [
				evop(1, null),
			]),
		).toEqual({ kind: "idle", wakeAt: null });
	});

	it("recovers the lowest issued operation before anything else", () => {
		expect(
			work(
				{ state: "CLOSE_REQUESTED", confirmationDueAt: EARLIER },
				[evop(3, null), evop(2, null), evop(1, "acked")],
				[entry(1, "CLOSE_REQUESTED")],
			),
		).toEqual({ kind: "recover", operationId: "op2" });
	});

	it("runs a due confirmation before close", () => {
		expect(
			work({ state: "CLOSE_REQUESTED", confirmationDueAt: EARLIER }).kind,
		).toBe("confirm");
		expect(
			work({ state: "CLOSE_REQUESTED", confirmationDueAt: LATER }).kind,
		).toBe("close");
	});

	it("closes a CLOSE_REQUESTED branch before reverting its proposals, even with a create marker", () => {
		expect(
			work(
				{
					state: "CLOSE_REQUESTED",
					createIssuedAt: EARLIER,
					pullRequestExternalId: null,
				},
				[evop(1, "acked")],
				[entry(1, "CLOSE_REQUESTED")],
			),
		).toEqual({ kind: "close" });
	});

	it("releases a BLOCKED branch on a pre-create refusal with a head and no receipt or marker", () => {
		const blocked = {
			state: "BLOCKED" as const,
			pullRequestExternalId: null,
			failure: failure("PERMISSION_REVOKED", "create", false),
		};
		expect(work(blocked).kind).toBe("release");
		expect(
			isReleasableBranch(
				branch({
					...blocked,
					failure: failure("CONFIGURATION_CHANGED", "create", false),
				}),
			),
		).toBe(true);
		expect(
			isReleasableBranch(branch({ ...blocked, createIssuedAt: EARLIER })),
		).toBe(false);
		expect(isReleasableBranch(branch({ ...blocked, headSha: null }))).toBe(
			false,
		);
		expect(
			isReleasableBranch(
				branch({
					...blocked,
					failure: failure("REPOSITORY_CHANGED", "reconcile", false),
				}),
			),
		).toBe(false);
		expect(
			isReleasableBranch(
				branch({
					...blocked,
					failure: failure("PERMISSION_REVOKED", "create", true),
				}),
			),
		).toBe(false);
	});

	it("classifies pending membership with the facts revision it read", () => {
		expect(
			work({
				state: "MERGED",
				membership: { status: "pending", at: "x", attempts: 0 },
			}),
		).toEqual({ kind: "classify", factsRevision: 3 });
	});

	it("rehomes unpushed QUEUED or append-blocked proposals of a terminal or retired branch, in sequence order", () => {
		const proposals = [
			entry(3, "QUEUED"),
			entry(1, "BLOCKED", {
				failure: failure("BRANCH_CONFLICT", "append", true),
			}),
			entry(2, "QUEUED", { withdrawRequestedAt: EARLIER }),
			entry(4, "BLOCKED", {
				failure: failure("CONFIGURATION_CHANGED", "admission", false),
			}),
			entry(5, "QUEUED"),
		];
		const ops = [evop(1, "not_pushed", "s1"), evop(2, "unknown", "s5")];
		expect(work({ state: "MERGED" }, ops, proposals)).toEqual({
			kind: "rehome",
			snapshotIds: ["s1", "s3"],
		});
		expect(work({ retiredAt: EARLIER }, ops, proposals)).toEqual({
			kind: "rehome",
			snapshotIds: ["s1", "s3"],
		});
	});

	it("rehomes every live proposal once a START_OVER settlement deleted the ref", () => {
		const input: BranchWorkInput = {
			branch: branch({
				state: "CLOSE_REQUESTED",
				closeIntent: "START_OVER",
				deletedAt: EARLIER,
			}),
			ops: [evop(1, "acked", "s1")],
			proposals: [
				entry(1, "OPEN"),
				entry(2, "QUEUED"),
				entry(3, "CLOSE_REQUESTED"),
			],
			now: NOW,
		};
		expect(rehomableProposals(input)).toEqual(["s1", "s2"]);
		expect(
			rehomableProposals({
				...input,
				branch: branch({ closeIntent: "START_OVER" }),
			}),
		).toEqual([]);
	});

	it("reverts the lowest CLOSE_REQUESTED proposal on a live branch", () => {
		expect(
			work(
				{},
				[evop(1, "acked", "s2"), evop(2, "acked", "s4")],
				[
					entry(4, "CLOSE_REQUESTED"),
					entry(2, "CLOSE_REQUESTED"),
					entry(5, "QUEUED"),
				],
			),
		).toEqual({ kind: "revert", snapshotId: "s2", proposalAttempt: 4 });
	});

	it("waits for a revert's own backoff, so a retryable revert failure never hot-loops", () => {
		const proposals = [
			entry(2, "CLOSE_REQUESTED", {
				failure: failure("BRANCH_WRITE_REFUSED", "revert", true),
				nextAttemptAt: LATER,
			}),
		];
		const ops = [evop(1, "acked", "s2")];
		expect(work({}, ops, proposals)).toEqual({
			kind: "idle",
			wakeAt: LATER,
		});
		expect(
			work({}, ops, [
				{
					...(proposals[0] as (typeof proposals)[number]),
					nextAttemptAt: EARLIER,
				},
			]),
		).toEqual({ kind: "revert", snapshotId: "s2", proposalAttempt: 4 });
	});

	it("holds a closing or releasing branch on its own backoff, and nothing else runs meanwhile", () => {
		expect(
			work(
				{ state: "CLOSE_REQUESTED", nextAttemptAt: LATER },
				[evop(1, "acked")],
				[entry(1, "CLOSE_REQUESTED")],
			),
		).toEqual({ kind: "idle", wakeAt: LATER });
		expect(
			work({ state: "CLOSE_REQUESTED", nextAttemptAt: EARLIER }).kind,
		).toBe("close");
		const releasable = {
			state: "BLOCKED" as const,
			pullRequestExternalId: null,
			failure: failure("PERMISSION_REVOKED", "create", false),
		};
		expect(
			work(
				{ ...releasable, nextAttemptAt: LATER },
				[],
				[entry(1, "QUEUED")],
			),
		).toEqual({ kind: "idle", wakeAt: LATER });
		expect(work({ ...releasable, nextAttemptAt: EARLIER }).kind).toBe(
			"release",
		);
	});

	it("classifies only once a pending classification's own backoff is due", () => {
		const pending = (nextAttemptAt?: Date) => ({
			state: "MERGED" as const,
			membership: {
				status: "pending",
				at: "x",
				attempts: 1,
				...(nextAttemptAt
					? { nextAttemptAt: nextAttemptAt.toISOString() }
					: {}),
			},
		});
		expect(work(pending(LATER))).toEqual({ kind: "idle", wakeAt: LATER });
		expect(work(pending(EARLIER))).toEqual({
			kind: "classify",
			factsRevision: 3,
		});
		// Rehome does not wait for classification.
		expect(work(pending(LATER), [], [entry(1, "QUEUED")])).toEqual({
			kind: "rehome",
			snapshotIds: ["s1"],
		});
	});

	it("runs a Retry opening only while it is requested: every answer consumes it", () => {
		const refused = {
			state: "BLOCKED" as const,
			pullRequestExternalId: null,
			failure: failure("PR_CREATION_REFUSED", "create", false),
			// A marker lookup's backoff never delays a member's Retry opening.
			createIssuedAt: EARLIER,
			nextAttemptAt: LATER,
		};
		expect(work({ ...refused, retryRequestedAt: EARLIER }).kind).toBe(
			"retry",
		);
		expect(work({ ...refused, retryRequestedAt: null })).toEqual({
			kind: "idle",
			wakeAt: LATER,
		});
	});

	it("rehomes a stranded claim and a validation-timed-out proposal of a terminal branch", () => {
		const proposals = [
			entry(1, "OPENING"),
			entry(2, "BLOCKED", {
				failure: failure("VALIDATION_TIMEOUT", "validation", true),
			}),
			entry(3, "OPENING"),
		];
		// s3's claim issued an append that was not refused: never rehomed.
		const ops = [evop(1, "not_pushed", "s1"), evop(2, "unknown", "s3")];
		expect(work({ state: "CLOSED" }, ops, proposals)).toEqual({
			kind: "rehome",
			snapshotIds: ["s1", "s2"],
		});
	});

	it("runs a persisted Retry opening, then a due lookup, then a create", () => {
		expect(
			work({
				state: "BLOCKED",
				pullRequestExternalId: null,
				failure: failure("PR_CREATION_REFUSED", "create", false),
				retryRequestedAt: EARLIER,
			}).kind,
		).toBe("retry");
		expect(
			work({
				state: "OPENING",
				pullRequestExternalId: null,
				createIssuedAt: EARLIER,
			}).kind,
		).toBe("lookup");
		expect(
			work({
				state: "OPENING",
				pullRequestExternalId: null,
				createIssuedAt: EARLIER,
				nextAttemptAt: LATER,
			}),
		).toEqual({ kind: "idle", wakeAt: LATER });
		expect(
			work({ state: "OPENING", pullRequestExternalId: null }).kind,
		).toBe("create");
		expect(
			work({
				state: "BLOCKED",
				pullRequestExternalId: null,
				failure: failure("PROVIDER_UNAVAILABLE", "create", true),
				nextAttemptAt: EARLIER,
			}).kind,
		).toBe("create");
		expect(
			work({
				state: "OPENING",
				pullRequestExternalId: null,
				nextAttemptAt: LATER,
			}),
		).toEqual({ kind: "idle", wakeAt: LATER });
	});

	it("appends the runnable head, or waits for it to validate, only while the branch accepts appends", () => {
		expect(work({}, [], [entry(1, "QUEUED")])).toEqual({ kind: "append" });
		expect(
			work({}, [], [entry(1, "QUEUED", { status: "VALIDATING" })]),
		).toEqual({
			kind: "wait",
			snapshotId: "s1",
		});
		expect(
			work(
				{
					state: "BLOCKED",
					failure: failure(
						"ATTRIBUTION_REJECTED",
						"admission",
						false,
					),
				},
				[],
				[entry(1, "OPENING")],
			).kind,
		).toBe("idle");
	});

	it("idles with the earliest future confirmation as its timer", () => {
		expect(work({ confirmationDueAt: LATER })).toEqual({
			kind: "idle",
			wakeAt: LATER,
		});
		expect(work({})).toEqual({ kind: "idle", wakeAt: null });
	});
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe("isRetryableTransactionError (spec §4.7)", () => {
	it("retries serialization failures and deadlocks however the adapter wraps them", () => {
		expect(isRetryableTransactionError({ code: "P2034" })).toBe(true);
		expect(
			isRetryableTransactionError({
				code: "P2010",
				meta: { code: "40001" },
			}),
		).toBe(true);
		expect(
			isRetryableTransactionError({
				name: "DriverAdapterError",
				cause: { kind: "postgres", originalCode: "40P01" },
			}),
		).toBe(true);
		expect(
			isRetryableTransactionError(new Error("ERROR: deadlock detected")),
		).toBe(true);
		expect(
			isRetryableTransactionError(
				new Error(
					"could not serialize access due to concurrent update",
				),
			),
		).toBe(true);
	});

	it("does not retry anything else", () => {
		expect(isRetryableTransactionError({ code: "P2002" })).toBe(false);
		expect(isRetryableTransactionError(new Error("boom"))).toBe(false);
		expect(isRetryableTransactionError(null)).toBe(false);
	});
});

describe("reserveNextRef (spec Decision 3)", () => {
	it("takes the first free number from startN, never reusing a reserved one", async () => {
		const taken = new Set([
			"fabric/instructions/members/dev-example-user/2",
			"fabric/instructions/members/dev-example-user/3",
		]);
		const inserted: unknown[][] = [];
		const tx = {
			$queryRaw: vi.fn(
				async (strings: string[], ...values: unknown[]) => {
					const sql = strings.join("?");
					expect(sql).toContain(
						'ON CONFLICT ("repositoryKey", "ref") DO NOTHING',
					);
					const ref = values[3] as string;
					if (taken.has(ref)) {
						return [];
					}
					inserted.push(values);
					return [{ id: values[0] }];
				},
			),
		} as unknown as Prisma.TransactionClient;
		const result = await reserveNextRef(tx, {
			branchId: "b1",
			organizationId: "org_1",
			repositoryKey: "github:example-org/example-repo",
			displayName: "Dev Example",
			userId: "user_1",
			startN: 2,
			naming,
		});
		expect(result).toEqual({
			ref: "fabric/instructions/members/dev-example-user/4",
			n: 4,
		});
		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.slice(1, 5)).toEqual([
			"org_1",
			"github:example-org/example-repo",
			"fabric/instructions/members/dev-example-user/4",
			"b1",
		]);
	});

	it("refuses a ref outside the members prefix", async () => {
		const tx = {
			$queryRaw: vi.fn(),
		} as unknown as Prisma.TransactionClient;
		await expect(
			reserveNextRef(tx, {
				branchId: "b1",
				organizationId: "org_1",
				repositoryKey: "k",
				displayName: null,
				userId: "user_1",
				startN: 1,
				naming: { ...naming, memberBranchRef: () => "main" },
			}),
		).rejects.toThrow(/members\/ prefix/);
	});
});
