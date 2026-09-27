/**
 * `reconcileProposalFromEvidence` on a real Postgres (Fizzy #2738 spec §4.1
 * fence contract): only the proposal's current submission decides its
 * lifecycle, a lifecycle change bumps the attempt so a stale claim holder's
 * fenced write fails, and an unchanged reduction writes nothing. Self-skips
 * without a reachable database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, type Prisma } from "../index";
import { reconcileProposalFromEvidence } from "../prisma/queries/instruction-proposal-branch-evidence";
import { recordOperationOutcome } from "../prisma/queries/instruction-proposal-branches";
import { transitionPullRequest } from "../prisma/queries/instruction-proposal-pull-requests";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `pr-branch-reconcile-org-${RUN_ID}`;
const USER_ID = `pr-branch-reconcile-user-${RUN_ID}`;
const REPOSITORY_KEY = `github:example-org/reconcile-${RUN_ID}`;
let projectId = "";
let version = 0;
let branchNumber = 0;

const SHA = (c: string) => c.repeat(40);

const REPOSITORY = {
	provider: "GITHUB",
	owner: "example-org",
	repo: `reconcile-${RUN_ID}`,
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
		committedAt: "2026-09-27T00:00:00Z",
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

async function seedProposal(
	state: "QUEUED" | "OPENING" | "OPEN" | "CLOSE_REQUESTED" | "BLOCKED",
	branchId: string,
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
			pullRequestOperationId: `rc${RUN_ID.replace(/\D/g, "")}${version}`,
			pullRequestState: state,
			pullRequestAttempt: 4,
			pullRequestContext: contextV2(),
			proposalBranchId: branchId,
			proposalBranchSequence: version,
			proposalAssignment: 1,
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
	assignment = 1,
): Promise<string> {
	const row = await db.projectInstructionProposalBranchOperation.create({
		data: {
			organizationId: ORGANIZATION_ID,
			branchId,
			snapshotId,
			kind,
			executionSeq,
			ref: "fabric/instructions/members/dev-example-abcd/1",
			assignment,
			attempt: 4,
			parentSha: executionSeq === 1 ? null : SHA("b"),
			sha: SHA(String(executionSeq)),
			entries: [],
			pushIssuedAt: new Date(),
			outcome,
		},
		select: { id: true },
	});
	return row.id;
}

async function proposal(id: string) {
	return db.projectInstructionSnapshot.findUniqueOrThrow({
		where: { id },
		select: {
			pullRequestState: true,
			proposalStatus: true,
			pullRequestAttempt: true,
			pullRequestFailure: true,
			withdrawRequestedAt: true,
			pendingCommand: true,
			pendingCommandSeq: true,
		},
	});
}

const reconcile = (snapshotId: string) =>
	db.$transaction((tx) =>
		reconcileProposalFromEvidence(tx, {
			snapshotId,
			organizationId: ORGANIZATION_ID,
		}),
	);

describe.skipIf(!hasReachableDatabaseUrl())(
	"reconcileProposalFromEvidence (real Postgres)",
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
					name: "Proposal Branch Reconcile Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Proposal Branch Reconcile Integration",
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
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalBranch.deleteMany({
				where: { projectId },
			});
			// audit_log is append-only; tests purge their own rows the way
			// audit-log-seal.integration.test.ts does.
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
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("leaves a transferred proposal alone when an old-branch operation is established", async () => {
			const oldBranch = await seedBranch({ state: "MERGED" });
			const newBranch = await seedBranch({ state: "PENDING" });
			const id = await seedProposal("QUEUED", newBranch, {
				proposalAssignment: 2,
			});
			const opId = await seedOp(oldBranch, id, 1, "APPEND", null, 1);
			const result = await recordOperationOutcome({
				operationId: opId,
				organizationId: ORGANIZATION_ID,
				outcome: "acked",
			});
			expect(result).toEqual({
				applied: true,
				reconcile: { changed: false, row: null },
			});
			expect(await proposal(id)).toMatchObject({
				pullRequestState: "QUEUED",
				pullRequestAttempt: 4,
			});
			// Reading directly: only the new branch's journal counts.
			expect(await reconcile(id)).toEqual({
				changed: false,
				row: 9,
				attempt: 4,
			});
			const op =
				await db.projectInstructionProposalBranchOperation.findUniqueOrThrow(
					{
						where: { id: opId },
						select: { outcome: true, pushAckedAt: true },
					},
				);
			expect(op.outcome).toBe("acked");
			expect(op.pushAckedAt).not.toBeNull();
		});

		it("fails a stale claim holder's fenced write after a reconcile that changed the lifecycle", async () => {
			const branchId = await seedBranch();
			const id = await seedProposal("OPENING", branchId);
			const opId = await seedOp(branchId, id, 1, "APPEND", null);
			const result = await recordOperationOutcome({
				operationId: opId,
				organizationId: ORGANIZATION_ID,
				outcome: "acked",
			});
			expect(result).toEqual({
				applied: true,
				reconcile: { changed: true, row: 5 },
			});
			expect(await proposal(id)).toMatchObject({
				pullRequestState: "OPEN",
				pullRequestAttempt: 5,
			});
			const stale = await transitionPullRequest({
				snapshotId: id,
				organizationId: ORGANIZATION_ID,
				event: "failure",
				from: ["OPEN"],
				expectedAttempt: 4,
				to: "unchanged",
				bumpAttempt: false,
				data: { pullRequestLastCheckedAt: new Date() },
			});
			expect(stale).toEqual({ ok: false });
		});

		it("keeps the attempt when the reduction is unchanged", async () => {
			const branchId = await seedBranch({ state: "OPEN" });
			const id = await seedProposal("OPEN", branchId);
			await seedOp(branchId, id, 1, "APPEND", "acked");
			expect(await reconcile(id)).toEqual({
				changed: false,
				row: 5,
				attempt: 4,
			});
			expect((await proposal(id)).pullRequestAttempt).toBe(4);
		});

		it("cancels on an established withdrawal with one reconciled audit row and the command cleared", async () => {
			const branchId = await seedBranch({ state: "OPEN" });
			const id = await seedProposal("CLOSE_REQUESTED", branchId, {
				withdrawRequestedAt: new Date(),
				withdrawScope: "change",
				pendingCommand: "WITHDRAW",
				pendingCommandSeq: 2,
			});
			await seedOp(branchId, id, 1, "APPEND", "acked");
			const revert = await seedOp(branchId, id, 2, "REVERT", null);
			const result = await recordOperationOutcome({
				operationId: revert,
				organizationId: ORGANIZATION_ID,
				outcome: "acked",
			});
			expect(result.reconcile).toEqual({ changed: true, row: 1 });
			const after = await proposal(id);
			expect(after).toMatchObject({
				pullRequestState: "CANCELED",
				proposalStatus: "REJECTED",
				pullRequestAttempt: 5,
				pendingCommand: null,
				pendingCommandSeq: null,
			});
			expect(after.withdrawRequestedAt).not.toBeNull();
			const audits = await db.auditLog.findMany({
				where: { organizationId: ORGANIZATION_ID, resourceId: id },
				select: { action: true },
			});
			expect(audits.map((a) => a.action)).toEqual([
				"project.instructions.pull_request_reconciled",
			]);
		});

		it("never regresses lifecycle on a late fact about an older append (#63)", async () => {
			const branchId = await seedBranch();
			const id = await seedProposal("QUEUED", branchId, {
				pendingCommand: "APPEND",
				pendingCommandSeq: 3,
			});
			const u1 = await seedOp(branchId, id, 1, "APPEND", "unknown");
			await seedOp(branchId, id, 2, "APPEND", "unknown");
			const result = await recordOperationOutcome({
				operationId: u1,
				organizationId: ORGANIZATION_ID,
				outcome: "acked",
			});
			expect(result).toEqual({
				applied: true,
				reconcile: { changed: false, row: 6 },
			});
			expect(await proposal(id)).toMatchObject({
				pullRequestState: "QUEUED",
				pullRequestAttempt: 4,
				pendingCommand: "APPEND",
			});
		});
	},
);
