import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	project: { findFirst: vi.fn() },
	projectInstructionSnapshot: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn(),
	},
	projectInstructionFile: { findMany: vi.fn() },
	$executeRaw: vi.fn(),
}));

vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db,
}));

import {
	claimInstructionValidationAttempt,
	getInstructionManifestDiff,
	getInstructionProposal,
	listInstructionProposals,
	moveInheritedInstructionFileKeys,
	recordInstructionSnapshotScanRulesVersion,
} from "../prisma/queries/instructions";

const scope = { projectId: "example-project", organizationId: "example-org" };
const snapshotId = "example-snapshot";
const snapshotWhere = { id: snapshotId, ...scope };
const proposals = db.projectInstructionSnapshot;
const proposal = {
	id: "example-proposal",
	userId: "example-author",
	baseSnapshotId: "example-base",
	contentKind: "FULL_SNAPSHOT",
	proposalStatus: "PENDING",
	approvals: [],
};

beforeEach(() => vi.resetAllMocks());

describe("proposal visibility", () => {
	beforeEach(() => {
		db.project.findFirst.mockResolvedValue({
			publishedInstructionSnapshotId: snapshotId,
			instructionSettings: null,
		});
		proposals.findMany.mockImplementation(async ({ where }) =>
			where.userId === undefined || where.userId === proposal.userId
				? [proposal]
				: [],
		);
	});

	it("keeps an explicitly empty proposer scope closed", async () => {
		await expect(
			listInstructionProposals(scope.projectId, scope.organizationId, {
				limit: 5,
				proposerUserId: "",
			}),
		).resolves.toEqual({ items: [], nextCursor: null });
		expect(proposals.findMany.mock.calls[0]?.[0].where).toEqual({
			...scope,
			proposalStatus: { not: null },
			userId: "",
		});
	});

	it.each([
		{ view: "proposer", proposerUserId: proposal.userId },
		{ view: "reviewer", proposerUserId: undefined },
	])("lists a scoped page for a $view", async ({ proposerUserId }) => {
		proposals.findMany.mockResolvedValueOnce([
			proposal,
			{ ...proposal, id: "example-older" },
		]);
		await expect(
			listInstructionProposals(scope.projectId, scope.organizationId, {
				limit: 1,
				cursor: "example-cursor",
				proposerUserId,
			}),
		).resolves.toEqual({
			items: [
				expect.objectContaining({ id: proposal.id, isStale: true }),
			],
			nextCursor: proposal.id,
		});
		expect(db.project.findFirst.mock.calls[0]?.[0].where).toEqual({
			id: scope.projectId,
			organizationId: scope.organizationId,
		});
		expect(proposals.findMany).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				where: {
					...scope,
					proposalStatus: { not: null },
					...(proposerUserId === undefined
						? {}
						: { userId: proposerUserId }),
				},
				cursor: { id: "example-cursor" },
				skip: 1,
				take: 2,
				orderBy: { version: "desc" },
			}),
		);
	});

	it("suppresses proposal results when the tenant-scoped project is missing", async () => {
		db.project.findFirst.mockResolvedValue(null);
		await expect(
			listInstructionProposals(scope.projectId, scope.organizationId, {
				limit: 5,
			}),
		).resolves.toEqual({ items: [], nextCursor: null });
		proposals.findFirst.mockResolvedValue(proposal);
		await expect(
			getInstructionProposal(
				proposal.id,
				scope.projectId,
				scope.organizationId,
				{
					proposerUserId: "",
				},
			),
		).resolves.toBeNull();
		expect(proposals.findFirst.mock.calls[0]?.[0].where).toEqual({
			id: proposal.id,
			...scope,
			proposalStatus: { not: null },
			userId: "",
		});
	});
});

describe("validation attempt ownership", () => {
	const input = { snapshotId, ...scope };
	const where = {
		...snapshotWhere,
		contentKind: "FULL_SNAPSHOT",
		status: { in: ["RECEIVING", "FAILED"] },
	};

	it.each([
		{ current: null, expected: null },
		{
			current: { validationAttemptId: "example-attempt" },
			expected: "example-attempt",
		},
	])(
		"does not allocate an attempt when the read returns $current",
		async ({ current, expected }) => {
			proposals.findFirst.mockResolvedValue(current);
			await expect(
				claimInstructionValidationAttempt(input),
			).resolves.toBe(expected);
			expect(proposals.findFirst).toHaveBeenCalledExactlyOnceWith({
				where,
				select: { validationAttemptId: true },
			});
			expect(proposals.updateMany).not.toHaveBeenCalled();
		},
	);

	it("persists and returns the fresh attempt only when the claim wins", async () => {
		proposals.findFirst.mockResolvedValue({ validationAttemptId: null });
		proposals.updateMany.mockResolvedValue({ count: 1 });
		const attempt = await claimInstructionValidationAttempt(input);
		expect(attempt).toEqual(expect.any(String));
		expect(proposals.updateMany).toHaveBeenCalledExactlyOnceWith({
			where: { ...where, validationAttemptId: null },
			data: { validationAttemptId: attempt },
		});
		expect(proposals.findFirst).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			winner: { validationAttemptId: "example-winner" },
			expected: "example-winner",
		},
		{ winner: null, expected: null },
	])(
		"rereads the same predicate after a lost claim ($expected)",
		async ({ winner, expected }) => {
			proposals.findFirst
				.mockResolvedValueOnce({ validationAttemptId: null })
				.mockResolvedValueOnce(winner);
			proposals.updateMany.mockResolvedValue({ count: 0 });
			await expect(
				claimInstructionValidationAttempt(input),
			).resolves.toBe(expected);
			expect(proposals.findFirst).toHaveBeenCalledTimes(2);
			expect(
				proposals.findFirst.mock.calls.map(([query]) => query.where),
			).toEqual([where, where]);
		},
	);

	it.each([1, 0])(
		"stamps scan rules only for the scoped attempt and eligible statuses (%i rows)",
		async (count) => {
			proposals.updateMany.mockResolvedValue({ count });
			await expect(
				recordInstructionSnapshotScanRulesVersion({
					...input,
					validationAttemptId: "example-attempt",
					statuses: ["RECEIVING", "VALIDATING"],
					scanRulesVersion: "example-rules",
				}),
			).resolves.toEqual({ changed: count === 1 });
			expect(proposals.updateMany).toHaveBeenCalledExactlyOnceWith({
				where: {
					...snapshotWhere,
					status: { in: ["RECEIVING", "VALIDATING"] },
					validationAttemptId: "example-attempt",
				},
				data: { scanRulesVersion: "example-rules" },
			});
		},
	);
});

describe("scoped instruction manifests and file moves", () => {
	const input = {
		...scope,
		baseDigest: "example-digest",
		headSnapshotId: snapshotId,
	};

	it("returns no diff when the READY base is missing and does not read the head", async () => {
		proposals.findFirst.mockResolvedValue(null);
		await expect(getInstructionManifestDiff(input)).resolves.toBeNull();
		expect(db.projectInstructionFile.findMany).not.toHaveBeenCalled();
	});

	it("scopes the digest lookup, base files and head files independently", async () => {
		proposals.findFirst.mockResolvedValue({
			id: "example-base",
			version: 2,
			files: [{ path: "AGENTS.md", sha256: "example-hash", mode: null }],
		});
		db.projectInstructionFile.findMany.mockResolvedValue([
			{ path: "AGENTS.md", sha256: "example-hash", mode: null },
		]);
		await expect(getInstructionManifestDiff(input)).resolves.toMatchObject({
			base: { id: "example-base", version: 2, digest: input.baseDigest },
		});
		expect(proposals.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: { ...scope, digest: input.baseDigest, status: "READY" },
			orderBy: { version: "desc" },
			select: {
				id: true,
				version: true,
				files: {
					where: scope,
					select: { path: true, sha256: true, mode: true },
				},
			},
		});
		expect(
			db.projectInstructionFile.findMany,
		).toHaveBeenCalledExactlyOnceWith({
			where: { ...scope, snapshotId },
			select: { path: true, sha256: true, mode: true },
		});
	});

	it("skips an empty move and compares tenant, project, snapshot and old key in a real move", async () => {
		const input = { ...scope, snapshotId };
		await expect(
			moveInheritedInstructionFileKeys({ ...input, moves: [] }),
		).resolves.toEqual({ moved: 0 });
		expect(db.$executeRaw).not.toHaveBeenCalled();

		db.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		const request = {
			...input,
			moves: [
				{
					fileId: "example-file",
					from: "example-source",
					to: "example-target",
				},
			],
		};
		await expect(
			moveInheritedInstructionFileKeys(request),
		).resolves.toEqual({ moved: 1 });
		await expect(
			moveInheritedInstructionFileKeys(request),
		).resolves.toEqual({ moved: 0 });
		for (const [strings, ...values] of db.$executeRaw.mock.calls) {
			expect(strings.join("?").replace(/\s+/g, " ").trim()).toContain(
				'WHERE f."id" = v."id" AND f."snapshotId" = ? AND f."projectId" = ? AND f."organizationId" = ? AND f."storageKey" = v."from"',
			);
			expect(values).toEqual([
				["example-file"],
				["example-source"],
				["example-target"],
				snapshotId,
				scope.projectId,
				scope.organizationId,
			]);
		}
	});
});
