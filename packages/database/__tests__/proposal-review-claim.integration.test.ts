import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	claimPendingProposalWithReview,
	recordProposalApplication,
	recordProposalDuplicateResolution,
	returnFailedProposalToReview,
} from "../prisma/queries/projects/pending-backlog-proposals";

const enabled =
	process.env.RUN_DB_INTEGRATION === "1" && !!process.env.DATABASE_URL;
const userId = randomUUID();
const organizationId = randomUUID();
let projectId: string;

import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

describe.skipIf(!enabled)("proposal review transaction (real Postgres)", () => {
	beforeAll(async () => {
		await db.user.create({
			data: {
				id: userId,
				email: `${userId}@example.com`,
				name: "Example reviewer",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await db.organization.create({
			data: {
				id: organizationId,
				slug: organizationId,
				name: "Example organization",
				createdAt: new Date(),
			},
		});
		const project = await db.project.create({
			data: { name: "Example project", userId, organizationId },
		});
		projectId = project.id;
	});
	afterAll(async () => {
		if (projectId) {
			await db.project.delete({ where: { id: projectId } });
		}
		await db.organization.delete({ where: { id: organizationId } });
		await db.user.delete({ where: { id: userId } });
	});
	async function proposal() {
		return db.pendingBacklogProposal.create({
			data: {
				projectId,
				userId,
				organizationId,
				source: "SCOPE_DOCUMENT",
				summary: "Example proposal",
				proposal: {
					changes: [
						{
							action: "create",
							type: "feature",
							title: { to: "Example" },
						},
						{
							action: "create",
							type: "feature",
							title: { to: "Another example" },
						},
					],
				},
				changeCount: 2,
			},
		});
	}
	function claim(proposalId: string, attempt: string) {
		return claimPendingProposalWithReview({
			proposalId,
			reviewedBy: userId,
			applyWorkflowId: attempt,
			syncToPM: false,
			offeredListComplete: true,
			entries: [
				{
					offeredIndex: 0,
					changeIndex: 0,
					selected: true,
					change: {
						action: "update",
						type: "feature",
						title: { to: "Edited" },
					},
				},
				{ offeredIndex: 1, changeIndex: 1, selected: false },
			],
		});
	}
	it("idempotently records inline applications and separate duplicate resolutions", async () => {
		const row = await proposal();
		for (let i = 0; i < 2; i++) {
			await recordProposalApplication(
				db,
				{
					proposalId: row.id,
					changeIndex: 0,
					action: "create",
					createdEntityType: "story",
					createdEntityId: randomUUID(),
				},
				{ skipDuplicates: true },
			);
			await recordProposalDuplicateResolution({
				proposalId: row.id,
				changeIndex: 1,
				existingEntityType: "bug",
				existingEntityId: randomUUID(),
			});
		}
		expect(
			await db.pendingBacklogProposalApplication.findMany({
				where: { proposalId: row.id },
				select: { changeIndex: true },
			}),
		).toEqual([{ changeIndex: 0 }]);
		expect(
			await db.pendingBacklogProposalDuplicateResolution.count({
				where: { proposalId: row.id },
			}),
		).toBe(1);
		await db.pendingBacklogProposal.delete({ where: { id: row.id } });
		expect(
			await db.pendingBacklogProposalDuplicateResolution.count({
				where: { proposalId: row.id },
			}),
		).toBe(0);
	});
	it("enforces duplicate resolution RLS reads and writes with NOSUPERUSER NOBYPASSRLS", async () => {
		await ensureRlsTestRole();
		const row = await proposal();
		await recordProposalDuplicateResolution({
			proposalId: row.id,
			changeIndex: 0,
		});
		const own = {
			type: "organization" as const,
			tenantId: organizationId,
			userId,
		};
		const foreign = {
			type: "organization" as const,
			tenantId: randomUUID(),
			userId,
		};
		const count = (ctx: typeof own) =>
			asRlsRole(ctx, (tx) =>
				tx.pendingBacklogProposalDuplicateResolution.count({
					where: { proposalId: row.id },
				}),
			);
		expect(await count(own)).toBe(1);
		expect(await count(foreign)).toBe(0);
		await expect(
			asRlsRole(foreign, (tx) =>
				tx.pendingBacklogProposalDuplicateResolution.create({
					data: { proposalId: row.id, changeIndex: 2 },
				}),
			),
		).rejects.toThrow(/row-level security/);
		await asRlsRole(own, (tx) =>
			tx.pendingBacklogProposalDuplicateResolution.create({
				data: { proposalId: row.id, changeIndex: 2 },
			}),
		);
		expect(await count(own)).toBe(2);
		expect(
			await asRlsRole({ type: "none" }, (tx) =>
				tx.pendingBacklogProposalDuplicateResolution.count({
					where: { proposalId: row.id },
				}),
			),
		).toBe(0);
	});

	it("concurrent claims persist one review, bind it, and cascade on proposal deletion", async () => {
		const row = await proposal();
		const results = await Promise.all([
			claim(row.id, "example-first"),
			claim(row.id, "example-second"),
		]);
		expect(results.sort()).toEqual([false, true]);
		const reviews = await db.pendingBacklogProposalReview.findMany({
			where: { proposalId: row.id },
			include: { entries: true },
		});
		expect(reviews).toHaveLength(1);
		expect(reviews[0]?.entries).toHaveLength(2);
		const bound = await db.pendingBacklogProposal.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(bound.applyReviewId).toBe(reviews[0]?.id);
		expect(bound.applyReviewWorkflowId).toBe(bound.applyWorkflowId);
		await db.pendingBacklogProposal.delete({ where: { id: row.id } });
		expect(
			await db.pendingBacklogProposalReview.count({
				where: { proposalId: row.id },
			}),
		).toBe(0);
		expect(
			await db.pendingBacklogProposalReviewEntry.count({
				where: { proposalId: row.id },
			}),
		).toBe(0);
	});
	it("entry insertion failure rolls the claim and review back", async () => {
		const row = await proposal();
		await expect(
			claimPendingProposalWithReview({
				proposalId: row.id,
				reviewedBy: userId,
				applyWorkflowId: "example-invalid",
				syncToPM: false,
				offeredListComplete: true,
				entries: [
					{ offeredIndex: 0, changeIndex: 0, selected: false },
					{ offeredIndex: 0, changeIndex: 1, selected: false },
				],
			}),
		).rejects.toMatchObject({ code: "P2002" });
		expect(
			await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: row.id },
			}),
		).toMatchObject({
			status: "PENDING",
			applyWorkflowId: null,
			applyReviewId: null,
		});
		expect(
			await db.pendingBacklogProposalReview.count({
				where: { proposalId: row.id },
			}),
		).toBe(0);
	});
	it("return to review clears failure and binding fields and refuses a stale attempt", async () => {
		const row = await proposal();
		await claim(row.id, "example-old");
		await db.pendingBacklogProposal.update({
			where: { id: row.id },
			data: {
				status: "FAILED",
				errorClass: "ExampleError",
				errorMessage: "Example failure",
				failedAt: new Date(),
			},
		});
		const failed = await db.pendingBacklogProposal.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(
			await returnFailedProposalToReview(row.id, {
				applyWorkflowId: "example-stale",
				applyReviewId: failed.applyReviewId,
			}),
		).toBe(false);
		expect(
			await returnFailedProposalToReview(row.id, {
				applyWorkflowId: failed.applyWorkflowId,
				applyReviewId: failed.applyReviewId,
			}),
		).toBe(true);
		expect(
			await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: row.id },
			}),
		).toMatchObject({
			status: "PENDING",
			applyWorkflowId: null,
			applyReviewId: null,
			applyReviewWorkflowId: null,
			applyStartedAt: null,
			applyError: null,
			errorClass: null,
			errorMessage: null,
			failedAt: null,
		});
	});
	it("deleting a review cascades entries and unbinds the proposal", async () => {
		const row = await proposal();
		await claim(row.id, "example-delete-review");
		const bound = await db.pendingBacklogProposal.findUniqueOrThrow({
			where: { id: row.id },
		});
		await db.pendingBacklogProposalReview.delete({
			where: { id: bound.applyReviewId! },
		});
		expect(
			await db.pendingBacklogProposalReviewEntry.count({
				where: { proposalId: row.id },
			}),
		).toBe(0);
		expect(
			await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: row.id },
			}),
		).toMatchObject({ applyReviewId: null });
	});
	it("claims the full 10000-entry offered list in one transaction", async () => {
		const row = await proposal();
		const changes = Array.from({ length: 10000 }, (_, i) => ({
			action: "create",
			type: "feature",
			title: { to: `Example ${i}` },
		}));
		await db.pendingBacklogProposal.update({
			where: { id: row.id },
			data: { proposal: { changes }, changeCount: changes.length },
		});
		await db.organizationFeatureFlagOverride.create({
			data: {
				key: "DECISION_REPLAY",
				organizationId,
				enabled: true,
				updatedBy: userId,
			},
		});
		const started = performance.now();
		expect(
			await claimPendingProposalWithReview({
				proposalId: row.id,
				reviewedBy: userId,
				applyWorkflowId: "example-cap-attempt",
				offeredListComplete: true,
				syncToPM: false,
				entries: changes.map((change, offeredIndex) => ({
					offeredIndex,
					changeIndex: offeredIndex,
					selected: true,
					change,
				})),
			}),
		).toBe(true);
		const durationMs = performance.now() - started;
		const [captured] = await db.$queryRaw<
			{ n: number }[]
		>`SELECT count(*)::int AS n FROM lakehouse_export.decision_event WHERE related_subject_id=${row.id} AND event_type='change_reviewed'`;
		expect(captured?.n).toBe(10000);

		console.info(
			`Review claim at cap: 10000 entries in ${durationMs.toFixed(1)} ms`,
		);
		const review = await db.pendingBacklogProposalReview.findFirstOrThrow({
			where: { proposalId: row.id },
			include: { _count: { select: { entries: true } } },
		});
		expect(review).toMatchObject({
			offeredCount: 10000,
			selectedCount: 10000,
			offeredListComplete: true,
			_count: { entries: 10000 },
		});
	}, 15000);
});
