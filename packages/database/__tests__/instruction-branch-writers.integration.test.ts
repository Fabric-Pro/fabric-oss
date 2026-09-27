/**
 * The member proposal branch writers on a real Postgres (Fizzy #2738 spec
 * §4.1, §4.3, §4.4, §6.3-§6.7, §8): each one's fence (the attempt, the
 * facts revision, the confirmation count, the merge-sync tuple), what it
 * writes, and the audit row it owes; and the sweeper's selection, where a
 * #2563 row is taken only by #2563's clauses, a branch row only by the
 * branch sub-batches, and an untracked branch never. Self-skips without a
 * reachable database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	blockUnrehomableProposal,
	clearBranchMergeSyncRequest,
	commitBranchClassification,
	db,
	deferBranchClassification,
	deferBranchConfirmation,
	finalizeBranchNoOp,
	markBranchMergeSyncDispatched,
	type Prisma,
	proposalStatusForPullRequestState,
	readBranchWork,
	recordBranchConfirmation,
	recordBranchDeleted,
	recordBranchFailure,
	recordBranchMergeSyncRun,
	recordBranchObservation,
	recordBranchReceipt,
	recordBranchSettlement,
	refuseBranchStartOver,
	refuseBranchWithdrawal,
	releaseBlockedBranch,
	releaseBranchClaim,
	selectDueBranches,
	selectDueProposalOperations,
	setOperationMembership,
	transitionPullRequest,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `pr-branch-writers-org-${RUN_ID}`;
const USER_ID = `pr-branch-writers-user-${RUN_ID}`;
/**
 * More synthetic members: one accepting branch per member and project
 * (spec Decision 2, the partial unique index), so a fixture with several
 * accepting branches gives each its own member.
 */
const MEMBERS = Array.from(
	{ length: 20 },
	(_, n) => `pr-branch-writers-member-${n}-${RUN_ID}`,
);
const REPOSITORY_KEY = `github:example-org/writers-${RUN_ID}`;
let projectId = "";
let version = 0;
let branchNumber = 0;
let opSeq = 0;

const SHA = (c: string) => c.repeat(40);
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const ago = (ms: number) => new Date(Date.now() - ms);
const later = (ms: number) => new Date(Date.now() + ms);

const REPOSITORY = {
	provider: "GITHUB",
	owner: "example-org",
	repo: `writers-${RUN_ID}`,
} as const;

function contextV2() {
	return {
		v: 2,
		integrationId: "int_example",
		syncId: "sync_example",
		syncGeneration: 1,
		provider: "GITHUB",
		targetRef: "main",
		rootPath: "",
		baseCommitSha: SHA("a"),
		repository: REPOSITORY,
		author: { name: "Dev Example", email: "dev@example.com" },
		committer: { name: "Fabric", email: "fabric@example.com" },
		message: "Update instructions",
		committedAt: "2026-09-26T00:00:00Z",
	};
}

async function seedBranch(
	extra: Partial<Prisma.ProjectInstructionProposalBranchUncheckedCreateInput> = {},
): Promise<string> {
	branchNumber += 1;
	const row = await db.projectInstructionProposalBranch.create({
		data: {
			organizationId: ORGANIZATION_ID,
			projectId,
			userId: USER_ID,
			repositoryKey: REPOSITORY_KEY,
			number: branchNumber,
			ref: `fabric/instructions/members/dev-example-abcd/${branchNumber}`,
			state: "OPENING",
			attempt: 4,
			destination: {
				integrationId: "int_example",
				syncId: "sync_example",
				repositoryKey: REPOSITORY_KEY,
				provider: "GITHUB",
				repository: REPOSITORY,
				targetRef: "main",
				rootPath: "",
			},
			...extra,
		},
		select: { id: true },
	});
	return row.id;
}

type ProposalState =
	| "QUEUED"
	| "OPENING"
	| "OPEN"
	| "CLOSE_REQUESTED"
	| "BLOCKED"
	| "MERGED"
	| "CLOSED"
	| "CANCELED";

async function seedProposal(
	state: ProposalState,
	branchId: string | null,
	extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
): Promise<string> {
	version += 1;
	const row = await db.projectInstructionSnapshot.create({
		data: {
			projectId,
			organizationId: ORGANIZATION_ID,
			userId: USER_ID,
			version,
			source: "UPLOAD",
			status: "READY",
			settingsFrozen: {},
			publishOnReady: false,
			proposalStatus: "PENDING",
			proposalDestination: "REPOSITORY",
			pullRequestOperationId: `bw${RUN_ID.replace(/\D/g, "")}${version}`,
			pullRequestState: state,
			pullRequestAttempt: 4,
			pullRequestContext: contextV2(),
			...(branchId !== null
				? {
						proposalBranchId: branchId,
						proposalBranchSequence: version,
						proposalAssignment: 1,
					}
				: {}),
			...extra,
		},
		select: { id: true },
	});
	return row.id;
}

async function seedOp(
	branchId: string,
	snapshotId: string,
	kind: "APPEND" | "REVERT",
	outcome: string | null,
	extra: Partial<Prisma.ProjectInstructionProposalBranchOperationUncheckedCreateInput> = {},
): Promise<string> {
	opSeq += 1;
	const row = await db.projectInstructionProposalBranchOperation.create({
		data: {
			organizationId: ORGANIZATION_ID,
			branchId,
			snapshotId,
			kind,
			executionSeq: opSeq,
			ref: "fabric/instructions/members/dev-example-abcd/1",
			assignment: 1,
			attempt: 4,
			parentSha: SHA("b"),
			sha: SHA(String(opSeq % 10)),
			entries: [],
			pushIssuedAt: new Date(),
			outcome,
			...extra,
		},
		select: { id: true },
	});
	return row.id;
}

const branchOf = (id: string) =>
	db.projectInstructionProposalBranch.findUniqueOrThrow({ where: { id } });
const proposalOf = (id: string) =>
	db.projectInstructionSnapshot.findUniqueOrThrow({
		where: { id },
		select: {
			pullRequestState: true,
			pullRequestAttempt: true,
			pullRequestFailure: true,
			withdrawRequestedAt: true,
			withdrawScope: true,
			pendingCommand: true,
			pendingCommandSeq: true,
			proposalBranchId: true,
		},
	});
const opOf = (id: string) =>
	db.projectInstructionProposalBranchOperation.findUniqueOrThrow({
		where: { id },
		select: { membership: true, outcome: true },
	});
const auditsFor = (resourceId: string) =>
	db.auditLog.findMany({
		where: { organizationId: ORGANIZATION_ID, resourceId },
		select: { action: true, metadata: true },
		orderBy: { createdAt: "asc" },
	});

const ORG = ORGANIZATION_ID;
const observation = (
	state: "OPEN" | "MERGED" | "CLOSED",
	externalId = "7",
) => ({
	externalId,
	url: `https://example.com/example-org/writers/pull/${externalId}`,
	state,
	targetRef: "main",
	headSha: SHA("c"),
});
const failure = (phase: string, code: string, retryable: boolean) => ({
	phase,
	code,
	retryable,
	at: new Date().toISOString(),
	params: {},
});

describe.skipIf(!hasReachableDatabaseUrl())(
	"member proposal branch writers (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER_ID, ...MEMBERS]) {
				await db.user.create({
					data: {
						id,
						name: "Dev Example",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Proposal Branch Writers Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Proposal Branch Writers Integration",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
		});

		afterEach(async () => {
			await db.projectInstructionProposalBranchOperation.deleteMany({
				where: { organizationId: ORGANIZATION_ID },
			});
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalRefReservation.deleteMany({
				where: { organizationId: ORGANIZATION_ID },
			});
			await db.projectInstructionProposalBranch.deleteMany({
				where: { projectId },
			});
			// audit_log is append-only; tests purge their own rows the way
			// audit-log-seal.integration.test.ts does, scoped to this run's
			// synthetic organization.
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "organizationId" = ${ORGANIZATION_ID}`,
			]);
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({
				where: { id: { in: [USER_ID, ...MEMBERS] } },
			});
			await db.$disconnect();
		});

		// ---------------------------------------------------------------
		// Append-side writers (spec §6.3, §6.4, §6.8)
		// ---------------------------------------------------------------

		describe("finalizeBranchNoOp (spec §6.4 step 5)", () => {
			it("an append of the current submission still issued: BLOCKED PUSH_OUTCOME_UNKNOWN, attempt kept, command kept", async () => {
				const branchId = await seedBranch();
				const id = await seedProposal("OPENING", branchId, {
					pendingCommand: "APPEND",
					pendingCommandSeq: 2,
				});
				await seedOp(branchId, id, "APPEND", null);
				expect(
					await finalizeBranchNoOp({
						branchId,
						organizationId: ORG,
						snapshotId: id,
						proposalAttempt: 4,
					}),
				).toEqual({ kind: "blocked" });
				expect(await proposalOf(id)).toMatchObject({
					pullRequestState: "BLOCKED",
					pullRequestAttempt: 4,
					pullRequestFailure: expect.objectContaining({
						code: "PUSH_OUTCOME_UNKNOWN",
						phase: "append",
					}),
					pendingCommand: "APPEND",
				});
			});

			it("nothing unresolved: CANCELED ALREADY_ON_BRANCH, the command cleared, one reconciled row; a stale attempt moves nothing", async () => {
				const branchId = await seedBranch();
				const id = await seedProposal("OPENING", branchId, {
					pendingCommand: "APPEND",
					pendingCommandSeq: 2,
				});
				expect(
					await finalizeBranchNoOp({
						branchId,
						organizationId: ORG,
						snapshotId: id,
						proposalAttempt: 3,
					}),
				).toEqual({ kind: "moved" });
				expect(
					await finalizeBranchNoOp({
						branchId,
						organizationId: ORG,
						snapshotId: id,
						proposalAttempt: 4,
					}),
				).toEqual({ kind: "canceled" });
				expect(await proposalOf(id)).toMatchObject({
					pullRequestState: "CANCELED",
					pullRequestAttempt: 5,
					pullRequestFailure: expect.objectContaining({
						code: "ALREADY_ON_BRANCH",
					}),
					pendingCommand: null,
					pendingCommandSeq: null,
				});
				expect((await auditsFor(id)).map((a) => a.action)).toEqual([
					"project.instructions.pull_request_reconciled",
				]);
			});
		});

		describe("releaseBranchClaim (spec §6.3, §4.4 Retire)", () => {
			it("releases the claim at its attempt to QUEUED; the retirement is a fact that stands even when the claim moved", async () => {
				const branchId = await seedBranch({ state: "OPEN" });
				const id = await seedProposal("OPENING", branchId);
				expect(
					await releaseBranchClaim({
						branchId,
						organizationId: ORG,
						snapshotId: id,
						proposalAttempt: 3,
						retire: "BRANCH_MISSING",
					}),
				).toEqual({ released: false, retired: true });
				expect(await branchOf(branchId)).toMatchObject({
					retiredReason: "BRANCH_MISSING",
					retiredAt: expect.any(Date),
				});
				expect(
					await releaseBranchClaim({
						branchId,
						organizationId: ORG,
						snapshotId: id,
						proposalAttempt: 4,
					}),
				).toEqual({ released: true, retired: false });
				expect(await proposalOf(id)).toMatchObject({
					pullRequestState: "QUEUED",
					pullRequestAttempt: 5,
				});
			});
		});

		describe("refuseBranchWithdrawal (spec §6.8 step 2)", () => {
			it("back to OPEN with the failure; a change-scoped intent cleared, a branch-scoped one kept", async () => {
				const branchId = await seedBranch({ state: "OPEN" });
				const change = await seedProposal("CLOSE_REQUESTED", branchId, {
					withdrawRequestedAt: new Date(),
					withdrawScope: "change",
					pendingCommand: "WITHDRAW",
					pendingCommandSeq: 3,
				});
				// A Close after the withdrawal: intent `branch`, its command
				// cleared (the pending-withdraw-scope check).
				const scoped = await seedProposal("CLOSE_REQUESTED", branchId, {
					withdrawRequestedAt: new Date(),
					withdrawScope: "branch",
				});
				const conflict = failure("revert", "WITHDRAW_CONFLICT", false);
				for (const id of [change, scoped]) {
					expect(
						await refuseBranchWithdrawal({
							branchId,
							organizationId: ORG,
							snapshotId: id,
							proposalAttempt: 4,
							failure: conflict as never,
						}),
					).toEqual({ ok: true });
				}
				expect(await proposalOf(change)).toMatchObject({
					pullRequestState: "OPEN",
					pullRequestAttempt: 5,
					pullRequestFailure: expect.objectContaining({
						code: "WITHDRAW_CONFLICT",
					}),
					withdrawRequestedAt: null,
					withdrawScope: null,
					pendingCommand: null,
				});
				expect(await proposalOf(scoped)).toMatchObject({
					pullRequestState: "OPEN",
					withdrawRequestedAt: expect.any(Date),
					withdrawScope: "branch",
					pendingCommand: null,
				});
				// A stale attempt: nothing.
				expect(
					await refuseBranchWithdrawal({
						branchId,
						organizationId: ORG,
						snapshotId: change,
						proposalAttempt: 4,
						failure: conflict as never,
					}),
				).toEqual({ ok: false });
			});

			it("records the branch's REPOSITORY_CHANGED fact even when the proposal moved first", async () => {
				const branchId = await seedBranch({ state: "OPEN" });
				const id = await seedProposal("OPEN", branchId);
				const changed = failure("revert", "REPOSITORY_CHANGED", false);
				expect(
					await refuseBranchWithdrawal({
						branchId,
						organizationId: ORG,
						snapshotId: id,
						proposalAttempt: 4,
						failure: changed as never,
						branchFailure: changed as never,
					}),
				).toEqual({ ok: false });
				expect((await branchOf(branchId)).failure).toMatchObject({
					code: "REPOSITORY_CHANGED",
				});
			});
		});

		describe("recordBranchFailure", () => {
			it("writes the failure and backoff, never on an untracked branch", async () => {
				const branchId = await seedBranch();
				const next = later(HOUR_MS);
				expect(
					await recordBranchFailure({
						branchId,
						organizationId: ORG,
						failure: failure(
							"create",
							"PROVIDER_RATE_LIMITED",
							true,
						) as never,
						nextAttemptAt: next,
					}),
				).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					state: "OPENING",
					attempt: 4,
					failure: expect.objectContaining({
						code: "PROVIDER_RATE_LIMITED",
					}),
					nextAttemptAt: next,
				});
				const untracked = await seedBranch({
					state: "CLOSED",
					untracked: true,
				});
				expect(
					await recordBranchFailure({
						branchId: untracked,
						organizationId: ORG,
						failure: failure(
							"create",
							"PROVIDER_RATE_LIMITED",
							true,
						) as never,
					}),
				).toBe(false);
			});
		});

		describe("recordBranchReceipt (spec §6.5, §6.7 step 1)", () => {
			it("moves at the attempt read with the receipt, clearing the marker; one pull_request_opened", async () => {
				const branchId = await seedBranch({
					createIssuedAt: new Date(),
				});
				expect(
					await recordBranchReceipt({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						from: ["OPENING"],
						observation: observation("OPEN"),
						adopted: false,
					}),
				).toEqual({ kind: "moved" });
				expect(await branchOf(branchId)).toMatchObject({
					state: "OPEN",
					attempt: 5,
					pullRequestExternalId: "7",
					createIssuedAt: null,
					membership: null,
				});
				expect(
					(await auditsFor(branchId)).map((a) => a.action),
				).toEqual(["project.instructions.pull_request_opened"]);
			});

			it("an adoption already terminal: membership pending and one reconciled row too", async () => {
				const branchId = await seedBranch({ state: "BLOCKED" });
				expect(
					await recordBranchReceipt({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						from: ["BLOCKED"],
						observation: observation("MERGED"),
						adopted: true,
					}),
				).toEqual({ kind: "moved" });
				expect(await branchOf(branchId)).toMatchObject({
					state: "MERGED",
					membership: expect.objectContaining({ status: "pending" }),
				});
				expect(
					(await auditsFor(branchId)).map((a) => a.action).sort(),
				).toEqual(
					[
						"project.instructions.pull_request_opened",
						"project.instructions.pull_request_reconciled",
					].sort(),
				);
			});

			it("a branch that moved first keeps its state and records the receipt facts; another pull request is stale", async () => {
				const branchId = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "WITHDRAW",
					createIssuedAt: new Date(),
				});
				expect(
					await recordBranchReceipt({
						branchId,
						organizationId: ORG,
						expectedAttempt: 3,
						from: ["OPENING"],
						observation: observation("OPEN"),
						adopted: false,
					}),
				).toEqual({ kind: "facts" });
				expect(await branchOf(branchId)).toMatchObject({
					state: "CLOSE_REQUESTED",
					attempt: 4,
					pullRequestExternalId: "7",
					createIssuedAt: null,
				});
				expect(
					await recordBranchReceipt({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						from: ["CLOSE_REQUESTED"],
						observation: observation("OPEN", "8"),
						adopted: true,
					}),
				).toEqual({ kind: "stale" });
			});

			it("Start over's adoption ends settlement: closeIntent and the checkpoint cleared", async () => {
				const branchId = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "START_OVER",
					settlementPhase: "deleted",
				});
				expect(
					await recordBranchReceipt({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						from: ["CLOSE_REQUESTED"],
						observation: observation("OPEN"),
						adopted: true,
						endsSettlement: true,
					}),
				).toEqual({ kind: "moved" });
				expect(await branchOf(branchId)).toMatchObject({
					state: "OPEN",
					closeIntent: null,
					settlementPhase: null,
				});
			});
		});

		describe("recordBranchObservation (spec §6.3, §6.6 Observation)", () => {
			it("observes at the attempt the sweeper read, releasing a claim in the same transaction", async () => {
				const branchId = await seedBranch({
					state: "OPEN",
					pullRequestExternalId: "7",
				});
				const id = await seedProposal("OPENING", branchId);
				expect(
					await recordBranchObservation({
						branchId,
						organizationId: ORG,
						observation: observation("MERGED"),
						expectedAttempt: 3,
					}),
				).toEqual({ observed: false, released: false });
				expect((await branchOf(branchId)).state).toBe("OPEN");
				expect(
					await recordBranchObservation({
						branchId,
						organizationId: ORG,
						observation: observation("MERGED"),
						expectedAttempt: 4,
						release: { snapshotId: id, proposalAttempt: 4 },
					}),
				).toEqual({ observed: true, released: true });
				expect(await branchOf(branchId)).toMatchObject({
					state: "MERGED",
					attempt: 5,
					membership: expect.objectContaining({ status: "pending" }),
					pullRequestObservation: expect.objectContaining({
						headSha: SHA("c"),
						targetMismatch: false,
					}),
				});
				expect(await proposalOf(id)).toMatchObject({
					pullRequestState: "QUEUED",
				});
				expect(
					(await auditsFor(branchId)).map((a) => a.action),
				).toEqual(["project.instructions.pull_request_reconciled"]);
			});
		});

		describe("releaseBlockedBranch (spec §4.4 Release)", () => {
			it("a releasable branch becomes CANCELED and settled, its proposals CANCELED with its code; a stale attempt, nothing", async () => {
				const branchId = await seedBranch({
					state: "BLOCKED",
					headSha: SHA("d"),
					failure: failure("create", "PERMISSION_REVOKED", false),
				});
				const id = await seedProposal("OPEN", branchId, {
					pendingCommand: "APPEND",
					pendingCommandSeq: 2,
				});
				expect(
					await releaseBlockedBranch({
						branchId,
						organizationId: ORG,
						expectedAttempt: 3,
						refDeleted: true,
					}),
				).toEqual({ ok: false, canceled: 0 });
				expect(
					await releaseBlockedBranch({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						refDeleted: true,
					}),
				).toEqual({ ok: true, canceled: 1 });
				const b = await branchOf(branchId);
				expect(b).toMatchObject({
					state: "CANCELED",
					attempt: 5,
					confirmations: 0,
					settledAt: expect.any(Date),
					deletedAt: expect.any(Date),
				});
				expect(
					(b.confirmationDueAt as Date).getTime() -
						(b.settledAt as Date).getTime(),
				).toBe(HOUR_MS);
				expect(await proposalOf(id)).toMatchObject({
					pullRequestState: "CANCELED",
					pullRequestFailure: expect.objectContaining({
						code: "PERMISSION_REVOKED",
					}),
					pendingCommand: null,
				});
			});

			it("a branch with a create marker is not releasable", async () => {
				const branchId = await seedBranch({
					state: "BLOCKED",
					headSha: SHA("d"),
					createIssuedAt: new Date(),
					failure: failure("create", "PERMISSION_REVOKED", false),
				});
				expect(
					await releaseBlockedBranch({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						refDeleted: false,
					}),
				).toEqual({ ok: false, canceled: 0 });
			});
		});

		// ---------------------------------------------------------------
		// Classification (spec §6.6, Decision 14)
		// ---------------------------------------------------------------

		describe("setOperationMembership", () => {
			it("writes a fact on the operation's identity; included is never downgraded", async () => {
				const branchId = await seedBranch({ state: "MERGED" });
				const id = await seedProposal("OPEN", branchId);
				const op = await seedOp(branchId, id, "APPEND", "acked");
				const set = (membership: "included" | "unverified") =>
					setOperationMembership({
						operationId: op,
						organizationId: ORG,
						membership,
					});
				expect(await set("unverified")).toBe(true);
				expect(await set("included")).toBe(true);
				expect(await set("unverified")).toBe(false);
				expect((await opOf(op)).membership).toBe("included");
				expect(await set("included")).toBe(true);
				expect(
					await setOperationMembership({
						operationId: op,
						organizationId: "org_other_example",
						membership: "included",
					}),
				).toBe(false);
			});
		});

		describe("commitBranchClassification", () => {
			async function mergedBranch(
				extra: Partial<Prisma.ProjectInstructionProposalBranchUncheckedCreateInput> = {},
			) {
				return seedBranch({
					state: "MERGED",
					factsRevision: 3,
					pullRequestExternalId: "7",
					membership: {
						status: "pending",
						at: new Date().toISOString(),
						attempts: 2,
					},
					...extra,
				});
			}

			it("applies Decision 14 at the facts revision: outcome, withdrawn, rehome left; membership done; merge sync requested once", async () => {
				const branchId = await mergedBranch();
				const appended = await seedProposal("OPEN", branchId);
				await seedOp(branchId, appended, "APPEND", "acked", {
					membership: "included",
				});
				const withdrawn = await seedProposal("OPENING", branchId, {
					withdrawRequestedAt: new Date(),
					withdrawScope: "branch",
				});
				const waiting = await seedProposal("QUEUED", branchId);
				const commit = (factsRevision: number) =>
					commitBranchClassification({
						branchId,
						organizationId: ORG,
						factsRevision,
						status: "done",
					});
				expect(await commit(2)).toEqual({
					kind: "stale_revision",
					moved: 0,
					mergeSyncRequested: false,
				});
				expect(await commit(3)).toEqual({
					kind: "done",
					moved: 2,
					mergeSyncRequested: true,
				});
				expect(await proposalOf(appended)).toMatchObject({
					pullRequestState: "MERGED",
					pullRequestAttempt: 5,
				});
				expect(await proposalOf(withdrawn)).toMatchObject({
					pullRequestState: "CANCELED",
				});
				expect(await proposalOf(waiting)).toMatchObject({
					pullRequestState: "QUEUED",
					pullRequestAttempt: 4,
				});
				const b = await branchOf(branchId);
				expect(b.membership).toMatchObject({
					status: "done",
					attempts: 2,
				});
				expect(b.mergeSyncRequestedAt).toEqual(expect.any(Date));
				expect(
					(await auditsFor(appended)).map((a) => a.metadata),
				).toEqual([
					expect.objectContaining({
						outcome: "merged",
						branchId,
						reason: "outcome",
						targetMismatch: false,
					}),
				]);
				// No longer pending: nothing more.
				expect((await commit(3)).kind).toBe("not_pending");
				// Re-pended by a late fact: classified again, merge sync not asked again.
				await db.projectInstructionProposalBranch.update({
					where: { id: branchId },
					data: {
						membership: {
							status: "pending",
							at: new Date().toISOString(),
							attempts: 0,
						},
						mergeSyncRequestedAt: null,
						mergeSyncRunId: "run_example_done",
					},
				});
				expect(await commit(3)).toMatchObject({
					kind: "done",
					mergeSyncRequested: false,
				});
			});

			/** CANCELED by its member's withdrawal, as the revert's evidence leaves it. */
			const canceled = (
				branchId: string,
				extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
			) =>
				seedProposal("CANCELED", branchId, {
					proposalStatus:
						proposalStatusForPullRequestState("CANCELED"),
					withdrawRequestedAt: ago(MINUTE_MS),
					withdrawScope: "change",
					...extra,
				});

			it.each(["MERGED", "CLOSED"] as const)(
				"a merge racing the revert (Decision 14): a revert-CANCELED proposal whose append is included and revert is not takes %s; no other CANCELED one moves",
				async (outcome) => {
					const branchId = await mergedBranch({ state: outcome });
					const raced = await canceled(branchId);
					await seedOp(branchId, raced, "APPEND", "acked", {
						membership: "included",
					});
					const racedRevert = await seedOp(
						branchId,
						raced,
						"REVERT",
						"observed",
						{ membership: "unverified" },
					);
					// Both included: the revert reached the pull request.
					const reverted = await canceled(branchId);
					await seedOp(branchId, reverted, "APPEND", "acked", {
						membership: "included",
					});
					await seedOp(branchId, reverted, "REVERT", "acked", {
						membership: "included",
					});
					// Its append not included: left as before the branch settled.
					const unproved = await canceled(branchId);
					await seedOp(branchId, unproved, "APPEND", "acked", {
						membership: "unverified",
					});
					await seedOp(branchId, unproved, "REVERT", "acked", {
						membership: "unverified",
					});
					// The revert is of an earlier submission, not the current one.
					const reassigned = await canceled(branchId, {
						proposalAssignment: 2,
					});
					await seedOp(branchId, reassigned, "APPEND", "acked", {
						membership: "included",
					});
					await seedOp(branchId, reassigned, "REVERT", "acked", {
						membership: "unverified",
					});
					// Never appended: withdrawn before its turn.
					const neverAppended = await canceled(branchId);

					const commit = () =>
						commitBranchClassification({
							branchId,
							organizationId: ORG,
							factsRevision: 3,
							status: "done",
						});
					expect(await commit()).toMatchObject({
						kind: "done",
						moved: 1,
					});
					expect(await proposalOf(raced)).toMatchObject({
						pullRequestState: outcome,
						pullRequestAttempt: 5,
					});
					expect(
						(
							await db.projectInstructionSnapshot.findUniqueOrThrow(
								{
									where: { id: raced },
									select: { proposalStatus: true },
								},
							)
						).proposalStatus,
					).toBe(proposalStatusForPullRequestState(outcome));
					expect(await auditsFor(raced)).toEqual([
						{
							action: "project.instructions.pull_request_reconciled",
							metadata: expect.objectContaining({
								outcome: outcome.toLowerCase(),
								branchId,
								reason: "outcome",
							}),
						},
					]);
					for (const id of [
						reverted,
						unproved,
						reassigned,
						neverAppended,
					]) {
						expect(await proposalOf(id)).toMatchObject({
							pullRequestState: "CANCELED",
							pullRequestAttempt: 4,
						});
						expect(await auditsFor(id)).toEqual([]);
					}

					// A late fact re-pends the branch, and the revert is now
					// counted included: the proposal already took the outcome and
					// is never classified again.
					await setOperationMembership({
						operationId: racedRevert,
						organizationId: ORG,
						membership: "included",
					});
					await db.projectInstructionProposalBranch.update({
						where: { id: branchId },
						data: {
							factsRevision: 4,
							membership: {
								status: "pending",
								at: new Date().toISOString(),
								attempts: 0,
							},
						},
					});
					expect(
						await commitBranchClassification({
							branchId,
							organizationId: ORG,
							factsRevision: 4,
							status: "done",
						}),
					).toMatchObject({ kind: "done", moved: 0 });
					expect(await proposalOf(raced)).toMatchObject({
						pullRequestState: outcome,
						pullRequestAttempt: 5,
					});
					expect(await auditsFor(raced)).toHaveLength(1);
				},
			);

			it("branch_settled takes a CANCELED proposal only when its current withdrawal is an established revert on its current branch", async () => {
				const branchId = await mergedBranch();
				const otherBranch = await mergedBranch({
					userId: MEMBERS[0],
					pullRequestExternalId: "8",
				});
				const settle = (id: string, assignment = 1) =>
					transitionPullRequest({
						snapshotId: id,
						organizationId: ORG,
						event: "branch_settled",
						from: ["CANCELED"],
						expectedAttempt: 4,
						to: "MERGED",
						bumpAttempt: true,
						branch: { id: branchId, assignment },
						audit: {
							action: "project.instructions.pull_request_reconciled",
							category: "project",
							actor: { type: "system" },
							organizationId: ORG,
							projectId,
							resource: {
								type: "project_instruction_snapshot",
								id,
							},
							metadata: { branchId, reason: "outcome" },
						},
					});
				const accepted: string[] = [];
				const expectRefused = async (label: string, id: string) => {
					if ((await settle(id)).ok) {
						accepted.push(label);
					}
					expect(await proposalOf(id)).toMatchObject({
						pullRequestState: "CANCELED",
						pullRequestAttempt: 4,
					});
				};

				// No withdrawal at all.
				const noRevert = await canceled(branchId);
				await seedOp(branchId, noRevert, "APPEND", "acked");
				await expectRefused("no revert", noRevert);
				// The current revert is unknown, still issued, or not pushed.
				for (const outcome of ["unknown", null, "not_pushed"]) {
					const id = await canceled(branchId);
					await seedOp(branchId, id, "APPEND", "acked");
					await seedOp(branchId, id, "REVERT", outcome);
					await expectRefused(`revert ${outcome}`, id);
				}
				// An established revert superseded by a later one still issued.
				const superseded = await canceled(branchId);
				await seedOp(branchId, superseded, "APPEND", "acked");
				await seedOp(branchId, superseded, "REVERT", "acked");
				await seedOp(branchId, superseded, "REVERT", null);
				await expectRefused("superseded revert", superseded);
				// An established revert before the current append.
				const reappended = await canceled(branchId);
				await seedOp(branchId, reappended, "APPEND", "acked");
				await seedOp(branchId, reappended, "REVERT", "acked");
				await seedOp(branchId, reappended, "APPEND", "acked");
				await expectRefused(
					"revert before the current append",
					reappended,
				);
				// An established revert under another assignment or branch.
				const reassigned = await canceled(branchId, {
					proposalAssignment: 2,
				});
				await seedOp(branchId, reassigned, "APPEND", "acked", {
					assignment: 2,
				});
				await seedOp(branchId, reassigned, "REVERT", "acked", {
					assignment: 1,
				});
				expect((await settle(reassigned, 2)).ok).toBe(false);
				const moved = await canceled(branchId);
				await seedOp(otherBranch, moved, "APPEND", "acked");
				await seedOp(otherBranch, moved, "REVERT", "acked");
				await expectRefused("revert on another branch", moved);
				expect(accepted).toEqual([]);
				expect(
					await db.auditLog.count({
						where: { organizationId: ORG },
					}),
				).toBe(0);

				// A not_pushed revert after an established one leaves the
				// established one current.
				const current = await canceled(branchId);
				await seedOp(branchId, current, "APPEND", "acked");
				await seedOp(branchId, current, "REVERT", "observed");
				await seedOp(branchId, current, "REVERT", "not_pushed");
				expect(await settle(current)).toEqual({ ok: true, attempt: 5 });
				expect((await proposalOf(current)).pullRequestState).toBe(
					"MERGED",
				);
				// And a MERGED or CLOSED proposal has no arm at all.
				for (const state of ["MERGED", "CLOSED"] as const) {
					const id = await seedProposal(state, branchId, {
						proposalStatus:
							proposalStatusForPullRequestState(state),
					});
					await expect(
						transitionPullRequest({
							snapshotId: id,
							organizationId: ORG,
							event: "branch_settled",
							from: [state],
							expectedAttempt: 4,
							to: state === "MERGED" ? "CLOSED" : "MERGED",
							bumpAttempt: true,
							branch: { id: branchId, assignment: 1 },
						}),
					).rejects.toThrow(/Illegal pull-request transition/);
				}
			});

			it("an issued operation is recovery's first: stale_revision, nothing written", async () => {
				const branchId = await mergedBranch();
				const id = await seedProposal("OPEN", branchId);
				await seedOp(branchId, id, "APPEND", null);
				expect(
					await commitBranchClassification({
						branchId,
						organizationId: ORG,
						factsRevision: 3,
						status: "done",
					}),
				).toMatchObject({ kind: "stale_revision" });
				expect((await proposalOf(id)).pullRequestState).toBe("OPEN");
				expect((await branchOf(branchId)).membership).toMatchObject({
					status: "pending",
				});
			});

			it("a target mismatch never requests the merge sync", async () => {
				const branchId = await mergedBranch({
					pullRequestObservation: {
						targetRef: "develop",
						targetMismatch: true,
					},
				});
				expect(
					await commitBranchClassification({
						branchId,
						organizationId: ORG,
						factsRevision: 3,
						status: "unverified",
					}),
				).toEqual({
					kind: "done",
					moved: 0,
					mergeSyncRequested: false,
				});
				expect(await branchOf(branchId)).toMatchObject({
					membership: expect.objectContaining({
						status: "unverified",
					}),
					mergeSyncRequestedAt: null,
				});
			});
		});

		describe("deferBranchClassification", () => {
			it("counts the try and sets its backoff, keeping when the membership became pending", async () => {
				const at = ago(HOUR_MS).toISOString();
				const branchId = await seedBranch({
					state: "CLOSED",
					factsRevision: 2,
					membership: { status: "pending", at, attempts: 1 },
				});
				expect(
					await deferBranchClassification({
						branchId,
						organizationId: ORG,
						factsRevision: 1,
						delayMs: 5 * MINUTE_MS,
					}),
				).toBe(false);
				const before = Date.now();
				expect(
					await deferBranchClassification({
						branchId,
						organizationId: ORG,
						factsRevision: 2,
						delayMs: 5 * MINUTE_MS,
					}),
				).toBe(true);
				const m = (await branchOf(branchId)).membership as {
					at: string;
					attempts: number;
					nextAttemptAt: string;
				};
				expect(m).toMatchObject({ status: "pending", at, attempts: 2 });
				const next = Date.parse(m.nextAttemptAt);
				expect(next).toBeGreaterThanOrEqual(
					before + 5 * MINUTE_MS - MINUTE_MS,
				);
				expect(next).toBeLessThanOrEqual(
					Date.now() + 5 * MINUTE_MS + MINUTE_MS,
				);
			});
		});

		// ---------------------------------------------------------------
		// Settlement (spec §6.7)
		// ---------------------------------------------------------------

		describe("recordBranchSettlement", () => {
			it("CANCELED with no pull request: the withdrawn proposals CANCELED, those holding intent left, settled with the 1 h confirmation", async () => {
				const branchId = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "START_OVER",
					settlementPhase: "deleted",
				});
				const withdrawn = await seedProposal("OPEN", branchId, {
					withdrawRequestedAt: new Date(),
					withdrawScope: "branch",
				});
				const holding = await seedProposal("OPEN", branchId);
				expect(
					await recordBranchSettlement({
						branchId,
						organizationId: ORG,
						expectedAttempt: 3,
						outcome: "CANCELED",
					}),
				).toEqual({ ok: false, canceled: 0 });
				expect(
					await recordBranchSettlement({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						outcome: "CANCELED",
					}),
				).toEqual({ ok: true, canceled: 1 });
				const b = await branchOf(branchId);
				expect(b).toMatchObject({
					state: "CANCELED",
					attempt: 5,
					closeIntent: "START_OVER",
					settlementPhase: "recorded",
					confirmations: 0,
					membership: null,
				});
				expect(
					(b.confirmationDueAt as Date).getTime() -
						(b.settledAt as Date).getTime(),
				).toBe(HOUR_MS);
				expect((await proposalOf(withdrawn)).pullRequestState).toBe(
					"CANCELED",
				);
				expect((await proposalOf(holding)).pullRequestState).toBe(
					"OPEN",
				);
				expect(
					(await auditsFor(branchId)).map((a) => a.metadata),
				).toEqual([
					expect.objectContaining({
						outcome: "canceled",
						closeIntent: "START_OVER",
						canceled: 1,
					}),
				]);
			});

			it("a pull request found: CLOSED with its receipt and membership pending, no proposal moved yet", async () => {
				const branchId = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "WITHDRAW",
				});
				const id = await seedProposal("OPEN", branchId, {
					withdrawRequestedAt: new Date(),
					withdrawScope: "branch",
				});
				expect(
					await recordBranchSettlement({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						outcome: "CLOSED",
						observation: observation("CLOSED"),
					}),
				).toEqual({ ok: true, canceled: 0 });
				expect(await branchOf(branchId)).toMatchObject({
					state: "CLOSED",
					pullRequestExternalId: "7",
					membership: expect.objectContaining({ status: "pending" }),
					settlementPhase: "recorded",
				});
				expect((await proposalOf(id)).pullRequestState).toBe("OPEN");
				await expect(
					recordBranchSettlement({
						branchId,
						organizationId: ORG,
						expectedAttempt: 5,
						outcome: "CANCELED",
						observation: observation("CLOSED"),
					}),
				).rejects.toThrow(/observation exactly when/);
			});
		});

		describe("refuseBranchStartOver (spec §6.7 steps 0, 2)", () => {
			it("back to BLOCKED START_OVER_REFUSED, the intent and checkpoint cleared; foreignTipAt set once", async () => {
				const first = ago(HOUR_MS);
				const branchId = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "START_OVER",
					settlementPhase: "deleted",
					foreignTipAt: first,
				});
				expect(
					await refuseBranchStartOver({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						foreign: true,
					}),
				).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					state: "BLOCKED",
					attempt: 5,
					closeIntent: null,
					settlementPhase: null,
					foreignTipAt: first,
					failure: expect.objectContaining({
						code: "START_OVER_REFUSED",
						retryable: false,
					}),
				});
				const fresh = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "START_OVER",
					userId: MEMBERS[0],
				});
				await refuseBranchStartOver({
					branchId: fresh,
					organizationId: ORG,
					expectedAttempt: 4,
					foreign: true,
				});
				expect((await branchOf(fresh)).foreignTipAt).toEqual(
					expect.any(Date),
				);
			});

			it("never refuses a Close (WITHDRAW) or a stale attempt", async () => {
				const branchId = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "WITHDRAW",
				});
				expect(
					await refuseBranchStartOver({
						branchId,
						organizationId: ORG,
						expectedAttempt: 4,
						foreign: false,
					}),
				).toBe(false);
				const other = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "START_OVER",
				});
				expect(
					await refuseBranchStartOver({
						branchId: other,
						organizationId: ORG,
						expectedAttempt: 3,
						foreign: false,
					}),
				).toBe(false);
			});
		});

		describe("recordBranchDeleted (spec §6.7 checkpoint)", () => {
			it("marks the deletion once, at the attempt settlement read", async () => {
				const branchId = await seedBranch({
					state: "CLOSE_REQUESTED",
					closeIntent: "START_OVER",
				});
				const mark = (expectedAttempt: number) =>
					recordBranchDeleted({
						branchId,
						organizationId: ORG,
						expectedAttempt,
					});
				expect(await mark(3)).toBe(false);
				expect(await mark(4)).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					state: "CLOSE_REQUESTED",
					attempt: 4,
					settlementPhase: "deleted",
					deletedAt: expect.any(Date),
				});
				expect(await mark(4)).toBe(false);
			});
		});

		describe("recordBranchConfirmation / deferBranchConfirmation (spec §6.7 step 4)", () => {
			it("the first confirmation moves the due time to 24 h after settledAt and a late closed pull request makes a CANCELED branch CLOSED; the second clears the marker", async () => {
				const settledAt = ago(HOUR_MS);
				const branchId = await seedBranch({
					state: "CANCELED",
					settledAt,
					confirmationDueAt: ago(0),
					createIssuedAt: ago(2 * HOUR_MS),
				});
				const confirm = (
					confirmations: number,
					found?: Parameters<
						typeof recordBranchConfirmation
					>[0]["found"],
				) =>
					recordBranchConfirmation({
						branchId,
						organizationId: ORG,
						confirmations,
						...(found ? { found } : {}),
					});
				expect(await confirm(1)).toBe(false);
				expect(
					await confirm(0, {
						observation: observation("CLOSED", "9"),
						to: "CLOSED",
					}),
				).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					state: "CLOSED",
					attempt: 5,
					confirmations: 1,
					confirmationDueAt: new Date(
						settledAt.getTime() + 24 * HOUR_MS,
					),
					pullRequestExternalId: "9",
					membership: expect.objectContaining({ status: "pending" }),
				});
				expect(
					(await auditsFor(branchId)).map((a) => a.metadata),
				).toEqual([
					expect.objectContaining({
						outcome: "closed",
						externalId: "9",
						confirmation: 1,
					}),
				]);
				expect(await confirm(1)).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					confirmations: 2,
					confirmationDueAt: null,
					createIssuedAt: null,
				});
			});

			it("a confirmation that could not look moves only its due time, conditional on the count", async () => {
				const branchId = await seedBranch({
					state: "CANCELED",
					settledAt: ago(HOUR_MS),
					confirmationDueAt: ago(0),
					confirmations: 1,
				});
				expect(
					await deferBranchConfirmation({
						branchId,
						organizationId: ORG,
						confirmations: 0,
						delayMs: 15 * MINUTE_MS,
					}),
				).toBe(false);
				const before = Date.now();
				expect(
					await deferBranchConfirmation({
						branchId,
						organizationId: ORG,
						confirmations: 1,
						delayMs: 15 * MINUTE_MS,
					}),
				).toBe(true);
				const b = await branchOf(branchId);
				expect(b.confirmations).toBe(1);
				const due = (b.confirmationDueAt as Date).getTime();
				expect(due).toBeGreaterThanOrEqual(before + 14 * MINUTE_MS);
				expect(due).toBeLessThanOrEqual(Date.now() + 16 * MINUTE_MS);
			});
		});

		// ---------------------------------------------------------------
		// Rehome refusal (spec §4.3 Rehome) and the loop's read
		// ---------------------------------------------------------------

		describe("blockUnrehomableProposal", () => {
			it("a still-rehomable proposal becomes BLOCKED CONFIGURATION_CHANGED in phase admission; any other, nothing", async () => {
				const branchId = await seedBranch({
					state: "MERGED",
					membership: {
						status: "done",
						at: new Date().toISOString(),
						attempts: 0,
					},
				});
				const queued = await seedProposal("QUEUED", branchId);
				const appended = await seedProposal("OPEN", branchId);
				await seedOp(branchId, appended, "APPEND", "acked", {
					membership: "included",
				});
				expect(
					(await readBranchWork({ branchId, organizationId: ORG }))
						.work,
				).toEqual({ kind: "rehome", snapshotIds: [queued] });
				const block = (snapshotId: string) =>
					blockUnrehomableProposal({
						branchId,
						organizationId: ORG,
						snapshotId,
					});
				expect(await block(appended)).toBe(false);
				expect(await block(queued)).toBe(true);
				expect(await proposalOf(queued)).toMatchObject({
					pullRequestState: "BLOCKED",
					pullRequestAttempt: 5,
					proposalBranchId: branchId,
					pullRequestFailure: expect.objectContaining({
						phase: "admission",
						code: "CONFIGURATION_CHANGED",
						retryable: false,
					}),
				});
				expect(await block(queued)).toBe(false);
				// The loop never offers it again.
				expect(
					(await readBranchWork({ branchId, organizationId: ORG }))
						.work,
				).toMatchObject({ kind: "idle" });
			});
		});

		describe("readBranchWork", () => {
			it("recovery first, with the branch attempt and the database clock of the same read; an untracked branch idles", async () => {
				const branchId = await seedBranch({ state: "CLOSE_REQUESTED" });
				const id = await seedProposal("OPEN", branchId);
				const op = await seedOp(branchId, id, "APPEND", null);
				const read = await readBranchWork({
					branchId,
					organizationId: ORG,
				});
				expect(read).toMatchObject({
					work: { kind: "recover", operationId: op },
					branchAttempt: 4,
				});
				expect(
					Math.abs(read.databaseNow.getTime() - Date.now()),
				).toBeLessThan(MINUTE_MS);
				const untracked = await seedBranch({
					state: "CLOSED",
					untracked: true,
					confirmationDueAt: ago(MINUTE_MS),
				});
				expect(
					(
						await readBranchWork({
							branchId: untracked,
							organizationId: ORG,
						})
					).work,
				).toEqual({ kind: "idle", wakeAt: null });
			});
		});

		// ---------------------------------------------------------------
		// Merge sync (spec §6.6, #2563 §9.1)
		// ---------------------------------------------------------------

		describe("the branch merge-sync writers", () => {
			it("mark, record the run, then acknowledge with exactly one merge_sync_requested row, each on the tuple", async () => {
				const branchId = await seedBranch({
					state: "MERGED",
					mergeSyncRequestedAt: ago(MINUTE_MS),
					failure: failure("merge_sync", "SYNC_START_FAILED", true),
				});
				const tuple = { syncId: "sync_example", generation: 2 };
				const next = later(5 * MINUTE_MS);
				const mark = (lastExpected: typeof tuple | null) =>
					markBranchMergeSyncDispatched({
						branchId,
						organizationId: ORG,
						lastExpected,
						next: tuple,
						dispatchedAt: new Date(),
						nextAttemptAt: next,
					});
				expect(
					await mark({ syncId: "sync_example", generation: 1 }),
				).toBe(false);
				expect(await mark(null)).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					mergeSyncExpected: tuple,
					mergeSyncDispatchedAt: expect.any(Date),
					mergeSyncRunId: null,
					nextAttemptAt: next,
				});
				expect(
					await recordBranchMergeSyncRun({
						branchId,
						organizationId: ORG,
						expected: tuple,
						runId: "run_example_1",
					}),
				).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					mergeSyncRunId: "run_example_1",
					failure: null,
				});
				const audit = {
					action: "project.instructions.pull_request_merge_sync_requested",
					category: "project",
					actor: { type: "system" },
					organizationId: ORG,
					projectId,
					resource: {
						type: "project_instruction_proposal_branch",
						id: branchId,
						name: "#1",
					},
					metadata: { branchId, syncRunKey: "sync_run_example" },
				} as const;
				expect(
					await clearBranchMergeSyncRequest({
						kind: "acknowledged",
						branchId,
						organizationId: ORG,
						expected: { syncId: "sync_example", generation: 1 },
						audit,
					}),
				).toBe(false);
				expect(
					await clearBranchMergeSyncRequest({
						kind: "acknowledged",
						branchId,
						organizationId: ORG,
						expected: tuple,
						audit,
					}),
				).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					mergeSyncRequestedAt: null,
					mergeSyncDispatchedAt: null,
					mergeSyncRunId: "run_example_1",
				});
				expect(
					(await auditsFor(branchId)).map((a) => a.action),
				).toEqual([
					"project.instructions.pull_request_merge_sync_requested",
				]);
			});

			it("a give-up writes its non-retryable failure and forgets the run", async () => {
				const branchId = await seedBranch({
					state: "MERGED",
					mergeSyncRequestedAt: ago(25 * HOUR_MS),
					mergeSyncRunId: "run_example_2",
				});
				expect(
					await clearBranchMergeSyncRequest({
						kind: "gave_up",
						branchId,
						organizationId: ORG,
						expected: null,
						failure: {
							...failure(
								"merge_sync",
								"MERGE_SYNC_FAILED",
								false,
							),
							phase: "merge_sync",
							retryable: false,
						} as never,
					}),
				).toBe(true);
				expect(await branchOf(branchId)).toMatchObject({
					mergeSyncRequestedAt: null,
					mergeSyncRunId: null,
					failure: expect.objectContaining({
						code: "MERGE_SYNC_FAILED",
					}),
				});
				expect(await auditsFor(branchId)).toEqual([]);
			});
		});

		// ---------------------------------------------------------------
		// The sweeper's selection (spec §8, Review Focus 4)
		// ---------------------------------------------------------------

		describe("selection", () => {
			const LIMITS = {
				close: 10_000,
				recover: 10_000,
				mergeSync: 10_000,
				observe: 10_000,
				restart: 10_000,
				attach: 10_000,
			};

			it("branch rows per the §8 table, each once, untracked never; #2563 rows only by #2563's clauses; Attach after 2 min", async () => {
				const named: Record<string, string> = {};
				let member = 0;
				const branch = async (
					name: string,
					extra: Partial<Prisma.ProjectInstructionProposalBranchUncheckedCreateInput>,
				) => {
					named[name] = await seedBranch({
						userId: MEMBERS[member++ % MEMBERS.length],
						...extra,
					});
					return named[name] as string;
				};
				await branch("closeRequested", {
					state: "CLOSE_REQUESTED",
					closeIntent: "WITHDRAW",
				});
				await branch("closeNotDue", {
					state: "CLOSE_REQUESTED",
					closeIntent: "WITHDRAW",
					nextAttemptAt: later(HOUR_MS),
				});
				await branch("confirmationDue", {
					state: "CANCELED",
					settledAt: ago(2 * HOUR_MS),
					confirmationDueAt: ago(MINUTE_MS),
				});
				await branch("releasable", {
					state: "BLOCKED",
					headSha: SHA("d"),
					failure: failure("create", "CONFIGURATION_CHANGED", false),
				});
				const issued = await branch("issuedOperation", {
					state: "OPEN",
				});
				const issuedProposal = await seedProposal("OPEN", issued);
				await seedOp(issued, issuedProposal, "APPEND", null);
				await branch("markerDue", {
					state: "BLOCKED",
					createIssuedAt: ago(HOUR_MS),
					failure: failure("create", "CREATE_OUTCOME_UNKNOWN", true),
				});
				await branch("retryRequested", {
					state: "BLOCKED",
					retryRequestedAt: ago(MINUTE_MS),
					failure: failure("create", "PR_CREATION_REFUSED", false),
				});
				await branch("membershipPending", {
					state: "MERGED",
					membership: {
						status: "pending",
						at: ago(MINUTE_MS).toISOString(),
						attempts: 0,
					},
				});
				await branch("membershipBackingOff", {
					state: "MERGED",
					membership: {
						status: "pending",
						at: ago(MINUTE_MS).toISOString(),
						attempts: 1,
						nextAttemptAt: later(HOUR_MS).toISOString(),
					},
				});
				await branch("mergeSync", {
					state: "MERGED",
					membership: {
						status: "done",
						at: ago(MINUTE_MS).toISOString(),
						attempts: 0,
					},
					mergeSyncRequestedAt: ago(MINUTE_MS),
				});
				await branch("observe", {
					state: "OPEN",
					pullRequestExternalId: "7",
					lastCheckedAt: ago(11 * MINUTE_MS),
				});
				await branch("observedRecently", {
					state: "OPEN",
					pullRequestExternalId: "8",
					lastCheckedAt: ago(MINUTE_MS),
				});
				// Fizzy #2761: a check whose stamp landed seconds into its
				// tick is due on the tick ten minutes later, and still not on
				// the tick five minutes later.
				await branch("observedTwoTicksAgo", {
					state: "OPEN",
					pullRequestExternalId: "9",
					lastCheckedAt: ago(9 * MINUTE_MS + 55_000),
				});
				await branch("observedLastTick", {
					state: "OPEN",
					pullRequestExternalId: "10",
					lastCheckedAt: ago(4 * MINUTE_MS),
				});
				const appendDue = await branch("restartAppend", {
					state: "PENDING",
				});
				await seedProposal("QUEUED", appendDue);
				const rehome = await branch("restartRehome", {
					state: "MERGED",
					membership: {
						status: "done",
						at: ago(MINUTE_MS).toISOString(),
						attempts: 0,
					},
				});
				await seedProposal("QUEUED", rehome);
				const idle = await branch("restartIdle", { state: "PENDING" });
				await seedProposal("QUEUED", idle, {
					withdrawRequestedAt: new Date(),
					withdrawScope: "change",
				});
				await branch("untracked", {
					state: "CLOSED",
					untracked: true,
					confirmationDueAt: ago(MINUTE_MS),
					membership: {
						status: "pending",
						at: ago(MINUTE_MS).toISOString(),
						attempts: 0,
					},
				});
				// Restart and Attach wait 2 minutes.
				await db.$executeRaw`
					UPDATE "project_instruction_proposal_branch"
					SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '5 minutes'
					WHERE "organizationId" = ${ORGANIZATION_ID}`;
				const attachOld = await seedProposal("QUEUED", null, {
					createdAt: ago(3 * MINUTE_MS),
				});
				await seedProposal("QUEUED", null);
				// #2563 rows: a v1 row due to close, and a v1 QUEUED row old
				// enough to restart; a v2 row on a branch in the same state.
				const v1Close = await seedProposal("CLOSE_REQUESTED", null, {
					pullRequestContext: { v: 1 },
				});
				const v1Restart = await seedProposal("QUEUED", null, {
					pullRequestContext: { v: 1 },
					createdAt: ago(3 * MINUTE_MS),
				});
				const v2OnBranch = await seedProposal(
					"CLOSE_REQUESTED",
					named.closeRequested as string,
				);

				const due = await selectDueBranches(LIMITS);
				const mine = (
					items: Array<{ branchId: string; organizationId: string }>,
				) =>
					items
						.filter((i) => i.organizationId === ORGANIZATION_ID)
						.map(
							(i) =>
								Object.entries(named).find(
									([, id]) => id === i.branchId,
								)?.[0],
						)
						.sort();
				expect(mine(due.close)).toEqual(
					["closeRequested", "confirmationDue", "releasable"].sort(),
				);
				expect(mine(due.recover)).toEqual(
					[
						"issuedOperation",
						"markerDue",
						"retryRequested",
						"membershipPending",
					].sort(),
				);
				expect(mine(due.mergeSync)).toEqual(["mergeSync"]);
				expect(mine(due.observe)).toEqual(
					["observe", "observedTwoTicksAgo"].sort(),
				);
				expect(mine(due.restart)).toEqual(
					["restartAppend", "restartRehome"].sort(),
				);
				expect(
					due.attach
						.filter((a) => a.organizationId === ORGANIZATION_ID)
						.map((a) => a.snapshotId),
				).toEqual([attachOld]);
				const closeItem = due.close.find(
					(i) => i.branchId === named.closeRequested,
				);
				expect(closeItem).toEqual({
					branchId: named.closeRequested,
					projectId,
					organizationId: ORGANIZATION_ID,
					attempt: 4,
					integrationId: "int_example",
				});

				const v1 = await selectDueProposalOperations(LIMITS);
				const snapshots = (items: Array<{ snapshotId: string }>) =>
					items.map((i) => i.snapshotId);
				const all = [
					...v1.close,
					...v1.recover,
					...v1.mergeSync,
					...v1.observe,
					...v1.restart,
				].map((i) => i.snapshotId);
				expect(snapshots(v1.close)).toContain(v1Close);
				expect(snapshots(v1.restart)).toContain(v1Restart);
				expect(all).not.toContain(v2OnBranch);
				expect(all).not.toContain(attachOld);
				expect(all).not.toContain(issuedProposal);
			});
		});
	},
);
