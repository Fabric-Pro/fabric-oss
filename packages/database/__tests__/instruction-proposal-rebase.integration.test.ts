/**
 * A rebase of a stale proposal against real Postgres: the new proposal
 * records the stale one it replaces, and the stale one is closed only when
 * the new one is READY. An upload that never finishes and a gate rejection
 * both leave it pending, so the proposer is never left with neither.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	cancelInstructionProposal,
	createDerivedInstructionSnapshot,
	db,
	markInstructionSnapshotReady,
	markInstructionSnapshotRejected,
	rejectAbandonedInstructionSnapshot,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `instruction-rebase-org-${RUN_ID}`;
const PROPOSER_ID = `instruction-rebase-author-${RUN_ID}`;
const REBASED_ACTION = "project.instructions.proposal_rebased";
let projectId = "";

async function createSnapshot(input: {
	id: string;
	version: number;
	proposalStatus?: "PENDING";
	baseSnapshotId?: string;
}) {
	return db.projectInstructionSnapshot.create({
		data: {
			id: input.id,
			projectId,
			organizationId: ORGANIZATION_ID,
			userId: PROPOSER_ID,
			version: input.version,
			source: "UPLOAD",
			status: "READY",
			proposalStatus: input.proposalStatus ?? null,
			baseSnapshotId: input.baseSnapshotId,
			baseVersion: input.baseSnapshotId ? 1 : null,
			settingsFrozen: {},
			publishOnReady: false,
			readyAt: new Date(),
		},
	});
}

/**
 * Version 1, the proposer's stale proposal on it (version 2), and version 3
 * published with two files a rebase can delete.
 */
async function seedStaleProposal(testName: string) {
	const oldBaseId = `${testName}-old-base-${RUN_ID}`;
	const staleId = `${testName}-stale-${RUN_ID}`;
	const publishedId = `${testName}-published-${RUN_ID}`;
	await createSnapshot({ id: oldBaseId, version: 1 });
	await createSnapshot({
		id: staleId,
		version: 2,
		proposalStatus: "PENDING",
		baseSnapshotId: oldBaseId,
	});
	await createSnapshot({ id: publishedId, version: 3 });
	const basePrefix = `projects/${projectId}/instructions/snapshots/${publishedId}/`;
	await db.projectInstructionFile.createMany({
		data: ["CLAUDE.md", "REMOVE-0.md", "REMOVE-1.md"].map(
			(path, index) => ({
				snapshotId: publishedId,
				projectId,
				organizationId: ORGANIZATION_ID,
				userId: PROPOSER_ID,
				path,
				kind: "INSTRUCTIONS" as const,
				storageKey: `${basePrefix}base-file-${index}`,
				sha256: String(index).padStart(64, "0"),
				size: 10,
				mimeType: "text/markdown",
				isText: true,
			}),
		),
	});
	await db.project.update({
		where: { id: projectId },
		data: { publishedInstructionSnapshotId: publishedId },
	});
	return { staleId, publishedId, basePrefix };
}

function rebase(
	seeded: { staleId: string; publishedId: string; basePrefix: string },
	path = "REMOVE-0.md",
) {
	return createDerivedInstructionSnapshot({
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: PROPOSER_ID,
		baseSnapshotId: seeded.publishedId,
		publishOnReady: false,
		proposal: true,
		changes: [{ op: "delete", path }],
		limits: { maxFiles: 5_000, maxTotalBytes: 52_428_800 },
		baseKeyPrefix: seeded.basePrefix,
		supersedes: { snapshotId: seeded.staleId },
	});
}

async function rebasedId(seeded: {
	staleId: string;
	publishedId: string;
	basePrefix: string;
}) {
	const created = await rebase(seeded);
	if (!created.ok) {
		throw new Error(`rebase refused: ${created.reason}`);
	}
	return created.id;
}

function proposalStatusOf(id: string) {
	return db.projectInstructionSnapshot
		.findUniqueOrThrow({ where: { id }, select: { proposalStatus: true } })
		.then((row) => row.proposalStatus);
}

function rebasedAudits(staleId: string) {
	return db.auditLog.findMany({
		where: {
			organizationId: ORGANIZATION_ID,
			action: REBASED_ACTION,
			resourceId: staleId,
		},
	});
}

function ready(snapshotId: string) {
	return markInstructionSnapshotReady({
		snapshotId,
		projectId,
		organizationId: ORGANIZATION_ID,
		fileCount: 2,
		storedBytes: 20,
		digest: "d".repeat(64),
		readyAt: new Date(),
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"instruction proposal rebase (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: PROPOSER_ID,
					name: "Rebase Author",
					email: `${PROPOSER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Instruction Rebase Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Instruction Rebase Integration",
					userId: PROPOSER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
		});

		afterEach(async () => {
			await db.project.update({
				where: { id: projectId },
				data: { publishedInstructionSnapshotId: null },
			});
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId },
			});
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			// The audit log is append-only; a purge sets the bypass in the same
			// transaction as the delete.
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.auditLog.deleteMany({
					where: { organizationId: ORGANIZATION_ID },
				}),
			]);
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: PROPOSER_ID } });
			await db.$disconnect();
		});

		it("records the stale proposal on the rebase and leaves it pending", async () => {
			const seeded = await seedStaleProposal("link");

			const id = await rebasedId(seeded);

			const row = await db.projectInstructionSnapshot.findUniqueOrThrow({
				where: { id },
				select: { supersedesSnapshotId: true, proposalStatus: true },
			});
			expect(row).toEqual({
				supersedesSnapshotId: seeded.staleId,
				proposalStatus: "PENDING",
			});
			expect(await proposalStatusOf(seeded.staleId)).toBe("PENDING");
			expect(await rebasedAudits(seeded.staleId)).toHaveLength(0);
		});

		it("refuses a second rebase while the first is still pending", async () => {
			const seeded = await seedStaleProposal("second");
			await rebasedId(seeded);

			const second = await rebase(seeded, "REMOVE-1.md");

			expect(second).toEqual({
				ok: false,
				reason: "supersede_unavailable",
			});
		});

		it("answers a retried rebase with the row its first attempt wrote", async () => {
			const seeded = await seedStaleProposal("retry");
			const id = await rebasedId(seeded);

			const retried = await rebase(seeded);

			expect(retried).toMatchObject({
				ok: false,
				reason: "duplicate_proposal",
				existing: { id },
			});
		});

		it("leaves the stale proposal pending when the rebase's upload is abandoned", async () => {
			const seeded = await seedStaleProposal("abandoned");
			const id = await rebasedId(seeded);

			await rejectAbandonedInstructionSnapshot({
				snapshotId: id,
				projectId,
				organizationId: ORGANIZATION_ID,
				source: "inline_submit_compensation",
			});

			expect(await proposalStatusOf(id)).toBe("REJECTED");
			expect(await proposalStatusOf(seeded.staleId)).toBe("PENDING");
			expect(await rebasedAudits(seeded.staleId)).toHaveLength(0);
			// The stale proposal can be rebased again.
			expect(await rebase(seeded, "REMOVE-1.md")).toMatchObject({
				ok: true,
			});
		});

		it("leaves the stale proposal pending when the gate rejects the rebase", async () => {
			const seeded = await seedStaleProposal("gate");
			const id = await rebasedId(seeded);

			await markInstructionSnapshotRejected({
				snapshotId: id,
				projectId,
				organizationId: ORGANIZATION_ID,
				rejections: [{ path: "CLAUDE.md", reason: "secret" }],
				audit: {
					action: "project.instructions.rejected",
					category: "project",
					actor: { type: "system" },
					organizationId: ORGANIZATION_ID,
					projectId,
					resource: { type: "project_instruction_snapshot", id },
				},
			});

			expect(await proposalStatusOf(id)).toBe("REJECTED");
			expect(await proposalStatusOf(seeded.staleId)).toBe("PENDING");
			expect(await rebasedAudits(seeded.staleId)).toHaveLength(0);
		});

		it("closes the stale proposal with its audit row when the rebase is READY, once", async () => {
			const seeded = await seedStaleProposal("ready");
			const id = await rebasedId(seeded);

			expect(await ready(id)).toEqual({ changed: true });
			expect(await ready(id)).toEqual({ changed: false });

			const stale = await db.projectInstructionSnapshot.findUniqueOrThrow(
				{
					where: { id: seeded.staleId },
					select: { proposalStatus: true, reviewedAt: true },
				},
			);
			expect(stale.proposalStatus).toBe("REJECTED");
			expect(stale.reviewedAt).not.toBeNull();
			expect(await proposalStatusOf(id)).toBe("PENDING");
			const audits = await rebasedAudits(seeded.staleId);
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				actorType: "user",
				resourceType: "project_instruction_snapshot",
				resourceName: "v2",
				metadata: expect.objectContaining({
					rebasedSnapshotId: id,
					toBaseVersion: 3,
				}),
			});
		});

		it("still makes the rebase READY when the stale proposal was canceled meanwhile", async () => {
			const seeded = await seedStaleProposal("canceled");
			const id = await rebasedId(seeded);
			const canceled = await cancelInstructionProposal({
				snapshotId: seeded.staleId,
				projectId,
				organizationId: ORGANIZATION_ID,
				proposerUserId: PROPOSER_ID,
				audit: {
					action: "project.instructions.rejected",
					category: "project",
					actor: { type: "user", userId: PROPOSER_ID },
					organizationId: ORGANIZATION_ID,
					projectId,
					resource: {
						type: "project_instruction_snapshot",
						id: seeded.staleId,
					},
				},
			});
			expect(canceled).toMatchObject({ ok: true });

			expect(await ready(id)).toEqual({ changed: true });

			expect(await rebasedAudits(seeded.staleId)).toHaveLength(0);
		});
	},
);
