/**
 * Member branch proposals at admission and withdrawal on a real Postgres
 * (Fizzy #2738 spec Decisions 4, 8, 10 and 16; §4.3 "Withdraw" rows; §6.8
 * "Request"), plus the #2563 pre-create cancels' journal guard.
 * Self-skips without a reachable database.
 *
 * Admission is `createDerivedInstructionSnapshot` with a v2 context, as the
 * API's `admitInstructionProposal` builds it: the intent order comes from
 * the database sequence inside the admission transaction, and the dedup and
 * caps read the branch evidence. Withdrawal is `cancelInstructionProposal`,
 * which hands a v2 row to `withdrawBranchProposal` under the §4.7 lock order.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	cancelInstructionProposal,
	createDerivedInstructionSnapshot,
	db,
	MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER,
	type Prisma,
	type RecordAuditInput,
	transitionPullRequest,
	withdrawBranchProposal,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `admission-branch-org-${RUN_ID}`;
const USER_ID = `admission-branch-user-${RUN_ID}`;
const REPO = `admission-branch-${RUN_ID}`;
const SHA = (c: string) => c.repeat(40);
const digestOf = (text: string) =>
	createHash("sha256").update(text).digest("hex");

let projectId = "";
let integrationId = "";
let syncId = "";
let baseId = "";
let basePrefix = "";
let version = 0;
let branchNumber = 0;

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

const put = (path: string, content: string) => ({
	op: "put" as const,
	path,
	size: content.length,
	sha256: digestOf(content),
	mimeType: "text/markdown",
	isText: true,
	kind: "INSTRUCTIONS" as const,
	storageKey: `projects/${projectId}/instructions/staging/pending/${digestOf(content).slice(0, 8)}`,
});

let operation = 0;
function admit(
	changes: ReturnType<typeof put>[],
	destination: "REPOSITORY" | "FABRIC" = "REPOSITORY",
) {
	operation += 1;
	const operationId = `adm${RUN_ID.replace(/\D/g, "")}${operation}`;
	return createDerivedInstructionSnapshot({
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: USER_ID,
		baseSnapshotId: baseId,
		publishOnReady: false,
		proposal: true,
		changes,
		limits: { maxFiles: 5_000, maxTotalBytes: 52_428_800 },
		baseKeyPrefix: basePrefix,
		...(destination === "REPOSITORY"
			? {
					destination: {
						kind: "REPOSITORY" as const,
						operationId,
						context: contextV2(),
						syncId,
						syncGeneration: 1,
						uploadStartedAudit: {
							actor: { type: "user" as const, userId: USER_ID },
							organizationId: ORGANIZATION_ID,
							projectId,
							metadata: {
								mode: "proposal" as const,
								baseSnapshotId: baseId,
								baseVersion: 1,
								putCount: changes.length,
								deleteCount: 0,
							},
						},
					},
				}
			: {}),
	});
}

async function seedProposal(
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
			pullRequestOperationId: `ab${RUN_ID.replace(/\D/g, "")}${version}`,
			pullRequestState: "QUEUED",
			pullRequestAttempt: 2,
			pullRequestContext: contextV2(),
			...extra,
		},
		select: { id: true },
	});
	return row.id;
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
			repositoryKey: `github:example-org/${REPO}`,
			number: branchNumber,
			ref: `fabric/instructions/members/dev-example-abcd/${branchNumber}`,
			state: "OPEN",
			attempt: 4,
			nextExecutionSeq: 10,
			nextSequence: 5,
			destination: {
				integrationId,
				syncId,
				repositoryKey: `github:example-org/${REPO}`,
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

const entry = (path: string) => ({
	path,
	rawPath: `.claude/${path}`,
	before: null,
	after: { type: "blob", mode: "100644", oid: SHA("c") },
	afterSha256: "d".repeat(64),
	afterSource: null,
	beforeSource: null,
});

async function seedOp(
	branchId: string,
	snapshotId: string,
	executionSeq: number,
	outcome: string | null,
	paths: string[],
	kind: "APPEND" | "REVERT" = "APPEND",
	assignment = 1,
): Promise<void> {
	await db.projectInstructionProposalBranchOperation.create({
		data: {
			organizationId: ORGANIZATION_ID,
			branchId,
			snapshotId,
			kind,
			executionSeq,
			ref: "fabric/instructions/members/dev-example-abcd/1",
			assignment,
			attempt: 2,
			parentSha: SHA("b"),
			sha: SHA(String(executionSeq % 10)),
			entries: paths.map(entry),
			pushIssuedAt: new Date(),
			outcome,
		},
	});
}

/** An OPEN proposal on `branchId` whose current append (`seq`) is acknowledged. */
async function appended(
	branchId: string,
	sequence: number,
	seq: number,
	paths: string[],
	extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
): Promise<string> {
	const id = await seedProposal({
		pullRequestState: "OPEN",
		proposalBranchId: branchId,
		proposalBranchSequence: sequence,
		proposalAssignment: 1,
		...extra,
	});
	await seedOp(branchId, id, seq, "acked", paths);
	return id;
}

const proposalOf = (id: string) =>
	db.projectInstructionSnapshot.findUniqueOrThrow({
		where: { id },
		select: {
			status: true,
			proposalStatus: true,
			pullRequestState: true,
			pullRequestAttempt: true,
			pullRequestFailure: true,
			pullRequestRef: true,
			pullRequestContext: true,
			proposalIntentOrder: true,
			withdrawRequestedAt: true,
			withdrawScope: true,
			pendingCommand: true,
			pendingCommandSeq: true,
		},
	});

const branchOf = (id: string) =>
	db.projectInstructionProposalBranch.findUniqueOrThrow({ where: { id } });

const cancelAudit = (snapshotId: string): RecordAuditInput => ({
	action: "project.instructions.rejected",
	category: "project",
	actor: { type: "user", userId: USER_ID },
	organizationId: ORGANIZATION_ID,
	projectId,
	resource: { type: "project_instruction_snapshot", id: snapshotId },
	metadata: { decision: "canceled" },
});

const withdraw = (snapshotId: string) =>
	cancelInstructionProposal({
		snapshotId,
		projectId,
		organizationId: ORGANIZATION_ID,
		proposerUserId: USER_ID,
		audit: cancelAudit(snapshotId),
	});

const auditsFor = (snapshotId: string) =>
	db.auditLog.findMany({
		where: { organizationId: ORGANIZATION_ID, resourceId: snapshotId },
		select: { action: true, metadata: true },
		orderBy: { createdAt: "asc" },
	});

describe.skipIf(!hasReachableDatabaseUrl())(
	"member branch proposals at admission and withdrawal (real Postgres)",
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
					name: "Admission Branch Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Admission Branch Integration",
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
			version += 1;
			baseId = `admission-branch-base-${RUN_ID}`;
			basePrefix = `projects/${projectId}/instructions/snapshots/${baseId}/`;
			await db.projectInstructionSnapshot.create({
				data: {
					id: baseId,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					version,
					source: "UPLOAD",
					status: "READY",
					settingsFrozen: {},
					publishOnReady: false,
					readyAt: now,
				},
			});
			await db.projectInstructionFile.create({
				data: {
					snapshotId: baseId,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					path: "CLAUDE.md",
					kind: "INSTRUCTIONS",
					storageKey: `${basePrefix}base-file-0`,
					sha256: digestOf("CLAUDE.md"),
					size: 9,
					mimeType: "text/markdown",
					isText: true,
				},
			});
			await db.project.update({
				where: { id: projectId },
				data: { publishedInstructionSnapshotId: baseId },
			});
		});

		afterEach(async () => {
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId, id: { not: baseId } },
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
			await db.project.update({
				where: { id: projectId },
				data: { publishedInstructionSnapshotId: null },
			});
			await db.project.deleteMany({ where: { id: projectId } });
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		// ---------------------------------------------------------------
		// Admission (spec Decisions 4, 8)
		// ---------------------------------------------------------------

		it("admits a REPOSITORY proposal with its v2 context, no per-proposal ref and a positive intent order", async () => {
			const result = await admit([put("README.md", "one")]);
			expect(result).toMatchObject({ ok: true, auditWritten: true });
			if (!result.ok) {
				throw new Error("expected an admission");
			}
			const row = await proposalOf(result.id);
			expect(row.pullRequestState).toBe("QUEUED");
			expect(row.pullRequestRef).toBeNull();
			expect(row.pullRequestContext).toMatchObject({ v: 2 });
			expect(row.pullRequestContext).not.toHaveProperty("branch");
			expect(row.proposalIntentOrder).not.toBeNull();
			expect(row.proposalIntentOrder! > 0n).toBe(true);
			expect(result.proposalIntentOrder).toBe(row.proposalIntentOrder);
		});

		it("answers a duplicate admission with the existing row's intent order, and later admissions draw higher ones", async () => {
			const first = await admit([put("README.md", "two")]);
			const again = await admit([put("README.md", "two")]);
			const later = await admit([put("README.md", "three")]);
			if (!first.ok || !later.ok) {
				throw new Error("expected admissions");
			}
			expect(again).toMatchObject({
				ok: false,
				reason: "duplicate_proposal",
				existing: {
					id: first.id,
					proposalIntentOrder: first.proposalIntentOrder,
				},
			});
			expect(
				later.proposalIntentOrder! > first.proposalIntentOrder!,
			).toBe(true);
		});

		it("gives a FABRIC proposal no intent order", async () => {
			const result = await admit([put("README.md", "fabric")], "FABRIC");
			if (!result.ok) {
				throw new Error("expected an admission");
			}
			expect(
				(await proposalOf(result.id)).proposalIntentOrder,
			).toBeNull();
		});

		// ---------------------------------------------------------------
		// Caps and dedup (spec Decision 16)
		// ---------------------------------------------------------------

		it("stops counting a proposal with an established append toward the proposer cap; a QUEUED one still counts", async () => {
			const branchId = await seedBranch();
			for (
				let n = 0;
				n < MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER - 1;
				n++
			) {
				await seedProposal();
			}
			await appended(branchId, 1, 1, ["a.md"]);

			expect(await admit([put("README.md", "under-cap")])).toMatchObject({
				ok: true,
			});
			// Now five QUEUED and one appended: the cap holds.
			expect(await admit([put("README.md", "over-cap")])).toEqual({
				ok: false,
				reason: "proposal_proposer_limit",
			});
		});

		it("dedups B, C, then B again as a new proposal once B's change is on the branch", async () => {
			const branchId = await seedBranch();
			const b = await admit([put("README.md", "B")]);
			if (!b.ok) {
				throw new Error("expected an admission");
			}
			// B is appended: OPEN with an acknowledged append.
			await db.projectInstructionSnapshot.update({
				where: { id: b.id },
				data: {
					pullRequestState: "OPEN",
					proposalBranchId: branchId,
					proposalBranchSequence: 1,
					proposalAssignment: 1,
				},
			});
			await seedOp(branchId, b.id, 1, "acked", ["README.md"]);
			const c = await admit([put("README.md", "C")]);
			expect(c).toMatchObject({ ok: true });

			const bAgain = await admit([put("README.md", "B")]);
			expect(bAgain).toMatchObject({ ok: true });
			if (!bAgain.ok) {
				throw new Error("expected a new proposal");
			}
			expect(bAgain.id).not.toBe(b.id);
		});

		it("dedups against a BLOCKED proposal with no journal operation, never one with an operation", async () => {
			const branchId = await seedBranch();
			const first = await admit([put("README.md", "blocked")]);
			if (!first.ok) {
				throw new Error("expected an admission");
			}
			await db.projectInstructionSnapshot.update({
				where: { id: first.id },
				data: {
					pullRequestState: "BLOCKED",
					proposalBranchId: branchId,
					proposalBranchSequence: 1,
					proposalAssignment: 1,
					pullRequestFailure: {
						phase: "append",
						code: "BRANCH_CONFLICT",
						retryable: false,
						at: "2026-09-27T00:00:00.000Z",
						params: {},
					},
				},
			});
			expect(await admit([put("README.md", "blocked")])).toMatchObject({
				ok: false,
				reason: "duplicate_proposal",
				existing: { id: first.id },
			});

			await seedOp(branchId, first.id, 1, "not_pushed", ["README.md"]);
			expect(await admit([put("README.md", "blocked")])).toMatchObject({
				ok: true,
			});
		});

		// ---------------------------------------------------------------
		// Withdrawal (spec §4.3 "Withdraw" rows, §6.8 "Request")
		// ---------------------------------------------------------------

		it("cancels a proposal not yet appended, with intent change and no command", async () => {
			const branchId = await seedBranch();
			const id = await seedProposal({
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
				pendingCommand: "APPEND",
				pendingCommandSeq: 3,
			});
			await seedOp(branchId, id, 2, "unknown", ["a.md"]);

			expect(await withdraw(id)).toEqual({
				ok: true,
				changed: true,
				version: expect.any(Number),
				pullRequest: "canceled",
				scope: "change",
			});
			expect(await proposalOf(id)).toMatchObject({
				pullRequestState: "CANCELED",
				proposalStatus: "REJECTED",
				pullRequestAttempt: 3,
				withdrawScope: "change",
				withdrawRequestedAt: expect.any(Date),
				pendingCommand: null,
				pendingCommandSeq: null,
			});
			const audits = await auditsFor(id);
			expect(audits.map((a) => a.action).sort()).toEqual([
				"project.instructions.pull_request_close_requested",
				"project.instructions.rejected",
			]);
			expect(
				audits.find(
					(a) =>
						a.action ===
						"project.instructions.pull_request_close_requested",
				)?.metadata,
			).toMatchObject({ scope: "change", stateBefore: "QUEUED" });
		});

		it("cancels a QUEUED proposal that has not joined a branch yet", async () => {
			const id = await seedProposal();
			expect(await withdraw(id)).toMatchObject({
				ok: true,
				pullRequest: "canceled",
			});
			expect((await proposalOf(id)).pullRequestState).toBe("CANCELED");
		});

		it("asks for the revert of an appended change while another change is live", async () => {
			const branchId = await seedBranch();
			const id = await appended(branchId, 1, 1, ["a.md"]);
			await seedProposal({
				proposalBranchId: branchId,
				proposalBranchSequence: 2,
				proposalAssignment: 1,
			});

			expect(await withdraw(id)).toMatchObject({
				ok: true,
				changed: true,
				pullRequest: "close_requested",
				scope: "change",
			});
			expect(await proposalOf(id)).toMatchObject({
				pullRequestState: "CLOSE_REQUESTED",
				proposalStatus: "PENDING",
				pullRequestAttempt: 3,
				withdrawScope: "change",
				withdrawRequestedAt: expect.any(Date),
				pendingCommand: "WITHDRAW",
				// The branch's nextExecutionSeq, read under its lock.
				pendingCommandSeq: 10,
			});
			expect((await branchOf(branchId)).state).toBe("OPEN");
			const audits = await auditsFor(id);
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				action: "project.instructions.pull_request_close_requested",
				metadata: { scope: "change", stateBefore: "OPEN", branchId },
			});
			// A repeat is answered from the state it left.
			expect(await withdraw(id)).toMatchObject({
				ok: true,
				changed: false,
				pullRequest: "close_requested",
				scope: "change",
			});
		});

		it("closes the branch for the last live change, keeping the proposal OPEN with a branch intent", async () => {
			const branchId = await seedBranch();
			const id = await appended(branchId, 1, 1, ["a.md"]);

			expect(await withdraw(id)).toMatchObject({
				ok: true,
				changed: true,
				pullRequest: "close_requested",
				scope: "branch",
			});
			expect(await branchOf(branchId)).toMatchObject({
				state: "CLOSE_REQUESTED",
				closeIntent: "WITHDRAW",
				attempt: 5,
			});
			expect(await proposalOf(id)).toMatchObject({
				pullRequestState: "OPEN",
				withdrawScope: "branch",
				withdrawRequestedAt: expect.any(Date),
				pendingCommand: null,
				pendingCommandSeq: null,
				pullRequestAttempt: 3,
			});
			expect((await auditsFor(id))[0]).toMatchObject({
				action: "project.instructions.pull_request_close_requested",
				metadata: { scope: "branch" },
			});
		});

		it("refuses a withdrawal a later change blocks, naming the paths and writing nothing", async () => {
			const branchId = await seedBranch();
			const id = await appended(branchId, 1, 1, ["a.md", "b.md"]);
			await appended(branchId, 2, 2, ["b.md"]);
			const before = await proposalOf(id);

			expect(await withdraw(id)).toEqual({
				ok: false,
				reason: "already_decided",
				withdrawBlocked: { paths: ["b.md"], count: 1 },
			});
			expect(
				await withdrawBranchProposal({
					snapshotId: id,
					projectId,
					organizationId: ORGANIZATION_ID,
					proposerUserId: USER_ID,
					audit: cancelAudit(id),
				}),
			).toMatchObject({
				kind: "blocked_by_later_change",
				paths: ["b.md"],
				count: 1,
			});
			expect(await proposalOf(id)).toEqual(before);
			expect((await branchOf(branchId)).state).toBe("OPEN");
			expect(await auditsFor(id)).toEqual([]);
		});

		it("withdraws again from OPEN WITHDRAW_OUTCOME_UNKNOWN by recording the command again", async () => {
			const branchId = await seedBranch();
			const id = await appended(branchId, 1, 1, ["a.md"], {
				pullRequestFailure: {
					phase: "revert",
					code: "WITHDRAW_OUTCOME_UNKNOWN",
					retryable: false,
					at: "2026-09-27T00:00:00.000Z",
					params: {},
				},
			});
			await seedOp(branchId, id, 3, "unknown", ["a.md"], "REVERT");
			await seedProposal({
				proposalBranchId: branchId,
				proposalBranchSequence: 2,
				proposalAssignment: 1,
			});

			expect(await withdraw(id)).toMatchObject({
				ok: true,
				pullRequest: "close_requested",
				scope: "change",
			});
			expect(await proposalOf(id)).toMatchObject({
				pullRequestState: "CLOSE_REQUESTED",
				pendingCommand: "WITHDRAW",
				pendingCommandSeq: 10,
				pullRequestFailure: null,
			});
		});

		it("reconciles from evidence first: an established revert answers as already canceled", async () => {
			const branchId = await seedBranch();
			const id = await appended(branchId, 1, 1, ["a.md"]);
			await seedOp(branchId, id, 2, "acked", ["a.md"], "REVERT");

			expect(await withdraw(id)).toMatchObject({
				ok: true,
				changed: false,
				pullRequest: "canceled",
			});
			expect((await proposalOf(id)).pullRequestState).toBe("CANCELED");
			expect((await branchOf(branchId)).state).toBe("OPEN");
		});

		it("writes nothing for a v1 row, whose #2563 cancel was retired with that path (Fizzy #2748)", async () => {
			const live = await seedProposal({
				pullRequestContext: { v: 1 },
				pullRequestRef: "fabric/instructions/op",
			});
			expect(await withdraw(live)).toEqual({
				ok: false,
				reason: "already_decided",
			});
			expect(await proposalOf(live)).toMatchObject({
				pullRequestState: "QUEUED",
				pullRequestAttempt: 2,
				withdrawRequestedAt: null,
				withdrawScope: null,
			});
			// A cancel it already took is answered as a repeated one was.
			const canceled = await seedProposal({
				pullRequestContext: { v: 1 },
				pullRequestState: "CANCELED",
				proposalStatus: "REJECTED",
			});
			expect(await withdraw(canceled)).toEqual({
				ok: true,
				changed: false,
				version: expect.any(Number),
				pullRequest: "canceled",
			});
			expect(await auditsFor(live)).toEqual([]);
			expect(await auditsFor(canceled)).toEqual([]);
		});

		// ---------------------------------------------------------------
		// The #2563 pre-create cancels (spec §4.3 "Validation REJECTED or
		// abandonment")
		// ---------------------------------------------------------------

		it("never cancels a v2 OPENING proposal with a journal operation through a #2563 pre-create event", async () => {
			const branchId = await seedBranch();
			const id = await seedProposal({
				pullRequestState: "OPENING",
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			await seedOp(branchId, id, 1, null, ["a.md"]);
			for (const event of ["validation_rejected", "abandoned"] as const) {
				expect(
					await transitionPullRequest({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						event,
						from: ["OPENING"],
						expectedAttempt: 2,
						to: "CANCELED",
						bumpAttempt: true,
						audit: {
							action: "project.instructions.pull_request_reconciled",
							category: "project",
							actor: { type: "system" },
							organizationId: ORGANIZATION_ID,
							projectId,
							resource: {
								type: "project_instruction_snapshot",
								id,
							},
							metadata: { outcome: "canceled" },
						},
					}),
				).toEqual({ ok: false });
			}
			expect((await proposalOf(id)).pullRequestState).toBe("OPENING");

			const clean = await seedProposal({
				pullRequestState: "OPENING",
				proposalBranchId: branchId,
				proposalBranchSequence: 2,
				proposalAssignment: 1,
			});
			expect(
				await transitionPullRequest({
					snapshotId: clean,
					organizationId: ORGANIZATION_ID,
					event: "validation_rejected",
					from: ["OPENING"],
					expectedAttempt: 2,
					to: "CANCELED",
					bumpAttempt: true,
					audit: {
						action: "project.instructions.pull_request_reconciled",
						category: "project",
						actor: { type: "system" },
						organizationId: ORGANIZATION_ID,
						projectId,
						resource: {
							type: "project_instruction_snapshot",
							id: clean,
						},
						metadata: { outcome: "canceled" },
					},
				}),
			).toEqual({ ok: true, attempt: 3 });
		});
	},
);
