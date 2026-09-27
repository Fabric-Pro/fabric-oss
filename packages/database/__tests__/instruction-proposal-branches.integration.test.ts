/**
 * Member proposal branch queries on a real Postgres (Fizzy #2738 spec §5
 * join and transfer, Decision 3 reservations, §4.1 facts, §6.1 claim, §6
 * loop, Decision 19 stop tracking). Self-skips without a reachable database.
 *
 * Naming uses the real `memberBranchRef`; repository identity is a small
 * GitHub-only stand-in for `@repo/integrations` (which depends on this
 * package), since these cases pin the database behaviour, not the
 * canonicaliser.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { memberBranchRef } from "../../instructions/src/proposal-branch-ref";
import { db, type Prisma } from "../index";
import {
	claimBranchAppend,
	joinProposalBranch,
	listProposalBranchOwnerIds,
	nextBranchWork,
	type ProposalBranchNaming,
	type ProposalRepositoryIdentity,
	recordBranchOperation,
	recordOperationOutcome,
	stopTrackingBranch,
	transferProposal,
} from "../prisma/queries/instruction-proposal-branches";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `pr-branches-org-${RUN_ID}`;
const USER_ID = `pr-branches-user-${RUN_ID}`;
const OTHER_USER_ID = `pr-branches-other-${RUN_ID}`;
const REPO = `branches-${RUN_ID}`;
const REPOSITORY_URL = `https://github.com/example-org/${REPO}`;
const REPOSITORY: ProposalRepositoryIdentity = {
	provider: "GITHUB",
	owner: "example-org",
	repo: REPO,
};
const REPOSITORY_KEY = `github:example-org/${REPO}`.toLowerCase();

const SHA = (c: string) => c.repeat(40);

const repositoryKey = (r: ProposalRepositoryIdentity) =>
	r.provider === "GITHUB"
		? `github:${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`
		: JSON.stringify(r);

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
	repositoryKey,
};

/** Two members whose names and ids render one candidate (Review Focus 3). */
const collidingNaming: ProposalBranchNaming = {
	...naming,
	memberBranchRef: ({ n }) =>
		`fabric/instructions/members/dev-example-zzzz/${n}`,
};

type Destination = {
	projectId: string;
	integrationId: string;
	syncId: string;
};

let main: Destination;
let other: Destination;
let version = 0;

async function seedProject(userId: string, name: string): Promise<Destination> {
	const project = await db.project.create({
		data: {
			name,
			userId,
			organizationId: ORGANIZATION_ID,
			techStack: [],
			features: [],
			tags: [],
			instructionSettings: { sourceOfTruth: "REPOSITORY" },
		},
	});
	const integration = await db.projectRepositoryIntegration.create({
		data: {
			projectId: project.id,
			provider: "GITHUB",
			authMethod: "OAUTH",
			repositoryUrl: REPOSITORY_URL,
			repositoryOwner: "example-org",
			repositoryName: REPO,
		},
	});
	const sync = await db.projectInstructionRepositorySync.create({
		data: {
			projectId: project.id,
			organizationId: ORGANIZATION_ID,
			userId,
			repositoryIntegrationId: integration.id,
			ref: "main",
			rootPath: ".claude",
		},
	});
	return {
		projectId: project.id,
		integrationId: integration.id,
		syncId: sync.id,
	};
}

function contextFor(d: Destination, over: Record<string, unknown> = {}) {
	return {
		v: 2,
		integrationId: d.integrationId,
		syncId: d.syncId,
		syncGeneration: 1,
		provider: "GITHUB",
		targetRef: "main",
		rootPath: ".claude",
		baseCommitSha: SHA("a"),
		repository: REPOSITORY,
		author: { name: "Dev Example", email: "dev@example.com" },
		committer: { name: "Fabric", email: "fabric@example.com" },
		message: "Update instructions",
		committedAt: "2026-09-27T00:00:00Z",
		...over,
	};
}

function destinationFor(d: Destination, over: Record<string, unknown> = {}) {
	return {
		integrationId: d.integrationId,
		syncId: d.syncId,
		repositoryKey: REPOSITORY_KEY,
		provider: "GITHUB",
		repository: REPOSITORY,
		targetRef: "main",
		rootPath: ".claude",
		...over,
	};
}

async function seedProposal(
	extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
	d: Destination = main,
	userId = USER_ID,
): Promise<string> {
	version += 1;
	const row = await db.projectInstructionSnapshot.create({
		data: {
			projectId: d.projectId,
			organizationId: ORGANIZATION_ID,
			userId,
			version,
			source: "UPLOAD",
			status: "READY",
			settingsFrozen: {},
			publishOnReady: false,
			proposalStatus: "PENDING",
			proposalDestination: "REPOSITORY",
			pullRequestOperationId: `br${RUN_ID.replace(/\D/g, "")}${version}`,
			pullRequestState: "QUEUED",
			pullRequestAttempt: 2,
			pullRequestContext: contextFor(d),
			...extra,
		},
		select: { id: true },
	});
	return row.id;
}

let branchNumber = 100;
async function seedBranch(
	extra: Partial<Prisma.ProjectInstructionProposalBranchUncheckedCreateInput> = {},
	d: Destination = main,
	userId = USER_ID,
): Promise<string> {
	branchNumber += 1;
	const row = await db.projectInstructionProposalBranch.create({
		data: {
			organizationId: ORGANIZATION_ID,
			projectId: d.projectId,
			userId,
			repositoryKey: REPOSITORY_KEY,
			number: branchNumber,
			ref: `fabric/instructions/members/seeded-abcd/${branchNumber}`,
			state: "OPEN",
			destination: destinationFor(d),
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
	outcome: string | null,
	kind: "APPEND" | "REVERT" = "APPEND",
	assignment = 1,
): Promise<string> {
	const row = await db.projectInstructionProposalBranchOperation.create({
		data: {
			organizationId: ORGANIZATION_ID,
			branchId,
			snapshotId,
			kind,
			executionSeq,
			ref: "fabric/instructions/members/seeded-abcd/1",
			assignment,
			attempt: 2,
			parentSha: executionSeq === 1 ? null : SHA("b"),
			sha: SHA(String(executionSeq % 10)),
			entries: [],
			pushIssuedAt: new Date(),
			outcome,
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
			proposalBranchId: true,
			proposalBranchSequence: true,
			proposalAssignment: true,
			proposalIntentOrder: true,
			pendingCommand: true,
		},
	});

const failure = (code: string, phase: string, retryable: boolean) => ({
	code,
	phase,
	retryable,
	at: "2026-09-27T00:00:00.000Z",
	params: {},
});

const join = (snapshotId: string, n: ProposalBranchNaming = naming) =>
	joinProposalBranch({
		snapshotId,
		organizationId: ORGANIZATION_ID,
		naming: n,
	});

describe.skipIf(!hasReachableDatabaseUrl())(
	"member proposal branch queries (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER_ID, OTHER_USER_ID]) {
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
					name: "Proposal Branches Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			main = await seedProject(USER_ID, "Proposal Branches Integration");
			other = await seedProject(
				OTHER_USER_ID,
				"Proposal Branches Elsewhere",
			);
		});

		afterEach(async () => {
			const projectIds = [main.projectId, other.projectId];
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId: { in: projectIds } },
			});
			await db.projectInstructionProposalBranch.deleteMany({
				where: { projectId: { in: projectIds } },
			});
			// Test cleanup only: product code never deletes a reservation.
			await db.projectInstructionProposalRefReservation.deleteMany({
				where: { organizationId: ORGANIZATION_ID },
			});
			// audit_log is append-only; tests purge their own rows the way
			// audit-log-seal.integration.test.ts does.
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "organizationId" = ${ORGANIZATION_ID}`,
			]);
			await db.projectInstructionRepositorySync.updateMany({
				where: { id: main.syncId },
				data: { ref: "main" },
			});
		});

		afterAll(async () => {
			await db.project.deleteMany({
				where: { id: { in: [main.projectId, other.projectId] } },
			});
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({
				where: { id: { in: [USER_ID, OTHER_USER_ID] } },
			});
			await db.$disconnect();
		});

		// -------------------------------------------------------------------
		// Join (spec §5)
		// -------------------------------------------------------------------

		it("puts two concurrent joins of one member on one branch, sequences 1 and 2", async () => {
			const a = await seedProposal();
			const b = await seedProposal();
			const results = await Promise.all([join(a), join(b)]);
			expect(results.map((r) => r.kind)).toEqual(["joined", "joined"]);
			const branchIds = new Set(
				results.map((r) => (r.kind === "joined" ? r.branchId : null)),
			);
			expect(branchIds.size).toBe(1);
			const [branchId] = [...branchIds] as string[];
			const branch = await branchOf(branchId);
			expect(branch).toMatchObject({
				state: "PENDING",
				nextSequence: 3,
				number: 1,
				repositoryKey: REPOSITORY_KEY,
				destination: destinationFor(main),
			});
			expect(branch.ref).toMatch(
				/^fabric\/instructions\/members\/dev-example-[0-9a-z]{4}\/1$/,
			);
			const sequences = await Promise.all([proposalOf(a), proposalOf(b)]);
			expect(
				sequences.map((p) => p.proposalBranchSequence).sort(),
			).toEqual([1, 2]);
			for (const p of sequences) {
				expect(p).toMatchObject({
					pullRequestState: "QUEUED",
					pullRequestAttempt: 2,
					proposalAssignment: 1,
					proposalBranchId: branchId,
				});
			}
			const reservations =
				await db.projectInstructionProposalRefReservation.findMany({
					where: { organizationId: ORGANIZATION_ID },
				});
			expect(reservations).toHaveLength(1);
			expect(reservations[0]).toMatchObject({
				ref: branch.ref,
				branchId,
				status: "current",
			});
		});

		it("answers a repeated join with the same assignment", async () => {
			const a = await seedProposal();
			const first = await join(a);
			expect(first.kind).toBe("joined");
			const again = await join(a);
			expect(again).toEqual({ ...first, kind: "already" });
			expect((await proposalOf(a)).proposalAssignment).toBe(1);
		});

		it("blocks a proposal whose frozen destination is stale and never retires the accepting branch", async () => {
			const accepting = await seedBranch({ state: "OPEN", number: 1 });
			const stale = await seedProposal({
				pullRequestContext: contextFor(main, { targetRef: "develop" }),
			});
			expect(await join(stale)).toEqual({
				kind: "configuration_changed",
			});
			const p = await proposalOf(stale);
			expect(p).toMatchObject({
				pullRequestState: "BLOCKED",
				pullRequestAttempt: 3,
				proposalBranchId: null,
				pullRequestFailure: {
					code: "CONFIGURATION_CHANGED",
					phase: "admission",
					retryable: false,
				},
			});
			expect(await branchOf(accepting)).toMatchObject({
				retiredAt: null,
				retiredReason: null,
				state: "OPEN",
			});
		});

		it("retires the accepting branch when the current destination changed, and opens the next one", async () => {
			const old = await seedBranch({
				number: 1,
				destination: destinationFor(main, { targetRef: "develop" }),
			});
			const a = await seedProposal();
			const result = await join(a);
			expect(result.kind).toBe("joined");
			const retired = await branchOf(old);
			expect(retired.retiredAt).not.toBeNull();
			expect(retired.retiredReason).toBe("CONFIGURATION_CHANGED");
			expect(retired.state).toBe("OPEN");
			if (result.kind !== "joined") {
				throw new Error("unreachable");
			}
			expect(result.branchId).not.toBe(old);
			expect((await branchOf(result.branchId)).number).toBe(2);
			const audits = await db.auditLog.findMany({
				where: { organizationId: ORGANIZATION_ID, resourceId: old },
				select: { action: true, metadata: true },
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]?.action).toBe(
				"project.instructions.pull_request_branch_updated",
			);
		});

		it("never reissues a reserved ref, across members and projects", async () => {
			await db.projectInstructionProposalRefReservation.create({
				data: {
					organizationId: ORGANIZATION_ID,
					repositoryKey: REPOSITORY_KEY,
					ref: "fabric/instructions/members/dev-example-zzzz/1",
					branchId: "branch_from_a_deleted_project",
					status: "retired",
				},
			});
			const first = await join(await seedProposal(), collidingNaming);
			if (first.kind !== "joined") {
				throw new Error("expected a join");
			}
			expect((await branchOf(first.branchId)).ref).toBe(
				"fabric/instructions/members/dev-example-zzzz/2",
			);
			// Settled: its reservation stays with it.
			await db.projectInstructionProposalBranch.update({
				where: { id: first.branchId },
				data: { state: "MERGED" },
			});
			const second = await join(await seedProposal(), collidingNaming);
			if (second.kind !== "joined") {
				throw new Error("expected a join");
			}
			expect(second.branchId).not.toBe(first.branchId);
			expect((await branchOf(second.branchId)).ref).toBe(
				"fabric/instructions/members/dev-example-zzzz/3",
			);
			// Another member, in another project on the same repository.
			const elsewhere = await join(
				await seedProposal({}, other, OTHER_USER_ID),
				collidingNaming,
			);
			if (elsewhere.kind !== "joined") {
				throw new Error("expected a join");
			}
			expect((await branchOf(elsewhere.branchId)).ref).toBe(
				"fabric/instructions/members/dev-example-zzzz/4",
			);
			const refs =
				await db.projectInstructionProposalRefReservation.findMany({
					where: { organizationId: ORGANIZATION_ID },
					orderBy: { ref: "asc" },
					select: { ref: true, branchId: true },
				});
			expect(refs.map((r) => r.ref.split("/").at(-1))).toEqual([
				"1",
				"2",
				"3",
				"4",
			]);
			expect(refs[1]?.branchId).toBe(first.branchId);
		});

		// -------------------------------------------------------------------
		// Transfer
		// -------------------------------------------------------------------

		it("refuses a transfer from another branch than expected, or from a live branch not starting over", async () => {
			const live = await seedBranch({ state: "OPEN", number: 1 });
			const merged = await seedBranch({ state: "MERGED", number: 2 });
			const id = await seedProposal({
				proposalBranchId: live,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const transfer = (
				expectedBranchId: string,
				newIntentOrder = false,
			) =>
				transferProposal({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					expectedBranchId,
					newIntentOrder,
					naming,
				});
			expect(await transfer(merged)).toEqual({ kind: "not_joinable" });
			expect(await transfer(live)).toEqual({ kind: "not_joinable" });
			expect(await proposalOf(id)).toMatchObject({
				proposalBranchId: live,
				proposalAssignment: 1,
				pullRequestAttempt: 2,
			});
		});

		it("rehomes a queued proposal off a merged branch, keeping its intent order", async () => {
			const merged = await seedBranch({ state: "MERGED", number: 1 });
			const id = await seedProposal({
				proposalBranchId: merged,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
				proposalIntentOrder: 7n,
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure("BRANCH_CONFLICT", "append", true),
			});
			const result = await transferProposal({
				snapshotId: id,
				organizationId: ORGANIZATION_ID,
				expectedBranchId: merged,
				newIntentOrder: false,
				naming,
			});
			expect(result).toMatchObject({
				kind: "joined",
				sequence: 1,
				assignment: 2,
			});
			if (result.kind !== "joined") {
				throw new Error("unreachable");
			}
			expect(result.branchId).not.toBe(merged);
			expect(await proposalOf(id)).toMatchObject({
				pullRequestState: "QUEUED",
				pullRequestAttempt: 3,
				pullRequestFailure: null,
				proposalBranchId: result.branchId,
				proposalIntentOrder: 7n,
			});
		});

		it("draws a new intent order for Propose again on a terminal proposal", async () => {
			const merged = await seedBranch({ state: "MERGED", number: 1 });
			const id = await seedProposal({
				proposalBranchId: merged,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
				proposalIntentOrder: 1n,
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
			});
			const refused = await transferProposal({
				snapshotId: id,
				organizationId: ORGANIZATION_ID,
				expectedBranchId: merged,
				newIntentOrder: false,
				naming,
			});
			expect(refused).toEqual({ kind: "not_joinable" });
			const [{ v: before } = { v: 0n }] = await db.$queryRaw<
				Array<{ v: bigint }>
			>`
				SELECT nextval('project_instruction_proposal_intent_seq') AS "v"`;
			const result = await transferProposal({
				snapshotId: id,
				organizationId: ORGANIZATION_ID,
				expectedBranchId: merged,
				newIntentOrder: true,
				naming,
			});
			expect(result.kind).toBe("joined");
			const p = await proposalOf(id);
			expect(p.pullRequestState).toBe("QUEUED");
			expect((p.proposalIntentOrder ?? 0n) > BigInt(before)).toBe(true);
		});

		// -------------------------------------------------------------------
		// Facts
		// -------------------------------------------------------------------

		it("applies outcomes monotonically", async () => {
			const branchId = await seedBranch({ state: "OPENING", number: 1 });
			const id = await seedProposal({
				pullRequestState: "OPEN",
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const record = (
				operationId: string,
				outcome: "acked" | "observed" | "not_pushed" | "unknown",
			) =>
				recordOperationOutcome({
					operationId,
					organizationId: ORGANIZATION_ID,
					outcome,
				});
			const acked = await seedOp(branchId, id, 1, "acked");
			expect((await record(acked, "unknown")).applied).toBe(false);
			expect((await record(acked, "not_pushed")).applied).toBe(false);
			const observed = await seedOp(branchId, id, 2, "observed");
			expect((await record(observed, "acked")).applied).toBe(true);
			const unknown = await seedOp(branchId, id, 3, "unknown");
			expect((await record(unknown, "not_pushed")).applied).toBe(false);
			const issued = await seedOp(branchId, id, 4, null);
			expect((await record(issued, "not_pushed")).applied).toBe(true);
			const outcomes =
				await db.projectInstructionProposalBranchOperation.findMany({
					where: { branchId },
					orderBy: { executionSeq: "asc" },
					select: { outcome: true },
				});
			expect(outcomes.map((o) => o.outcome)).toEqual([
				"acked",
				"acked",
				"unknown",
				"not_pushed",
			]);
			// observed -> acked is not a new establishment.
			expect((await branchOf(branchId)).factsRevision).toBe(0);
		});

		it("moves the head only forward and counts each establishment", async () => {
			const branchId = await seedBranch({
				state: "PENDING",
				number: 1,
				headSha: null,
			});
			const id = await seedProposal({
				pullRequestState: "OPENING",
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const op1 = await seedOp(branchId, id, 1, null);
			const op2 = await seedOp(branchId, id, 2, null);
			await recordOperationOutcome({
				operationId: op2,
				organizationId: ORGANIZATION_ID,
				outcome: "acked",
			});
			await recordOperationOutcome({
				operationId: op1,
				organizationId: ORGANIZATION_ID,
				outcome: "acked",
			});
			const branch = await branchOf(branchId);
			expect(branch).toMatchObject({
				headSha: SHA("2"),
				headExecutionSeq: 2,
				factsRevision: 2,
				state: "OPENING",
				startSha: SHA("b"),
			});
			const audits = await db.auditLog.findMany({
				where: {
					organizationId: ORGANIZATION_ID,
					resourceId: branchId,
				},
			});
			expect(audits).toHaveLength(2);
		});

		it("returns a settled branch's membership to pending on a new establishment", async () => {
			const branchId = await seedBranch({
				state: "MERGED",
				number: 1,
				membership: {
					status: "done",
					at: "2026-09-27T00:00:00.000Z",
					attempts: 1,
				},
			});
			const id = await seedProposal({
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const op = await seedOp(branchId, id, 1, "unknown");
			await recordOperationOutcome({
				operationId: op,
				organizationId: ORGANIZATION_ID,
				outcome: "observed",
			});
			const branch = await branchOf(branchId);
			expect(branch.membership).toMatchObject({
				status: "pending",
				attempts: 0,
			});
			expect(branch.factsRevision).toBe(1);
			expect((await proposalOf(id)).pullRequestState).toBe("MERGED");
		});

		it("issues an operation only for the claimed attempt, on the branch's current ref", async () => {
			const branchId = await seedBranch({
				state: "PENDING",
				number: 1,
				ref: "fabric/instructions/members/dev-example-abcd/1",
			});
			const id = await seedProposal({
				pullRequestState: "OPENING",
				pullRequestAttempt: 5,
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const issue = (
				over: Partial<Parameters<typeof recordBranchOperation>[0]> = {},
			) =>
				recordBranchOperation({
					branchId,
					organizationId: ORGANIZATION_ID,
					snapshotId: id,
					proposalAttempt: 5,
					kind: "APPEND",
					ref: "fabric/instructions/members/dev-example-abcd/1",
					parentSha: null,
					sha: SHA("c"),
					entries: [],
					...over,
				});
			expect(await issue({ proposalAttempt: 4 })).toEqual({ ok: false });
			expect(
				await issue({
					ref: "fabric/instructions/members/dev-example-abcd/2",
				}),
			).toEqual({
				ok: false,
			});
			expect(await issue({ parentSha: SHA("b") })).toEqual({ ok: false });
			const first = await issue();
			expect(first).toMatchObject({ ok: true, executionSeq: 1 });
			// Spec §6 loop item 1: nothing more is issued on the branch while
			// the first push has no outcome (an overlapping attempt of the same
			// claim is refused, and the loop recovers the first).
			expect(await issue({ sha: SHA("d") })).toEqual({
				ok: false,
				unresolved: true,
			});
			expect((await branchOf(branchId)).nextExecutionSeq).toBe(2);
			if (!first.ok) {
				throw new Error("unreachable");
			}
			await recordOperationOutcome({
				operationId: first.operationId,
				organizationId: ORGANIZATION_ID,
				outcome: "not_pushed",
			});
			const second = await issue();
			expect(second).toMatchObject({ ok: true, executionSeq: 2 });
			expect((await branchOf(branchId)).nextExecutionSeq).toBe(3);
		});

		it("refuses a revert while an append on the branch is still issued, whichever proposal issued it", async () => {
			const branchId = await seedBranch({
				state: "OPEN",
				number: 1,
				ref: "fabric/instructions/members/dev-example-abcd/1",
				headSha: SHA("b"),
				startSha: SHA("a"),
				headExecutionSeq: 1,
				nextExecutionSeq: 2,
			});
			const appending = await seedProposal({
				pullRequestState: "OPENING",
				pullRequestAttempt: 3,
				proposalBranchId: branchId,
				proposalBranchSequence: 2,
				proposalAssignment: 1,
			});
			const reverting = await seedProposal({
				pullRequestState: "CLOSE_REQUESTED",
				pullRequestAttempt: 4,
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const base = {
				branchId,
				organizationId: ORGANIZATION_ID,
				ref: "fabric/instructions/members/dev-example-abcd/1",
				parentSha: SHA("b"),
				entries: [],
			};
			const append = await recordBranchOperation({
				...base,
				snapshotId: appending,
				proposalAttempt: 3,
				kind: "APPEND",
				sha: SHA("c"),
			});
			expect(append).toMatchObject({ ok: true });
			expect(
				await recordBranchOperation({
					...base,
					snapshotId: reverting,
					proposalAttempt: 4,
					kind: "REVERT",
					sha: SHA("e"),
				}),
			).toEqual({ ok: false, unresolved: true });
			expect(
				await db.projectInstructionProposalBranchOperation.count({
					where: { branchId },
				}),
			).toBe(1);
		});

		// -------------------------------------------------------------------
		// Claim (spec §6.1)
		// -------------------------------------------------------------------

		it("claims the lowest runnable proposal and bumps both attempts", async () => {
			const branchId = await seedBranch({
				state: "OPEN",
				number: 1,
				attempt: 7,
			});
			const on = (
				sequence: number,
				extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
			) =>
				seedProposal({
					proposalBranchId: branchId,
					proposalBranchSequence: sequence,
					proposalAssignment: 1,
					...extra,
				});
			await on(1, { pullRequestState: "OPEN" });
			await on(2, {
				pullRequestState: "BLOCKED",
				pullRequestFailure: failure(
					"PUSH_OUTCOME_UNKNOWN",
					"append",
					false,
				),
			});
			const head = await on(3);
			await on(4);
			const claim = await claimBranchAppend({
				branchId,
				organizationId: ORGANIZATION_ID,
				presentation: {
					title: "Update instructions",
					body: "From Fabric",
				},
			});
			expect(claim).toEqual({
				kind: "claimed",
				snapshotId: head,
				proposalAttempt: 3,
				branchAttempt: 8,
			});
			expect(await proposalOf(head)).toMatchObject({
				pullRequestState: "OPENING",
				pullRequestAttempt: 3,
			});
			const branch = await branchOf(branchId);
			expect(branch.attempt).toBe(8);
			expect(branch.presentation).toEqual({
				title: "Update instructions",
				body: "From Fabric",
			});
		});

		it("claims nothing behind a lower CLOSE_REQUESTED, a validating head, or on a branch that does not accept appends", async () => {
			const branchId = await seedBranch({ state: "OPEN", number: 1 });
			const closing = await seedProposal({
				pullRequestState: "CLOSE_REQUESTED",
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			await seedProposal({
				proposalBranchId: branchId,
				proposalBranchSequence: 2,
				proposalAssignment: 1,
			});
			const claim = () =>
				claimBranchAppend({
					branchId,
					organizationId: ORGANIZATION_ID,
				});
			expect(await claim()).toEqual({ kind: "none" });
			await db.projectInstructionSnapshot.update({
				where: { id: closing },
				data: { pullRequestState: "OPEN" },
			});
			await db.projectInstructionSnapshot.updateMany({
				where: {
					proposalBranchId: branchId,
					proposalBranchSequence: 2,
				},
				data: { status: "VALIDATING" },
			});
			expect(await claim()).toEqual({ kind: "none" });
			await db.projectInstructionSnapshot.updateMany({
				where: {
					proposalBranchId: branchId,
					proposalBranchSequence: 2,
				},
				data: { status: "READY" },
			});
			await db.projectInstructionProposalBranch.update({
				where: { id: branchId },
				data: { state: "CLOSE_REQUESTED", closeIntent: "WITHDRAW" },
			});
			expect(await claim()).toEqual({ kind: "none" });
		});

		// -------------------------------------------------------------------
		// The loop's read
		// -------------------------------------------------------------------

		it("recovers before closing, closes before reverting, and idles an untracked branch", async () => {
			const branchId = await seedBranch({
				state: "CLOSE_REQUESTED",
				closeIntent: "WITHDRAW",
				number: 1,
			});
			const id = await seedProposal({
				pullRequestState: "CLOSE_REQUESTED",
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const op = await seedOp(branchId, id, 1, null);
			const next = () =>
				nextBranchWork({ branchId, organizationId: ORGANIZATION_ID });
			expect(await next()).toEqual({ kind: "recover", operationId: op });
			await db.projectInstructionProposalBranchOperation.update({
				where: { id: op },
				data: { outcome: "acked" },
			});
			expect(await next()).toEqual({ kind: "close" });
			await db.projectInstructionProposalBranch.update({
				where: { id: branchId },
				data: { state: "OPEN", closeIntent: null },
			});
			expect(await next()).toEqual({
				kind: "revert",
				snapshotId: id,
				proposalAttempt: 2,
			});
			await db.projectInstructionProposalBranch.update({
				where: { id: branchId },
				data: { untracked: true, state: "CLOSED" },
			});
			expect(await next()).toEqual({ kind: "idle", wakeAt: null });
		});

		// -------------------------------------------------------------------
		// Stop tracking (Decision 19)
		// -------------------------------------------------------------------

		it("stops tracking in one transaction and only on REPOSITORY_CHANGED", async () => {
			const branchId = await seedBranch({
				state: "OPEN",
				number: 1,
				failure: failure("PERMISSION_REVOKED", "create", false),
				confirmationDueAt: new Date(),
				mergeSyncRequestedAt: new Date(),
			});
			const open = await seedProposal({
				pullRequestState: "OPEN",
				proposalBranchId: branchId,
				proposalBranchSequence: 1,
				proposalAssignment: 1,
			});
			const queued = await seedProposal({
				proposalBranchId: branchId,
				proposalBranchSequence: 2,
				proposalAssignment: 1,
				pendingCommand: "APPEND",
				pendingCommandSeq: 4,
			});
			const merged = await seedProposal({
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
				proposalBranchId: branchId,
				proposalBranchSequence: 3,
				proposalAssignment: 1,
			});
			const stop = () =>
				stopTrackingBranch({
					branchId,
					organizationId: ORGANIZATION_ID,
					actorUserId: USER_ID,
				});
			expect(await stop()).toEqual({ ok: false });
			await db.projectInstructionProposalBranch.update({
				where: { id: branchId },
				data: {
					failure: failure("REPOSITORY_CHANGED", "reconcile", false),
				},
			});
			expect(await stop()).toEqual({ ok: true });
			expect(await branchOf(branchId)).toMatchObject({
				state: "CLOSED",
				untracked: true,
				confirmationDueAt: null,
				mergeSyncRequestedAt: null,
				nextAttemptAt: null,
				retryRequestedAt: null,
			});
			for (const id of [open, queued]) {
				expect(await proposalOf(id)).toMatchObject({
					pullRequestState: "CANCELED",
					pendingCommand: null,
					pullRequestFailure: {
						code: "REPOSITORY_CHANGED",
						phase: "close",
					},
				});
			}
			expect((await proposalOf(merged)).pullRequestState).toBe("MERGED");
			expect(await stop()).toEqual({ ok: false });
		});

		// -------------------------------------------------------------------
		// listProposalBranchOwnerIds (Fizzy #2738 spec §10 reviewer aggregate
		// read; round-3 review finding: this discovery has to be bounded and
		// cursor-paged IN THE DATABASE, never "load everything, cap in
		// memory" — a project with more owners than fit in one page must not
		// silently drop the rest.)
		// -------------------------------------------------------------------

		describe("listProposalBranchOwnerIds", () => {
			const MEMBER_A = `member-a-${RUN_ID}`;
			const MEMBER_B = `member-b-${RUN_ID}`;
			const MEMBER_C = `member-c-${RUN_ID}`;

			it("orders distinct owners by userId ascending, one row per owner even with several branches each", async () => {
				await seedBranch({ userId: MEMBER_B, state: "OPEN" });
				await seedBranch({ userId: MEMBER_A, state: "OPEN" });
				// A second TRACKED branch for the same owner (its prior one,
				// closing) must not produce a duplicate entry. Not a second
				// PENDING/OPENING/OPEN/BLOCKED branch: the accepting index
				// (spec Decision 2) allows only one of those per member.
				await seedBranch({
					userId: MEMBER_A,
					state: "CLOSE_REQUESTED",
				});
				await seedBranch({ userId: MEMBER_C, state: "OPEN" });

				const page = await listProposalBranchOwnerIds({
					projectId: main.projectId,
					organizationId: ORGANIZATION_ID,
					excludeUserId: "nobody-here",
					limit: 10,
				});

				expect(page).toEqual({
					ownerIds: [MEMBER_A, MEMBER_B, MEMBER_C],
					nextCursor: null,
				});
			});

			it("pages with a cursor: the second page picks up exactly where the first left off, nobody missing or repeated", async () => {
				await seedBranch({ userId: MEMBER_A, state: "OPEN" });
				await seedBranch({ userId: MEMBER_B, state: "OPEN" });
				await seedBranch({ userId: MEMBER_C, state: "OPEN" });

				const first = await listProposalBranchOwnerIds({
					projectId: main.projectId,
					organizationId: ORGANIZATION_ID,
					excludeUserId: "nobody-here",
					limit: 2,
				});
				expect(first).toEqual({
					ownerIds: [MEMBER_A, MEMBER_B],
					nextCursor: MEMBER_B,
				});

				const second = await listProposalBranchOwnerIds({
					projectId: main.projectId,
					organizationId: ORGANIZATION_ID,
					excludeUserId: "nobody-here",
					cursor: first.nextCursor as string,
					limit: 2,
				});
				expect(second).toEqual({
					ownerIds: [MEMBER_C],
					nextCursor: null,
				});

				expect([...first.ownerIds, ...second.ownerIds]).toEqual([
					MEMBER_A,
					MEMBER_B,
					MEMBER_C,
				]);
			});

			it("excludes the caller's own owner id", async () => {
				await seedBranch({ userId: MEMBER_A, state: "OPEN" });
				await seedBranch({ userId: MEMBER_B, state: "OPEN" });

				const page = await listProposalBranchOwnerIds({
					projectId: main.projectId,
					organizationId: ORGANIZATION_ID,
					excludeUserId: MEMBER_A,
					limit: 10,
				});

				expect(page.ownerIds).toEqual([MEMBER_B]);
			});

			it("never returns an owner whose only branches are untracked or terminal", async () => {
				await seedBranch({ userId: MEMBER_A, state: "MERGED" });
				await seedBranch({
					userId: MEMBER_B,
					state: "OPEN",
					untracked: true,
				});
				await seedBranch({ userId: MEMBER_C, state: "OPEN" });

				const page = await listProposalBranchOwnerIds({
					projectId: main.projectId,
					organizationId: ORGANIZATION_ID,
					excludeUserId: "nobody-here",
					limit: 10,
				});

				expect(page.ownerIds).toEqual([MEMBER_C]);
			});

			it("scopes to the given project: another project's tracked branch, even in the same organization, never appears", async () => {
				await seedBranch({ userId: MEMBER_A, state: "OPEN" }, main);
				await seedBranch({ userId: MEMBER_B, state: "OPEN" }, other);

				const page = await listProposalBranchOwnerIds({
					projectId: main.projectId,
					organizationId: ORGANIZATION_ID,
					excludeUserId: "nobody-here",
					limit: 10,
				});

				expect(page.ownerIds).toEqual([MEMBER_A]);
			});

			it("scopes to the given organization: a mismatched organizationId reads nothing, even for the right project", async () => {
				await seedBranch({ userId: MEMBER_A, state: "OPEN" }, main);

				const page = await listProposalBranchOwnerIds({
					projectId: main.projectId,
					organizationId: "some-other-org",
					excludeUserId: "nobody-here",
					limit: 10,
				});

				expect(page.ownerIds).toEqual([]);
			});
		});
	},
);
