import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	projectInstructionProposalBranch: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		groupBy: vi.fn(),
		updateMany: vi.fn(),
	},
	projectInstructionProposalBranchOperation: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
	},
	projectInstructionSnapshot: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn(),
	},
	$queryRaw: vi.fn(),
	$executeRaw: vi.fn(),
	$transaction: vi.fn(),
}));

vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db,
}));

const recordAuditTx = vi.hoisted(() => vi.fn());
vi.mock("../prisma/queries/audit-log", () => ({ recordAuditTx }));

import { Prisma } from "../prisma/client";
import {
	claimBranchAppend,
	getAcceptingBranchForMember,
	getBranchOperation,
	getBranchProposal,
	getProposalBranch,
	listBranchOperations,
	listMemberBranches,
	listProposalBranchOwnerIds,
	markForeignTip,
	recordBranchFailure,
	recordBranchOperation,
	releaseBlockedBranch,
	releaseBranchClaim,
	setOperationMembershipMany,
	stopTrackingBranch,
	transitionBranch,
	withBranchLockOrder,
} from "../prisma/queries/instruction-proposal-branches";

const organizationId = "example-org";
const project = { organizationId, projectId: "example-project" };
const member = { ...project, userId: "example-member" };
const scope = { organizationId, branchId: "example-branch" };
const branchWhere = { organizationId, id: scope.branchId };
const branches = db.projectInstructionProposalBranch;
const operations = db.projectInstructionProposalBranchOperation;
const now = new Date("2026-09-01T12:00:00Z");
const confirmationDueAt = new Date("2026-09-01T13:00:00Z");
const failure = {
	phase: "create",
	code: "CONFIGURATION_CHANGED",
	retryable: false,
	at: now.toISOString(),
	params: {},
} as const;

beforeEach(() => {
	vi.resetAllMocks();
	db.$queryRaw.mockResolvedValue([]);
	db.$transaction.mockImplementation(async (work) => work(db));
});

describe("tenant and project scope", () => {
	const tracked = {
		...project,
		untracked: false,
		OR: [
			{
				state: {
					in: [
						"PENDING",
						"OPENING",
						"OPEN",
						"CLOSE_REQUESTED",
						"BLOCKED",
					],
				},
			},
			{ membership: { path: ["status"], equals: "pending" } },
		],
	};

	it("looks up an accepting branch by organization, project and member together", async () => {
		branches.findFirst.mockResolvedValue(null);
		await expect(getAcceptingBranchForMember(member)).resolves.toBeNull();
		expect(branches.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: {
				...member,
				retiredAt: null,
				untracked: false,
				state: { in: ["PENDING", "OPENING", "OPEN", "BLOCKED"] },
			},
		});
	});

	it.each([member.userId, null])(
		"keeps branch listings in the project for owner filter %s",
		async (userId) => {
			const row = { id: scope.branchId, ...member };
			branches.findMany.mockResolvedValue([row]);
			await expect(
				listMemberBranches({ ...project, userId }),
			).resolves.toEqual([row]);
			expect(branches.findMany).toHaveBeenCalledExactlyOnceWith({
				where: { ...tracked, ...(userId === null ? {} : { userId }) },
				orderBy: [{ createdAt: "desc" }, { id: "asc" }],
			});
		},
	);

	it("pages distinct owners inside the project and excludes the caller", async () => {
		branches.groupBy
			.mockResolvedValueOnce([
				{ userId: "example-owner-a" },
				{ userId: "example-owner-b" },
			])
			.mockResolvedValueOnce([{ userId: "example-owner-b" }]);
		const request = { ...project, excludeUserId: member.userId, limit: 1 };
		const first = await listProposalBranchOwnerIds(request);
		expect(first).toEqual({
			ownerIds: ["example-owner-a"],
			nextCursor: "example-owner-a",
		});
		await expect(
			listProposalBranchOwnerIds({
				...request,
				cursor: first.nextCursor ?? undefined,
			}),
		).resolves.toEqual({
			ownerIds: ["example-owner-b"],
			nextCursor: null,
		});
		for (const [index, userId] of [
			{ not: member.userId },
			{ not: member.userId, gt: "example-owner-a" },
		].entries()) {
			expect(branches.groupBy).toHaveBeenNthCalledWith(index + 1, {
				by: ["userId"],
				where: { ...tracked, userId },
				orderBy: { userId: "asc" },
				take: 2,
			});
		}
	});

	it("fences individual branch and proposal reads and returns the database clock", async () => {
		const snapshotId = "example-snapshot";
		db.$queryRaw.mockResolvedValue([{ now }]);
		branches.findFirst.mockResolvedValue({ id: scope.branchId });
		db.projectInstructionSnapshot.findFirst.mockResolvedValue(null);
		await expect(getProposalBranch(scope)).resolves.toEqual({
			id: scope.branchId,
			databaseNow: now,
		});
		await expect(
			getBranchProposal({ organizationId, snapshotId }),
		).resolves.toBeNull();
		expect(branches.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: branchWhere,
		});
		expect(
			db.projectInstructionSnapshot.findFirst.mock.calls[0]?.[0].where,
		).toEqual({ organizationId, id: snapshotId });
	});

	it("scopes operation detail and journal reads and discards malformed entries", async () => {
		const operation = {
			id: "example-operation",
			...scope,
			entries: [{ invalid: true }],
		};
		operations.findMany.mockResolvedValue([operation]);
		operations.findFirst.mockResolvedValue(null);
		await expect(
			getBranchOperation({ organizationId, operationId: operation.id }),
		).resolves.toBeNull();
		await expect(listBranchOperations(scope)).resolves.toEqual([
			{ ...operation, entries: [] },
		]);
		expect(operations.findFirst.mock.calls[0]?.[0].where).toEqual({
			organizationId,
			id: operation.id,
		});
		expect(operations.findMany).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				where: scope,
				orderBy: { executionSeq: "asc" },
			}),
		);
	});
});

describe("branch writes", () => {
	it("rejects empty sources and any illegal source before updating", async () => {
		const transition = {
			...scope,
			to: "OPEN" as const,
			expectedAttempt: 4,
			bumpAttempt: true,
		};
		await expect(
			transitionBranch({ ...transition, from: [] }),
		).rejects.toThrow("names no source state");
		await expect(
			transitionBranch({ ...transition, from: ["OPENING", "MERGED"] }),
		).rejects.toThrow("Illegal branch transition");
		expect(branches.updateMany).not.toHaveBeenCalled();
	});

	it.each([1, 0])(
		"fences branch transitions by exact state, attempt and backoff (%i rows)",
		async (count) => {
			branches.updateMany.mockResolvedValue({ count });
			await expect(
				transitionBranch({
					...scope,
					from: ["OPENING"],
					to: "OPEN",
					expectedAttempt: 4,
					expectedNextAttemptAt: null,
					bumpAttempt: true,
					data: { failure: null },
				}),
			).resolves.toEqual(
				count ? { ok: true, attempt: 5 } : { ok: false },
			);
			expect(branches.updateMany).toHaveBeenCalledExactlyOnceWith({
				where: {
					...branchWhere,
					state: { in: ["OPENING"] },
					attempt: 4,
					untracked: false,
					nextAttemptAt: null,
				},
				data: {
					state: "OPEN",
					attempt: { increment: 1 },
					failure: Prisma.DbNull,
				},
			});
		},
	);

	it("records a failure without rewriting the state and ignores an untracked or missing row", async () => {
		branches.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		await expect(
			recordBranchFailure({ ...scope, failure, nextAttemptAt: now }),
		).resolves.toBe(true);
		await expect(recordBranchFailure({ ...scope, failure })).resolves.toBe(
			false,
		);
		expect(branches.updateMany).toHaveBeenNthCalledWith(1, {
			where: { ...branchWhere, untracked: false },
			data: { failure, nextAttemptAt: now },
		});
		expect(branches.updateMany).toHaveBeenNthCalledWith(2, {
			where: { ...branchWhere, untracked: false },
			data: { failure },
		});
	});

	const blocked = {
		id: scope.branchId,
		...project,
		state: "BLOCKED",
		untracked: false,
		attempt: 4,
		failure,
		headSha: "a".repeat(40),
		pullRequestExternalId: null,
		createIssuedAt: null,
	};
	const release = { ...scope, expectedAttempt: 4, refDeleted: true };

	it.each([
		{ label: "missing", row: null },
		{ label: "untracked", row: { ...blocked, untracked: true } },
		{ label: "stale attempt", row: { ...blocked, attempt: 5 } },
		{ label: "wrong state", row: { ...blocked, state: "OPEN" } },
		{
			label: "retryable refusal",
			row: { ...blocked, failure: { ...failure, retryable: true } },
		},
		{
			label: "unknown refusal",
			row: {
				...blocked,
				failure: { ...failure, code: "REPOSITORY_CHANGED" },
			},
		},
		{ label: "no head", row: { ...blocked, headSha: null } },
		{
			label: "existing receipt",
			row: { ...blocked, pullRequestExternalId: "example-pr" },
		},
		{ label: "issued create", row: { ...blocked, createIssuedAt: now } },
	])(
		"refuses release before any write for a $label branch",
		async ({ row }) => {
			branches.findFirst.mockResolvedValue(row);
			await expect(releaseBlockedBranch(release)).resolves.toEqual({
				ok: false,
				canceled: 0,
			});
			expect(branches.findFirst).toHaveBeenCalledExactlyOnceWith({
				where: branchWhere,
			});
			expect(branches.updateMany).not.toHaveBeenCalled();
			expect(
				db.projectInstructionSnapshot.updateMany,
			).not.toHaveBeenCalled();
			expect(db.$queryRaw).toHaveBeenCalledTimes(1);
		},
	);

	it("settles a releasable branch and reports a conflict if the fenced write loses", async () => {
		branches.findFirst.mockResolvedValue(blocked);
		db.$queryRaw
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ now }])
			.mockResolvedValueOnce([]);
		branches.updateMany.mockResolvedValueOnce({ count: 1 });
		await expect(releaseBlockedBranch(release)).resolves.toEqual({
			ok: true,
			canceled: 0,
		});
		expect(branches.updateMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				...branchWhere,
				attempt: 4,
				state: { in: ["BLOCKED"] },
				untracked: false,
			},
			data: {
				state: "CANCELED",
				attempt: { increment: 1 },
				settledAt: now,
				confirmations: 0,
				confirmationDueAt,
				nextAttemptAt: null,
				deletedAt: now,
			},
		});
		const [strings, ...params] = db.$queryRaw.mock.calls[2] ?? [];
		expect(strings.join("?").replace(/\s+/g, " ")).toContain(
			'WHERE "proposalBranchId" = ? AND "organizationId" = ?',
		);
		expect(params).toEqual([scope.branchId, organizationId]);

		branches.updateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			releaseBlockedBranch({ ...release, refDeleted: false }),
		).rejects.toThrow("refused its release");
		expect(branches.updateMany.mock.calls[1]?.[0].data).not.toHaveProperty(
			"deletedAt",
		);
	});

	it("stops tracking only a repository-changed branch and audits the scoped mutation", async () => {
		const request = { ...scope, actorUserId: member.userId };
		branches.findFirst
			.mockResolvedValueOnce(blocked)
			.mockResolvedValueOnce({
				...blocked,
				failure: { ...failure, code: "REPOSITORY_CHANGED" },
			});
		await expect(stopTrackingBranch(request)).resolves.toEqual({
			ok: false,
		});
		expect(branches.updateMany).not.toHaveBeenCalled();
		expect(recordAuditTx).not.toHaveBeenCalled();

		branches.updateMany.mockResolvedValueOnce({ count: 1 });
		await expect(stopTrackingBranch(request)).resolves.toEqual({
			ok: true,
		});
		expect(branches.updateMany).toHaveBeenCalledExactlyOnceWith({
			where: { ...branchWhere, untracked: false },
			data: {
				state: "CLOSED",
				untracked: true,
				attempt: { increment: 1 },
				confirmationDueAt: null,
				mergeSyncRequestedAt: null,
				mergeSyncDispatchedAt: null,
				retryRequestedAt: null,
				nextAttemptAt: null,
			},
		});
		expect(recordAuditTx).toHaveBeenCalledExactlyOnceWith(
			db,
			expect.objectContaining({
				organizationId,
				projectId: project.projectId,
				actor: { type: "user", userId: member.userId },
				metadata: expect.objectContaining({
					change: "untracked",
					canceled: 0,
				}),
			}),
		);
	});

	it("retries serialization and locks sync, sorted unique branches, then sorted unique proposals in the tenant", async () => {
		db.$transaction.mockRejectedValueOnce({ code: "P2034" });
		const work = vi.fn().mockResolvedValue("locked");
		await expect(
			withBranchLockOrder(
				{
					organizationId,
					syncId: "example-sync",
					branchIds: [
						"example-branch-b",
						"example-branch-a",
						"example-branch-b",
					],
					snapshotIds: [
						"example-snapshot-b",
						"example-snapshot-a",
						"example-snapshot-a",
					],
				},
				work,
			),
		).resolves.toBe("locked");
		expect(db.$transaction).toHaveBeenCalledTimes(2);
		const expected = [
			[
				'"project_instruction_repository_sync" WHERE "id" = ? AND "organizationId" = ? FOR SHARE',
				"example-sync",
			],
			[
				'"project_instruction_proposal_branch" WHERE "id" = ANY(?::text[]) AND "organizationId" = ? ORDER BY "id" FOR UPDATE',
				["example-branch-a", "example-branch-b"],
			],
			[
				'"project_instruction_snapshot" WHERE "id" = ANY(?::text[]) AND "organizationId" = ? ORDER BY "id" FOR UPDATE',
				["example-snapshot-a", "example-snapshot-b"],
			],
		] as const;
		expect(db.$queryRaw).toHaveBeenCalledTimes(expected.length);
		for (const [index, [sql, id]] of expected.entries()) {
			const [strings, ...params] = db.$queryRaw.mock.calls[index] ?? [];
			expect(strings.join("?").replace(/\s+/g, " ").trim()).toContain(
				sql,
			);
			expect(params).toEqual([id, organizationId]);
		}
		expect(work).toHaveBeenCalledExactlyOnceWith(db);
		expect(work.mock.invocationCallOrder[0]).toBeGreaterThan(
			db.$queryRaw.mock.invocationCallOrder[2] ?? 0,
		);
	});
});

describe("branch operation journal writes", () => {
	const snapshotId = "example-snapshot";
	const operationId = "example-operation";
	const request = {
		...scope,
		snapshotId,
		proposalAttempt: 4,
		kind: "APPEND" as const,
		ref: "fabric/example-branch",
		parentSha: null,
		sha: "a".repeat(40),
		entries: [],
	};
	const branch = {
		id: scope.branchId,
		state: "OPEN",
		untracked: false,
		retiredAt: null,
		ref: request.ref,
		headSha: null,
	};
	const proposal = {
		id: snapshotId,
		proposalBranchId: scope.branchId,
		proposalAssignment: 3,
		pullRequestAttempt: request.proposalAttempt,
		pullRequestState: "OPENING",
	};

	beforeEach(() => {
		db.$queryRaw.mockResolvedValueOnce([{ id: scope.branchId }]);
		branches.findFirst.mockResolvedValue(branch);
		operations.findFirst.mockResolvedValue(null);
	});

	it.each([
		{ label: "untracked branch", row: { ...branch, untracked: true } },
		{ label: "terminal branch", row: { ...branch, state: "CLOSED" } },
		{ label: "moved ref", row: { ...branch, ref: "fabric/example-moved" } },
		{ label: "retired branch", row: { ...branch, retiredAt: now } },
		{
			label: "existing head with a create-only push",
			row: { ...branch, headSha: "b".repeat(40) },
		},
	])("does not issue an append for a $label", async ({ row }) => {
		branches.findFirst.mockResolvedValue(row);
		await expect(recordBranchOperation(request)).resolves.toEqual({
			ok: false,
		});
		expect(operations.findFirst).not.toHaveBeenCalled();
		expect(operations.create).not.toHaveBeenCalled();
	});

	it("returns the unresolved result without issuing another push", async () => {
		operations.findFirst.mockResolvedValue({ id: operationId });
		await expect(recordBranchOperation(request)).resolves.toEqual({
			ok: false,
			unresolved: true,
		});
		expect(operations.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: { ...scope, outcome: null },
			select: { id: true },
		});
		expect(db.projectInstructionSnapshot.findFirst).not.toHaveBeenCalled();
		expect(operations.create).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "missing proposal", row: null },
		{
			label: "reassigned proposal",
			row: { ...proposal, proposalBranchId: "example-other-branch" },
		},
		{
			label: "different attempt",
			row: { ...proposal, pullRequestAttempt: 5 },
		},
		{
			label: "wrong proposal state",
			row: { ...proposal, pullRequestState: "QUEUED" },
		},
	])(
		"does not allocate an execution sequence for a $label",
		async ({ row }) => {
			db.$queryRaw.mockResolvedValueOnce([{ id: snapshotId }]);
			db.projectInstructionSnapshot.findFirst.mockResolvedValue(row);
			await expect(recordBranchOperation(request)).resolves.toEqual({
				ok: false,
			});
			expect(db.$queryRaw).toHaveBeenCalledTimes(2);
			expect(operations.create).not.toHaveBeenCalled();
		},
	);

	it("allocates a tenant-scoped sequence and records the exact assignment and attempt", async () => {
		db.$queryRaw
			.mockResolvedValueOnce([{ id: snapshotId }])
			.mockResolvedValueOnce([{ executionSeq: 7 }])
			.mockResolvedValueOnce([{ now }]);
		db.projectInstructionSnapshot.findFirst.mockResolvedValue(proposal);
		operations.create.mockResolvedValue({ id: operationId });
		await expect(recordBranchOperation(request)).resolves.toEqual({
			ok: true,
			operationId,
			executionSeq: 7,
		});
		expect(branches.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: branchWhere,
		});
		expect(
			db.projectInstructionSnapshot.findFirst.mock.calls[0]?.[0].where,
		).toEqual({ id: snapshotId, organizationId });
		const [strings, ...params] = db.$queryRaw.mock.calls[2] ?? [];
		expect(strings.join("?").replace(/\s+/g, " ")).toContain(
			'WHERE "id" = ? AND "organizationId" = ?',
		);
		expect(params).toEqual([scope.branchId, organizationId]);
		expect(operations.create).toHaveBeenCalledExactlyOnceWith({
			data: {
				...scope,
				snapshotId,
				kind: request.kind,
				executionSeq: 7,
				ref: request.ref,
				assignment: 3,
				attempt: 4,
				parentSha: null,
				sha: request.sha,
				entries: [],
				pushIssuedAt: now,
			},
			select: { id: true },
		});
	});

	it("marks a foreign tip only once in the organization", async () => {
		db.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		await expect(markForeignTip(scope)).resolves.toBe(true);
		await expect(markForeignTip(scope)).resolves.toBe(false);
		for (const [strings, ...params] of db.$executeRaw.mock.calls) {
			expect(strings.join("?").replace(/\s+/g, " ")).toContain(
				'WHERE "id" = ? AND "organizationId" = ? AND "foreignTipAt" IS NULL',
			);
			expect(params).toEqual([scope.branchId, organizationId]);
		}
	});

	it("classifies journal operations in the organization and preserves proved inclusion", async () => {
		await expect(
			setOperationMembershipMany({ organizationId, entries: [] }),
		).resolves.toBe(0);
		expect(db.$executeRaw).not.toHaveBeenCalled();
		db.$executeRaw.mockResolvedValueOnce(1);
		await expect(
			setOperationMembershipMany({
				organizationId,
				entries: [
					{ operationId, membership: "included" },
					{
						operationId: "example-other-operation",
						membership: "unverified",
					},
				],
			}),
		).resolves.toBe(1);
		const [strings, ...params] = db.$executeRaw.mock.calls[0] ?? [];
		expect(strings.join("?").replace(/\s+/g, " ")).toContain(
			'WHERE op."id" = v."id" AND op."organizationId" = ? AND (op."membership" IS DISTINCT FROM \'included\' OR v."membership" = \'included\')',
		);
		expect(params).toEqual([
			[operationId, "example-other-operation"],
			["included", "unverified"],
			organizationId,
		]);
	});
});

describe("proposal append claims", () => {
	const snapshotId = "example-snapshot";
	const proposal = {
		id: snapshotId,
		proposalBranchId: scope.branchId,
		proposalAssignment: 3,
		proposalBranchSequence: 1,
		pullRequestAttempt: 4,
		pullRequestState: "QUEUED",
		status: "READY",
		proposalStatus: "PENDING",
		withdrawRequestedAt: null,
		pullRequestFailure: null,
		pullRequestNextAttemptAt: null,
	};
	const snapshots = db.projectInstructionSnapshot;
	const presentation = { title: "Example proposal", body: "Example summary" };

	function prepareClaim(row: typeof proposal) {
		db.$queryRaw
			.mockResolvedValueOnce([{ id: scope.branchId }])
			.mockResolvedValueOnce([{ now }])
			.mockResolvedValueOnce([{ id: snapshotId }])
			.mockResolvedValueOnce([
				{ id: snapshotId, status: "READY", updatedAt: now },
			]);
		branches.findFirst.mockResolvedValue({
			id: scope.branchId,
			state: "OPEN",
			retiredAt: null,
			untracked: false,
			failure: null,
			attempt: 2,
			presentation: null,
		});
		snapshots.findMany.mockResolvedValue([proposal]);
		snapshots.findFirst.mockResolvedValue(row);
	}

	it.each([
		{
			label: "reassigned",
			row: { ...proposal, proposalBranchId: "example-other-branch" },
		},
		{
			label: "no longer READY",
			row: { ...proposal, status: "VALIDATING" },
		},
	])(
		"refuses to claim if the proposal is $label under its row lock",
		async ({ row }) => {
			prepareClaim(row);
			await expect(
				claimBranchAppend({ ...scope, presentation }),
			).resolves.toEqual({ kind: "none" });
			expect(snapshots.updateMany).not.toHaveBeenCalled();
			expect(branches.updateMany).not.toHaveBeenCalled();
		},
	);

	it("claims the READY proposal with an assignment fence and persists the first presentation", async () => {
		prepareClaim(proposal);
		snapshots.updateMany.mockResolvedValue({ count: 1 });
		branches.updateMany.mockResolvedValue({ count: 1 });

		await expect(
			claimBranchAppend({ ...scope, presentation }),
		).resolves.toEqual({
			kind: "claimed",
			snapshotId,
			proposalAttempt: 5,
			branchAttempt: 3,
		});
		expect(snapshots.findMany).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				where: {
					organizationId,
					proposalBranchId: scope.branchId,
					pullRequestState: {
						in: [
							"QUEUED",
							"OPENING",
							"OPEN",
							"CLOSE_REQUESTED",
							"BLOCKED",
						],
					},
				},
				orderBy: { proposalBranchSequence: "asc" },
			}),
		);
		expect(snapshots.updateMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				id: snapshotId,
				organizationId,
				proposalBranchId: scope.branchId,
				proposalAssignment: 3,
				AND: [
					{
						AND: [
							{
								pullRequestState: "QUEUED",
								pullRequestAttempt: 4,
							},
							{
								AND: [
									{
										AND: [
											{
												pullRequestContext: {
													path: ["v"],
													equals: 2,
												},
											},
											{ proposalBranchId: { not: null } },
										],
									},
									{ withdrawRequestedAt: null },
								],
							},
						],
					},
				],
			},
			data: {
				pullRequestState: "OPENING",
				proposalStatus: "PENDING",
				pullRequestAttempt: { increment: 1 },
				pullRequestFailure: Prisma.DbNull,
				pullRequestNextAttemptAt: null,
			},
		});
		expect(branches.updateMany).toHaveBeenCalledExactlyOnceWith({
			where: { ...branchWhere, attempt: 2 },
			data: { attempt: { increment: 1 }, presentation },
		});
	});

	it("leaves the branch unchanged when a conditional proposal claim loses", async () => {
		prepareClaim(proposal);
		snapshots.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			claimBranchAppend({ ...scope, presentation }),
		).resolves.toEqual({ kind: "none" });
		expect(branches.updateMany).not.toHaveBeenCalled();
	});

	it("does not release a claim at a stale proposal attempt", async () => {
		snapshots.findFirst.mockResolvedValue({
			...proposal,
			pullRequestState: "OPENING",
		});
		await expect(
			releaseBranchClaim({ ...scope, snapshotId, proposalAttempt: 3 }),
		).resolves.toEqual({
			released: false,
			retired: false,
		});
		expect(snapshots.findFirst.mock.calls[0]?.[0].where).toEqual({
			id: snapshotId,
			organizationId,
		});
		expect(snapshots.updateMany).not.toHaveBeenCalled();
		expect(branches.updateMany).not.toHaveBeenCalled();
	});
});
