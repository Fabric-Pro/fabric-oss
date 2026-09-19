import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	approveInstructionProposal,
	cancelInstructionProposal,
	createDerivedInstructionSnapshot,
	db,
	MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER,
	type RecordAuditInput,
	rejectInstructionProposal,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `instruction-proposal-org-${RUN_ID}`;
const PROPOSER_ID = `instruction-proposal-author-${RUN_ID}`;
const REVIEWER_ID = `instruction-proposal-reviewer-${RUN_ID}`;
let projectId = "";

function audit(
	action: "project.instructions.published" | "project.instructions.rejected",
	snapshotId: string,
): RecordAuditInput {
	return {
		action,
		category: "project",
		actor: { type: "user", userId: REVIEWER_ID },
		organizationId: ORGANIZATION_ID,
		projectId,
		resource: { type: "project_instruction_snapshot", id: snapshotId },
		metadata: { source: "file_proposal_review" },
	};
}

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

async function seedBase(testName: string) {
	const baseId = `${testName}-base-${RUN_ID}`;
	await createSnapshot({ id: baseId, version: 1 });
	await db.project.update({
		where: { id: projectId },
		data: { publishedInstructionSnapshotId: baseId },
	});
	return baseId;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"instruction proposal decisions (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.createMany({
				data: [
					{
						id: PROPOSER_ID,
						name: "Proposal Author",
						email: `${PROPOSER_ID}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
					{
						id: REVIEWER_ID,
						name: "Proposal Reviewer",
						email: `${REVIEWER_ID}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				],
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Instruction Proposal Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Instruction Proposal Integration",
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
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({
				where: { id: { in: [PROPOSER_ID, REVIEWER_ID] } },
			});
			await db.$disconnect();
		});

		it("commits exactly one concurrent approve-or-reject decision", async () => {
			const baseId = await seedBase("decision-race");
			const proposalId = `decision-race-proposal-${RUN_ID}`;
			await createSnapshot({
				id: proposalId,
				version: 2,
				proposalStatus: "PENDING",
				baseSnapshotId: baseId,
			});

			const [approved, rejected] = await Promise.all([
				approveInstructionProposal({
					snapshotId: proposalId,
					projectId,
					organizationId: ORGANIZATION_ID,
					reviewerUserId: REVIEWER_ID,
					audit: audit("project.instructions.published", proposalId),
				}),
				rejectInstructionProposal({
					snapshotId: proposalId,
					projectId,
					organizationId: ORGANIZATION_ID,
					reviewerUserId: REVIEWER_ID,
					audit: audit("project.instructions.rejected", proposalId),
				}),
			]);

			const changed = [approved, rejected].filter(
				(result) => result.ok && result.changed,
			);
			expect(changed).toHaveLength(1);
			const proposal =
				await db.projectInstructionSnapshot.findUniqueOrThrow({
					where: { id: proposalId },
					select: { proposalStatus: true },
				});
			const project = await db.project.findUniqueOrThrow({
				where: { id: projectId },
				select: { publishedInstructionSnapshotId: true },
			});
			expect(project.publishedInstructionSnapshotId).toBe(
				proposal.proposalStatus === "APPROVED" ? proposalId : baseId,
			);
			expect(
				await db.auditLog.count({
					where: {
						resourceId: proposalId,
						action: {
							in: [
								"project.instructions.published",
								"project.instructions.rejected",
							],
						},
					},
				}),
			).toBe(1);
		});

		it("serializes concurrent proposal admission at the per-proposer cap", async () => {
			const baseId = await seedBase("admission-race");
			const basePrefix = `projects/${projectId}/instructions/snapshots/${baseId}/`;
			await db.projectInstructionFile.createMany({
				data: ["CLAUDE.md", "REMOVE.md"].map((path, index) => ({
					snapshotId: baseId,
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
				})),
			});

			const results = await Promise.all(
				Array.from(
					{
						length:
							MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER + 1,
					},
					() =>
						createDerivedInstructionSnapshot({
							projectId,
							organizationId: ORGANIZATION_ID,
							userId: PROPOSER_ID,
							baseSnapshotId: baseId,
							publishOnReady: false,
							proposal: true,
							changes: [{ op: "delete", path: "REMOVE.md" }],
							limits: {
								maxFiles: 5_000,
								maxTotalBytes: 52_428_800,
							},
							baseKeyPrefix: basePrefix,
						}),
				),
			);

			expect(results.filter((result) => result.ok)).toHaveLength(
				MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER,
			);
			expect(results.filter((result) => !result.ok)).toEqual([
				{ ok: false, reason: "proposal_proposer_limit" },
			]);
			expect(
				await db.projectInstructionSnapshot.count({
					where: {
						projectId,
						proposalStatus: "PENDING",
					},
				}),
			).toBe(MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER);
		});

		it("does not free proposal capacity when a receiving upload is canceled before cleanup", async () => {
			const baseId = await seedBase("cancel-capacity");
			const basePrefix = `projects/${projectId}/instructions/snapshots/${baseId}/`;
			await db.projectInstructionFile.createMany({
				data: ["CLAUDE.md", "README.md"].map((path, index) => ({
					snapshotId: baseId,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: PROPOSER_ID,
					path,
					kind: "INSTRUCTIONS",
					storageKey: `${basePrefix}base-file-${index}`,
					sha256: String(index).repeat(64),
					size: 10,
					mimeType: "text/markdown",
					isText: true,
				})),
			});
			const create = () =>
				createDerivedInstructionSnapshot({
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: PROPOSER_ID,
					baseSnapshotId: baseId,
					publishOnReady: false,
					proposal: true,
					changes: [{ op: "delete", path: "CLAUDE.md" }],
					limits: { maxFiles: 5_000, maxTotalBytes: 52_428_800 },
					baseKeyPrefix: basePrefix,
				});
			const created = [];
			for (
				let index = 0;
				index < MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER;
				index++
			) {
				created.push(await create());
			}
			const first = created[0];
			expect(first?.ok).toBe(true);
			if (!first?.ok) throw new Error("expected proposal");
			await cancelInstructionProposal({
				snapshotId: first.id,
				projectId,
				organizationId: ORGANIZATION_ID,
				proposerUserId: PROPOSER_ID,
				audit: audit("project.instructions.rejected", first.id),
			});

			await expect(create()).resolves.toEqual({
				ok: false,
				reason: "proposal_proposer_limit",
			});
		});

		it("publishes only one of two concurrent proposals from the same base", async () => {
			const baseId = await seedBase("approval-race");
			const proposalIds = [
				`approval-race-a-${RUN_ID}`,
				`approval-race-b-${RUN_ID}`,
			] as const;
			await createSnapshot({
				id: proposalIds[0],
				version: 2,
				proposalStatus: "PENDING",
				baseSnapshotId: baseId,
			});
			await createSnapshot({
				id: proposalIds[1],
				version: 3,
				proposalStatus: "PENDING",
				baseSnapshotId: baseId,
			});

			const results = await Promise.all(
				proposalIds.map((snapshotId) =>
					approveInstructionProposal({
						snapshotId,
						projectId,
						organizationId: ORGANIZATION_ID,
						reviewerUserId: REVIEWER_ID,
						audit: audit(
							"project.instructions.published",
							snapshotId,
						),
					}),
				),
			);

			expect(
				results.filter((result) => result.ok && result.changed),
			).toHaveLength(1);
			expect(
				results.filter(
					(result) => !result.ok && result.reason === "stale",
				),
			).toHaveLength(1);
			const snapshots = await db.projectInstructionSnapshot.findMany({
				where: { id: { in: [...proposalIds] } },
				select: { id: true, proposalStatus: true },
			});
			expect(
				snapshots.filter(
					(snapshot) => snapshot.proposalStatus === "APPROVED",
				),
			).toHaveLength(1);
			expect(
				snapshots.filter(
					(snapshot) => snapshot.proposalStatus === "PENDING",
				),
			).toHaveLength(1);
			const project = await db.project.findUniqueOrThrow({
				where: { id: projectId },
				select: { publishedInstructionSnapshotId: true },
			});
			expect(
				snapshots.find(
					(snapshot) => snapshot.proposalStatus === "APPROVED",
				)?.id,
			).toBe(project.publishedInstructionSnapshotId);
		});

		it("keeps an approved retry idempotent with one publication audit", async () => {
			const baseId = await seedBase("approval-retry");
			const proposalId = `approval-retry-proposal-${RUN_ID}`;
			await createSnapshot({
				id: proposalId,
				version: 2,
				proposalStatus: "PENDING",
				baseSnapshotId: baseId,
			});
			const input = {
				snapshotId: proposalId,
				projectId,
				organizationId: ORGANIZATION_ID,
				reviewerUserId: REVIEWER_ID,
				audit: audit("project.instructions.published", proposalId),
			};

			await expect(approveInstructionProposal(input)).resolves.toEqual({
				ok: true,
				changed: true,
				version: 2,
			});
			await expect(approveInstructionProposal(input)).resolves.toEqual({
				ok: true,
				changed: false,
				version: 2,
			});
			expect(
				await db.auditLog.count({
					where: {
						resourceId: proposalId,
						action: "project.instructions.published",
					},
				}),
			).toBe(1);
		});
	},
);
