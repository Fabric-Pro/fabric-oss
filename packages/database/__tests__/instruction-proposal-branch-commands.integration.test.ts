/**
 * The member's branch commands on a real Postgres (Fizzy #2738 spec §4.3
 * "Branch close requested (WITHDRAW)", "Try again", "Propose again"; §4.4
 * "Close requested", "Retry opening"; Decision 11). Each runs in one
 * transaction under the §4.7 lock order; what is pinned is exactly what it
 * wrote to the branch, to every proposal on it, and to the audit log.
 * Self-skips without a reachable database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { memberBranchRef } from "../../instructions/src/proposal-branch-ref";
import {
	cancelInstructionProposal,
	closeProposalBranch,
	db,
	type Prisma,
	type ProposalBranchNaming,
	type ProposalRepositoryIdentity,
	proposeBranchProposalAgain,
	reconcileProposalFromEvidence,
	requestProposalBranchRetry,
	startOverProposalBranch,
	tryBranchProposalAgain,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `branch-commands-org-${RUN_ID}`;
const USER_ID = `branch-commands-user-${RUN_ID}`;
const REPO = `branch-commands-${RUN_ID}`;
const REPOSITORY_KEY = `github:example-org/${REPO}`;
const SHA = (c: string) => c.repeat(40);

let projectId = "";
let integrationId = "";
let syncId = "";
let version = 0;
let branchNumber = 0;

const naming: ProposalBranchNaming = {
	memberBranchRef,
	repositoryIdentity: (provider, url) => {
		const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
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
	repositoryKey: (r: ProposalRepositoryIdentity) =>
		r.provider === "GITHUB"
			? `github:${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`
			: JSON.stringify(r),
};

const REQUESTER = {
	actor: { type: "user" as const, userId: USER_ID },
	ipAddress: "203.0.113.7",
	userAgent: null,
	requestId: "req_1",
	sessionId: "sess_1",
	correlationId: "corr_1",
};

function contextV2(): Prisma.InputJsonValue {
	return {
		v: 2,
		integrationId,
		syncId,
		syncGeneration: 1,
		provider: "GITHUB",
		targetRef: "main",
		rootPath: ".claude",
		baseCommitSha: SHA("a"),
		repository: { provider: "GITHUB", owner: "example-org", repo: REPO },
		author: { name: "Dev Example", email: "dev@example.com" },
		committer: { name: "Fabric", email: "fabric@example.com" },
		message: "Update instructions",
		committedAt: "2026-09-27T00:00:00Z",
	};
}

function failure(code: string, retryable = false, phase = "append") {
	return {
		phase,
		code,
		retryable,
		at: "2026-09-27T00:00:00.000Z",
		params: {},
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
			state: "OPEN",
			attempt: 4,
			nextExecutionSeq: 10,
			nextSequence: 5,
			destination: {
				integrationId,
				syncId,
				repositoryKey: REPOSITORY_KEY,
				provider: "GITHUB",
				repository: {
					provider: "GITHUB",
					owner: "example-org",
					repo: REPO,
				},
				targetRef: "main",
				rootPath: ".claude",
			},
			...extra,
		},
		select: { id: true },
	});
	return row.id;
}

async function seedProposal(
	branchId: string,
	sequence: number,
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
			pullRequestOperationId: `bc${RUN_ID.replace(/\D/g, "")}${version}`,
			pullRequestState: "QUEUED",
			pullRequestAttempt: 2,
			pullRequestContext: contextV2(),
			proposalBranchId: branchId,
			proposalBranchSequence: sequence,
			proposalAssignment: 1,
			proposalIntentOrder: BigInt(version),
			...extra,
		},
		select: { id: true },
	});
	return row.id;
}

async function seedOp(
	branchId: string,
	snapshotId: string,
	executionSeq: number,
	kind: "APPEND" | "REVERT",
	outcome: string | null,
	extra: Partial<Prisma.ProjectInstructionProposalBranchOperationUncheckedCreateInput> = {},
): Promise<void> {
	await db.projectInstructionProposalBranchOperation.create({
		data: {
			organizationId: ORGANIZATION_ID,
			branchId,
			snapshotId,
			kind,
			executionSeq,
			ref: "fabric/instructions/members/dev-example-abcd/1",
			assignment: 1,
			attempt: 2,
			parentSha: SHA("b"),
			sha: SHA(String(executionSeq % 10)),
			entries: [],
			pushIssuedAt: new Date(),
			outcome,
			...extra,
		},
	});
}

/** Only one accepting branch per member (spec Decision 2): retire one to seed the next. */
const retire = (id: string) =>
	db.projectInstructionProposalBranch.update({
		where: { id },
		data: { retiredAt: new Date(), retiredReason: "CONFIGURATION_CHANGED" },
	});

const proposalOf = (id: string) =>
	db.projectInstructionSnapshot.findUniqueOrThrow({
		where: { id },
		select: {
			status: true,
			proposalStatus: true,
			pullRequestState: true,
			pullRequestAttempt: true,
			pullRequestFailure: true,
			proposalBranchId: true,
			proposalBranchSequence: true,
			proposalAssignment: true,
			proposalIntentOrder: true,
			withdrawRequestedAt: true,
			withdrawScope: true,
			pendingCommand: true,
			pendingCommandSeq: true,
		},
	});

const branchOf = (id: string) =>
	db.projectInstructionProposalBranch.findUniqueOrThrow({ where: { id } });

const auditsFor = (resourceId: string) =>
	db.auditLog.findMany({
		where: { organizationId: ORGANIZATION_ID, resourceId },
		select: { action: true, metadata: true },
		orderBy: { createdAt: "asc" },
	});

const command = (branchId: string, expectedAttempt = 4) => ({
	branchId,
	projectId,
	organizationId: ORGANIZATION_ID,
	expectedAttempt,
	requester: REQUESTER,
});

const tryAgain = (snapshotId: string, expectedAttempt = 2) =>
	tryBranchProposalAgain({
		snapshotId,
		projectId,
		organizationId: ORGANIZATION_ID,
		proposerUserId: USER_ID,
		expectedAttempt,
		requester: REQUESTER,
	});

describe.skipIf(!hasReachableDatabaseUrl())(
	"member branch commands (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Dev Example",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Branch Commands Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Branch Commands Integration",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
					instructionSettings: { sourceOfTruth: "REPOSITORY" },
				},
			});
			projectId = project.id;
			const integration = await db.projectRepositoryIntegration.create({
				data: {
					projectId,
					provider: "GITHUB",
					authMethod: "OAUTH",
					repositoryUrl: `https://github.com/example-org/${REPO}`,
					repositoryOwner: "example-org",
					repositoryName: REPO,
				},
			});
			integrationId = integration.id;
			const sync = await db.projectInstructionRepositorySync.create({
				data: {
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					repositoryIntegrationId: integrationId,
					ref: "main",
					rootPath: ".claude",
				},
			});
			syncId = sync.id;
		});

		afterEach(async () => {
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalBranch.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalRefReservation.deleteMany({
				where: { organizationId: ORGANIZATION_ID },
			});
			// audit_log is append-only; tests purge their own rows the way
			// audit-log-seal.integration.test.ts does.
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "organizationId" = ${ORGANIZATION_ID}`,
			]);
		});

		afterAll(async () => {
			await db.project.deleteMany({ where: { id: projectId } });
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		// ---------------------------------------------------------------
		// Close (spec Decision 11, §4.3 "Branch close requested")
		// ---------------------------------------------------------------

		it("closes the branch and applies intent branch to every non-terminal proposal in one transaction", async () => {
			const branchId = await seedBranch();
			const open = await seedProposal(branchId, 1, {
				pullRequestState: "OPEN",
			});
			await seedOp(branchId, open, 1, "APPEND", "acked");
			const withdrawing = await seedProposal(branchId, 2, {
				pullRequestState: "CLOSE_REQUESTED",
				withdrawRequestedAt: new Date("2026-09-27T01:00:00Z"),
				withdrawScope: "change",
				pendingCommand: "WITHDRAW",
				pendingCommandSeq: 9,
			});
			await seedOp(branchId, withdrawing, 2, "APPEND", "acked");
			const reverting = await seedProposal(branchId, 3, {
				pullRequestState: "CLOSE_REQUESTED",
				withdrawRequestedAt: new Date("2026-09-27T01:00:00Z"),
				withdrawScope: "change",
				pendingCommand: "WITHDRAW",
				pendingCommandSeq: 4,
			});
			await seedOp(branchId, reverting, 3, "APPEND", "acked");
			await seedOp(branchId, reverting, 4, "REVERT", null);
			const opening = await seedProposal(branchId, 4, {
				pullRequestState: "OPENING",
			});
			const queued = await seedProposal(branchId, 5, {
				pullRequestState: "QUEUED",
				status: "RECEIVING",
			});
			const blocked = await seedProposal(branchId, 6, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure("BRANCH_CONFLICT"),
			});
			const merged = await seedProposal(branchId, 7, {
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
			});

			expect(await closeProposalBranch(command(branchId))).toEqual({
				kind: "done",
				changed: true,
				attempt: 5,
			});
			expect(await branchOf(branchId)).toMatchObject({
				state: "CLOSE_REQUESTED",
				closeIntent: "WITHDRAW",
				attempt: 5,
			});
			expect(await proposalOf(open)).toMatchObject({
				pullRequestState: "OPEN",
				withdrawScope: "branch",
				withdrawRequestedAt: expect.any(Date),
				pendingCommand: null,
				pullRequestAttempt: 3,
			});
			// No revert was issued: its change leaves with the branch.
			expect(await proposalOf(withdrawing)).toMatchObject({
				pullRequestState: "OPEN",
				withdrawScope: "branch",
				pendingCommand: null,
				pendingCommandSeq: null,
			});
			// Its revert is issued: recovery resolves it first.
			expect(await proposalOf(reverting)).toMatchObject({
				pullRequestState: "CLOSE_REQUESTED",
				withdrawScope: "branch",
				pendingCommand: null,
				pendingCommandSeq: null,
			});
			expect(await proposalOf(opening)).toMatchObject({
				pullRequestState: "OPENING",
				withdrawScope: "branch",
				pullRequestAttempt: 3,
			});
			expect(await proposalOf(queued)).toMatchObject({
				pullRequestState: "CANCELED",
				proposalStatus: "REJECTED",
				status: "REJECTED",
				withdrawScope: "branch",
			});
			expect(await proposalOf(blocked)).toMatchObject({
				pullRequestState: "CANCELED",
				withdrawScope: "branch",
			});
			expect(await proposalOf(merged)).toMatchObject({
				pullRequestState: "MERGED",
				withdrawScope: null,
			});
			expect(await auditsFor(branchId)).toEqual([
				{
					action: "project.instructions.pull_request_close_requested",
					metadata: expect.objectContaining({
						scope: "branch",
						closeIntent: "WITHDRAW",
						stateBefore: "OPEN",
						canceled: 2,
						kept: 4,
					}),
				},
			]);
			expect(await auditsFor(queued)).toEqual([
				{
					action: "project.instructions.pull_request_close_requested",
					metadata: expect.objectContaining({
						scope: "branch",
						stateBefore: "QUEUED",
						branchId,
					}),
				},
			]);
			// A repeat changes nothing.
			expect(await closeProposalBranch(command(branchId, 5))).toEqual({
				kind: "done",
				changed: false,
				attempt: 5,
			});
		});

		it("refuses a close at a stale attempt and writes nothing", async () => {
			const branchId = await seedBranch();
			const queued = await seedProposal(branchId, 1);
			expect(await closeProposalBranch(command(branchId, 3))).toEqual({
				kind: "stale",
			});
			expect((await branchOf(branchId)).state).toBe("OPEN");
			expect((await proposalOf(queued)).pullRequestState).toBe("QUEUED");
			expect(await auditsFor(branchId)).toEqual([]);
		});

		it("keeps a REPOSITORY_CHANGED failure on close, so the branch can still be stopped tracking", async () => {
			const branchId = await seedBranch({
				state: "BLOCKED",
				failure: failure("REPOSITORY_CHANGED", false, "create"),
			});
			expect(await closeProposalBranch(command(branchId))).toMatchObject({
				kind: "done",
				changed: true,
			});
			expect(await branchOf(branchId)).toMatchObject({
				state: "CLOSE_REQUESTED",
				failure: expect.objectContaining({
					code: "REPOSITORY_CHANGED",
				}),
			});
		});

		it("withdrawing the last live change applies the same close to the other proposals on the branch", async () => {
			const branchId = await seedBranch();
			const last = await seedProposal(branchId, 1, {
				pullRequestState: "OPEN",
			});
			await seedOp(branchId, last, 1, "APPEND", "acked");
			const withdrawing = await seedProposal(branchId, 2, {
				pullRequestState: "CLOSE_REQUESTED",
				withdrawRequestedAt: new Date("2026-09-27T01:00:00Z"),
				withdrawScope: "change",
				pendingCommand: "WITHDRAW",
				pendingCommandSeq: 9,
			});
			await seedOp(branchId, withdrawing, 2, "APPEND", "acked");
			const blocked = await seedProposal(branchId, 3, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure("BRANCH_CONFLICT"),
			});

			expect(
				await cancelInstructionProposal({
					snapshotId: last,
					projectId,
					organizationId: ORGANIZATION_ID,
					proposerUserId: USER_ID,
					audit: {
						action: "project.instructions.rejected",
						category: "project",
						actor: { type: "user", userId: USER_ID },
						organizationId: ORGANIZATION_ID,
						projectId,
						resource: {
							type: "project_instruction_snapshot",
							id: last,
						},
						metadata: { decision: "canceled" },
					},
				}),
			).toMatchObject({
				ok: true,
				changed: true,
				pullRequest: "close_requested",
				scope: "branch",
			});
			expect(await branchOf(branchId)).toMatchObject({
				state: "CLOSE_REQUESTED",
				closeIntent: "WITHDRAW",
			});
			expect(await proposalOf(last)).toMatchObject({
				pullRequestState: "OPEN",
				withdrawScope: "branch",
				pendingCommand: null,
			});
			expect(await proposalOf(withdrawing)).toMatchObject({
				pullRequestState: "OPEN",
				withdrawScope: "branch",
				pendingCommand: null,
			});
			expect(await proposalOf(blocked)).toMatchObject({
				pullRequestState: "CANCELED",
				withdrawScope: "branch",
			});
			// The withdrawn change's own row is as before: one
			// close_requested, scope branch.
			expect(await auditsFor(last)).toEqual([
				{
					action: "project.instructions.pull_request_close_requested",
					metadata: expect.objectContaining({
						scope: "branch",
						stateBefore: "OPEN",
					}),
				},
			]);
		});

		// ---------------------------------------------------------------
		// Start over, Retry opening (spec Decisions 11, 17)
		// ---------------------------------------------------------------

		it("starts over only a branch BLOCKED non-retryable CREATE_OUTCOME_UNKNOWN with no foreign commits, keeping its proposals' intent", async () => {
			const refused = await seedBranch({
				state: "BLOCKED",
				failure: failure("CREATE_OUTCOME_UNKNOWN", true, "create"),
			});
			expect(await startOverProposalBranch(command(refused))).toEqual({
				kind: "not_applicable",
			});
			await retire(refused);
			const foreign = await seedBranch({
				state: "BLOCKED",
				failure: failure("CREATE_OUTCOME_UNKNOWN", false, "create"),
				foreignTipAt: new Date(),
			});
			expect(await startOverProposalBranch(command(foreign))).toEqual({
				kind: "not_applicable",
			});
			await retire(foreign);

			const branchId = await seedBranch({
				state: "BLOCKED",
				failure: failure("CREATE_OUTCOME_UNKNOWN", false, "create"),
			});
			const open = await seedProposal(branchId, 1, {
				pullRequestState: "OPEN",
			});
			await seedOp(branchId, open, 1, "APPEND", "acked");
			expect(await startOverProposalBranch(command(branchId))).toEqual({
				kind: "done",
				changed: true,
				attempt: 5,
			});
			expect(await branchOf(branchId)).toMatchObject({
				state: "CLOSE_REQUESTED",
				closeIntent: "START_OVER",
			});
			expect(await proposalOf(open)).toMatchObject({
				pullRequestState: "OPEN",
				withdrawRequestedAt: null,
				pullRequestAttempt: 2,
			});
			expect((await auditsFor(branchId))[0]).toMatchObject({
				action: "project.instructions.pull_request_close_requested",
				metadata: { scope: "branch", closeIntent: "START_OVER" },
			});
		});

		it("records Retry opening only for PR_CREATION_REFUSED, once", async () => {
			const other = await seedBranch({
				state: "BLOCKED",
				failure: failure("CREATE_OUTCOME_UNKNOWN", false, "create"),
			});
			expect(await requestProposalBranchRetry(command(other))).toEqual({
				kind: "not_applicable",
			});
			await retire(other);
			const branchId = await seedBranch({
				state: "BLOCKED",
				failure: failure("PR_CREATION_REFUSED", false, "create"),
			});
			expect(await requestProposalBranchRetry(command(branchId))).toEqual(
				{
					kind: "done",
					changed: true,
					attempt: 4,
				},
			);
			expect(await branchOf(branchId)).toMatchObject({
				state: "BLOCKED",
				attempt: 4,
				retryRequestedAt: expect.any(Date),
			});
			expect(await requestProposalBranchRetry(command(branchId))).toEqual(
				{
					kind: "done",
					changed: false,
					attempt: 4,
				},
			);
			expect(await auditsFor(branchId)).toEqual([
				{
					action: "project.instructions.pull_request_retry_requested",
					metadata: expect.objectContaining({
						kind: "retry_opening",
					}),
				},
			]);
		});

		// ---------------------------------------------------------------
		// Try again (spec §4.3)
		// ---------------------------------------------------------------

		it("queues a conflicted change at the end with a new intent order and an APPEND command at nextExecutionSeq", async () => {
			const branchId = await seedBranch();
			const id = await seedProposal(branchId, 1, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure("BRANCH_CONFLICT"),
			});
			const before = await proposalOf(id);

			expect(await tryAgain(id)).toEqual({
				kind: "queued",
				branchId,
				attempt: 3,
				sequence: 5,
				pendingCommandSeq: 10,
			});
			const after = await proposalOf(id);
			expect(after).toMatchObject({
				pullRequestState: "QUEUED",
				proposalStatus: "PENDING",
				pullRequestFailure: null,
				proposalBranchId: branchId,
				proposalBranchSequence: 5,
				proposalAssignment: 1,
				pendingCommand: "APPEND",
				pendingCommandSeq: 10,
				pullRequestAttempt: 3,
			});
			expect(after.proposalIntentOrder).not.toBeNull();
			expect(
				(after.proposalIntentOrder as bigint) >
					(before.proposalIntentOrder as bigint),
			).toBe(true);
			expect((await branchOf(branchId)).nextSequence).toBe(6);
			expect(await auditsFor(id)).toEqual([
				{
					action: "project.instructions.pull_request_retry_requested",
					metadata: expect.objectContaining({
						kind: "try_again",
						failureCode: "BRANCH_CONFLICT",
						outcome: "queued",
					}),
				},
			]);
		});

		it("makes the change OPEN when its current append is already established, queueing nothing", async () => {
			const branchId = await seedBranch();
			const id = await seedProposal(branchId, 1, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure(
					"PUSH_OUTCOME_UNKNOWN",
					false,
					"recover",
				),
			});
			await seedOp(branchId, id, 3, "APPEND", "observed");

			expect(await tryAgain(id)).toMatchObject({
				kind: "open",
				branchId,
			});
			expect(await proposalOf(id)).toMatchObject({
				pullRequestState: "OPEN",
				pullRequestFailure: null,
				pendingCommand: null,
				proposalBranchSequence: 1,
			});
			expect((await branchOf(branchId)).nextSequence).toBe(5);
		});

		it("keeps an unknown push's Try again against a later fact about it: the APPEND command stands", async () => {
			const branchId = await seedBranch();
			const id = await seedProposal(branchId, 1, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure(
					"PUSH_OUTCOME_UNKNOWN",
					false,
					"recover",
				),
			});
			await seedOp(branchId, id, 3, "APPEND", "unknown");

			expect(await tryAgain(id)).toMatchObject({ kind: "queued" });
			// The reducer runs on any later fact; the queued retry stands (row 6).
			const reconciled = await db.$transaction((tx) =>
				reconcileProposalFromEvidence(tx, {
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
				}),
			);
			expect(reconciled).toMatchObject({ changed: false, row: 6 });
			expect(await proposalOf(id)).toMatchObject({
				pullRequestState: "QUEUED",
				pendingCommand: "APPEND",
				pendingCommandSeq: 10,
			});
		});

		it("refuses Try again at a stale attempt, for another failure, and on a branch that takes no appends", async () => {
			const branchId = await seedBranch();
			const conflicted = await seedProposal(branchId, 1, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure("SUPERSEDED_BY_LATER_CHANGE"),
			});
			expect(await tryAgain(conflicted, 7)).toEqual({ kind: "stale" });
			const other = await seedProposal(branchId, 2, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure(
					"VALIDATION_TIMEOUT",
					true,
					"validation",
				),
			});
			expect(await tryAgain(other)).toEqual({ kind: "not_applicable" });

			const closing = await seedBranch({
				state: "CLOSE_REQUESTED",
				closeIntent: "WITHDRAW",
			});
			const stuck = await seedProposal(closing, 1, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure("BRANCH_CONFLICT"),
			});
			expect(await tryAgain(stuck)).toEqual({
				kind: "branch_not_accepting",
			});
			expect(await proposalOf(stuck)).toMatchObject({
				pullRequestState: "BLOCKED",
				pendingCommand: null,
			});
		});

		// ---------------------------------------------------------------
		// Propose again (spec Decision 14)
		// ---------------------------------------------------------------

		it("transfers an unverified finished change to the member's accepting branch with a new intent order", async () => {
			const oldBranch = await seedBranch({ state: "MERGED" });
			const id = await seedProposal(oldBranch, 1, {
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
			});
			await seedOp(oldBranch, id, 1, "APPEND", "acked", {
				membership: "unverified",
			});
			const before = await proposalOf(id);

			const result = await proposeBranchProposalAgain({
				snapshotId: id,
				projectId,
				organizationId: ORGANIZATION_ID,
				proposerUserId: USER_ID,
				naming,
				requester: REQUESTER,
			});
			expect(result).toMatchObject({ kind: "joined", assignment: 2 });
			const after = await proposalOf(id);
			expect(after).toMatchObject({
				pullRequestState: "QUEUED",
				proposalStatus: "PENDING",
				proposalAssignment: 2,
			});
			expect(after.proposalBranchId).not.toBe(oldBranch);
			expect(
				(after.proposalIntentOrder as bigint) >
					(before.proposalIntentOrder as bigint),
			).toBe(true);
			expect(await auditsFor(id)).toEqual([
				{
					action: "project.instructions.pull_request_retry_requested",
					metadata: expect.objectContaining({
						kind: "propose_again",
						fromBranchId: oldBranch,
					}),
				},
			]);
		});

		/**
		 * Backends of this database parked on a row lock of a branch, read from
		 * another connection (as publishing-reconcile-contention.test.ts does):
		 * the proof that the command is waiting, not an assumption.
		 */
		async function waitersOnBranchLocks(): Promise<number> {
			const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(
				`SELECT count(*)::int AS n
				   FROM pg_stat_activity
				  WHERE "datname" = current_database()
				    AND "state" = 'active'
				    AND "wait_event_type" = 'Lock'
				    AND "wait_event" = 'transactionid'
				    AND "query" ILIKE '%"project_instruction_proposal_branch"%FOR UPDATE%'
				    AND "pid" <> pg_backend_pid()`,
			);
			return row?.n ?? 0;
		}

		it("refuses Propose again when recovery proves the change while the command waits for the branch lock", async () => {
			const oldBranch = await seedBranch({ state: "MERGED" });
			const id = await seedProposal(oldBranch, 1, {
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
			});
			// The current append's push is unknown on a terminal branch:
			// the card offers Propose again (spec §4.3).
			await seedOp(oldBranch, id, 1, "APPEND", "unknown");
			const before = await proposalOf(id);

			// Late recovery holds the old branch's lock, as
			// `recordOperationOutcome` does, and proves the push observed.
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let holding = () => {};
			const held = new Promise<void>((resolve) => {
				holding = resolve;
			});
			const recovery = db.$transaction(
				async (tx) => {
					await tx.$queryRaw`
						SELECT "id" FROM "project_instruction_proposal_branch"
						WHERE "id" = ${oldBranch} FOR UPDATE`;
					holding();
					await released;
					await tx.projectInstructionProposalBranchOperation.updateMany(
						{
							where: { branchId: oldBranch, snapshotId: id },
							data: {
								outcome: "observed",
								observedAt: new Date(),
							},
						},
					);
				},
				{ timeout: 30_000 },
			);
			await held;

			// The command's early read still sees the push unknown.
			const command = proposeBranchProposalAgain({
				snapshotId: id,
				projectId,
				organizationId: ORGANIZATION_ID,
				proposerUserId: USER_ID,
				naming,
				requester: REQUESTER,
			});
			const deadline = Date.now() + 10_000;
			while ((await waitersOnBranchLocks()) < 1) {
				if (Date.now() > deadline) {
					throw new Error(
						"Propose again never waited on the branch lock",
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			release();
			await recovery;

			expect(await command).toEqual({ kind: "not_joinable" });
			expect(await proposalOf(id)).toEqual(before);
			expect(await auditsFor(id)).toEqual([]);
			expect(
				await db.projectInstructionProposalBranch.count({
					where: { projectId },
				}),
			).toBe(1);
		});

		it("writes Propose again's audit row in the transfer's transaction: an audit failure leaves the change where it was", async () => {
			const oldBranch = await seedBranch({ state: "MERGED" });
			const id = await seedProposal(oldBranch, 1, {
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
			});
			await seedOp(oldBranch, id, 1, "APPEND", "acked", {
				membership: "unverified",
			});
			const before = await proposalOf(id);
			const args = {
				snapshotId: id,
				projectId,
				organizationId: ORGANIZATION_ID,
				proposerUserId: USER_ID,
				naming,
			};

			// An actor the audit row cannot reference: its insert fails.
			await expect(
				proposeBranchProposalAgain({
					...args,
					requester: {
						...REQUESTER,
						actor: { type: "user", userId: `missing-${USER_ID}` },
					},
				}),
			).rejects.toThrow();
			expect(await proposalOf(id)).toEqual(before);
			expect(await auditsFor(id)).toEqual([]);
			expect(
				await db.projectInstructionProposalBranch.count({
					where: { projectId },
				}),
			).toBe(1);

			// Asked again, it transfers and is audited exactly once.
			expect(
				await proposeBranchProposalAgain({
					...args,
					requester: REQUESTER,
				}),
			).toMatchObject({ kind: "joined", assignment: 2 });
			expect((await proposalOf(id)).pullRequestState).toBe("QUEUED");
			expect(await auditsFor(id)).toEqual([
				{
					action: "project.instructions.pull_request_retry_requested",
					metadata: expect.objectContaining({
						kind: "propose_again",
						fromBranchId: oldBranch,
						stateBefore: "MERGED",
					}),
				},
			]);
		});

		it("refuses Propose again for a change whose membership was proved, or that is withdrawn", async () => {
			const oldBranch = await seedBranch({ state: "MERGED" });
			const included = await seedProposal(oldBranch, 1, {
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
			});
			await seedOp(oldBranch, included, 1, "APPEND", "acked", {
				membership: "included",
			});
			const withdrawn = await seedProposal(oldBranch, 2, {
				pullRequestState: "CANCELED",
				proposalStatus: "REJECTED",
				withdrawRequestedAt: new Date(),
				withdrawScope: "branch",
			});
			await seedOp(oldBranch, withdrawn, 2, "APPEND", "acked", {
				membership: "unverified",
			});
			for (const id of [included, withdrawn]) {
				expect(
					await proposeBranchProposalAgain({
						snapshotId: id,
						projectId,
						organizationId: ORGANIZATION_ID,
						proposerUserId: USER_ID,
						naming,
						requester: REQUESTER,
					}),
				).toEqual({ kind: "not_applicable" });
			}
		});
	},
);
