/** Real row locks, receipts, immutable publications and restricted-role isolation. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { preserveLegacyFramePublication } from "../prisma/queries/frame-approved-revisions";
import {
	applyFrameChange,
	approveFrameRevision,
	dismissFrameChange,
	getFrameReviewState,
	listFrameChanges,
	proposeFrameChange,
} from "../prisma/queries/frame-reviews";
import { revokeFrameSharing, shareFrame } from "../prisma/queries/frame-share";
import {
	createFrame,
	getFrameById,
	getFrameByShareToken,
	updateFrame,
} from "../prisma/queries/frames";
import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

const suffix = randomUUID();
const actor = {
	userId: `example-review-user-${suffix}`,
	organizationId: `example-review-org-${suffix}`,
};
const other = `example-other-user-${suffix}`;
const frames: string[] = [];
async function page(isPublic = false) {
	const f = await createFrame({
		...actor,
		title: `Example review ${randomUUID()}`,
		blocks: [
			{
				id: "main",
				type: "markdown",
				content: "Original example content",
			},
		],
		isPublic,
	});
	frames.push(f.id);
	return f;
}
const propose = (
	id: string,
	expectedUpdatedAt: Date,
	title = "Proposed example",
) =>
	proposeFrameChange(actor, id, {
		requestId: randomUUID(),
		expectedUpdatedAt: expectedUpdatedAt.toISOString(),
		edit: { title },
	});
describe.skipIf(process.env.RUN_FRAME_REVIEW_INTEGRATION !== "1")(
	"reviewed Frames against PostgreSQL",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.createMany({
				data: [actor.userId, other].map((id) => ({
					id,
					name: "Example review user",
					email: `${id}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				})),
			});
			await db.organization.create({
				data: {
					id: actor.organizationId,
					name: "Example review test",
					slug: actor.organizationId,
					createdAt: now,
					canShareFramesPublicly: true,
				},
			});
			await db.member.createMany({
				data: [
					{
						id: randomUUID(),
						...actor,
						role: "owner",
						createdAt: now,
					},
					{
						id: randomUUID(),
						organizationId: actor.organizationId,
						userId: other,
						role: "member",
						createdAt: now,
					},
				],
			});
			await ensureRlsTestRole();
		});
		afterAll(async () => {
			await db.agentWorkspaceFile.deleteMany({
				where: {
					id: { in: frames },
					organizationId: actor.organizationId,
				},
			});
			await db.project.deleteMany({
				where: { organizationId: actor.organizationId },
			});
			await db.organization.deleteMany({
				where: { id: actor.organizationId },
			});
			await db.user.deleteMany({
				where: { id: { in: [actor.userId, other] } },
			});
			await db.$disconnect();
		});
		it("proposes without mutation, replays a UUID, and refuses changed reuse", async () => {
			const f = await page();
			const input = {
				requestId: randomUUID(),
				expectedUpdatedAt: f.updatedAt.toISOString(),
				edit: { title: "Example changed" },
			};
			const p = await proposeFrameChange(actor, f.id, input);
			expect((await getFrameById({ ...actor, id: f.id }))?.title).toBe(
				f.title,
			);
			expect((await proposeFrameChange(actor, f.id, input)).id).toBe(
				p.id,
			);
			await expect(
				proposeFrameChange(actor, f.id, {
					...input,
					edit: { title: "Different" },
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});
		it("applies exactly once under concurrent requests, with one history row", async () => {
			const f = await page();
			const p = await propose(f.id, f.updatedAt);
			const body = {
				proposalId: p.id,
				expectedProposalHash: p.proposedContentHash,
			};
			const [a, b] = await Promise.all([
				applyFrameChange(actor, f.id, body),
				applyFrameChange(actor, f.id, body),
			]);
			expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
			expect(
				await db.frameEditHistory.count({ where: { frameId: f.id } }),
			).toBe(1);
			expect((await getFrameById({ ...actor, id: f.id }))?.title).toBe(
				"Proposed example",
			);
		});
		it("preserves a stale proposal and refuses a stale or tampered apply", async () => {
			const f = await page();
			const p = await propose(f.id, f.updatedAt);
			await updateFrame({
				...actor,
				id: f.id,
				expectedUpdatedAt: f.updatedAt,
				title: "Concurrent example",
			});
			await expect(
				applyFrameChange(actor, f.id, {
					proposalId: p.id,
					expectedProposalHash: p.proposedContentHash,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(
				applyFrameChange(actor, f.id, {
					proposalId: p.id,
					expectedProposalHash: "0".repeat(64),
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(
				(await listFrameChanges(actor, f.id)).proposals[0],
			).toMatchObject({ id: p.id, status: "PENDING", conflicted: true });
		});
		it("dismissal is durable and cannot be applied later", async () => {
			const f = await page();
			const p = await propose(f.id, f.updatedAt);
			await dismissFrameChange(actor, f.id, { proposalId: p.id });
			await dismissFrameChange(actor, f.id, { proposalId: p.id });
			await expect(
				applyFrameChange(actor, f.id, {
					proposalId: p.id,
					expectedProposalHash: p.proposedContentHash,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect((await getFrameById({ ...actor, id: f.id }))?.title).toBe(
				f.title,
			);
		});
		it("approves an exact private revision without publishing it", async () => {
			const f = await page();
			const state = await getFrameReviewState(actor, f.id);
			const approved = await approveFrameRevision(actor, f.id, {
				expectedUpdatedAt: state.currentUpdatedAt,
				expectedContentHash: state.currentContentHash,
			});
			expect(approved.hasUnapprovedChanges).toBe(false);
			expect(approved.published).toBeNull();
			expect((await getFrameById({ ...actor, id: f.id }))?.isPublic).toBe(
				false,
			);
			await expect(
				approveFrameRevision(actor, f.id, {
					expectedUpdatedAt: state.currentUpdatedAt,
					expectedContentHash: "0".repeat(64),
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});
		it("keeps the published version stable during later draft edits and revokes its link", async () => {
			const f = await page();
			const shared = await shareFrame({
				...actor,
				frameId: f.id,
				scope: "PUBLIC",
				expectedUpdatedAt: f.updatedAt,
			});
			if (!shared.ok) {
				throw new Error(shared.reason);
			}
			expect(shared.shareToken).toBeTruthy();
			const current = await getFrameById({ ...actor, id: f.id });
			await updateFrame({
				...actor,
				id: f.id,
				expectedUpdatedAt: current?.updatedAt,
				title: "Unpublished example draft",
			});
			const publicView = await getFrameByShareToken(shared.shareToken!);
			expect(publicView?.title).toBe(f.title);
			expect(publicView?.isPublishedSnapshot).toBe(true);
			expect(publicView?.document.metadata).toBeUndefined();
			const state = await getFrameReviewState(actor, f.id);
			expect(state.hasUnpublishedChanges).toBe(true);
			await revokeFrameSharing({
				...actor,
				frameId: f.id,
				mode: "public-link",
			});
			expect(await getFrameByShareToken(shared.shareToken!)).toBeNull();
		});
		it("pins legacy publication even through a generic workspace content update", async () => {
			const f = await page(true);
			await db.agentWorkspaceFile.update({
				where: { id: f.id },
				data: {
					content: JSON.stringify({
						...f.document,
						title: "Later generic draft",
					}),
				},
			});
			expect((await getFrameByShareToken(f.shareToken!))?.title).toBe(
				f.title,
			);
			const state = await getFrameReviewState(actor, f.id);
			expect(state.approved).toBeNull();
			expect(state.published?.origin).toBe("LEGACY_PUBLICATION");
		});
		it("supports older documents without metadata", async () => {
			const f = await page();
			const { metadata: _, ...legacy } = f.document;
			await db.agentWorkspaceFile.update({
				where: { id: f.id },
				data: { content: JSON.stringify(legacy) },
			});
			const current = await getFrameById({ ...actor, id: f.id });
			if (!current) throw new Error("Expected current example frame");
			const p = await propose(f.id, current.updatedAt);
			await applyFrameChange(actor, f.id, {
				proposalId: p.id,
				expectedProposalHash: p.proposedContentHash,
			});
			expect((await getFrameById({ ...actor, id: f.id }))?.title).toBe(
				"Proposed example",
			);
		});
		it("retains concurrent approval when legacy publication is pinned", async () => {
			const f = await page(true);
			const state = await getFrameReviewState(actor, f.id);
			const stale = await db.agentWorkspaceFile.findUniqueOrThrow({
				where: { id: f.id },
			});
			await approveFrameRevision(actor, f.id, {
				expectedUpdatedAt: state.currentUpdatedAt,
				expectedContentHash: state.currentContentHash,
			});
			await db.$transaction((tx) =>
				preserveLegacyFramePublication(tx, stale),
			);
			const result = await getFrameReviewState(actor, f.id);
			expect(result.approved).not.toBeNull();
			expect(result.published).not.toBeNull();
		});
		it("does not let another actor or tenant read a proposal", async () => {
			const f = await page();
			await propose(f.id, f.updatedAt);
			await expect(
				listFrameChanges({ ...actor, userId: other }, f.id),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				listFrameChanges(
					{ ...actor, organizationId: "example-other-org" },
					f.id,
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});
		it("enforces owner and tenant RLS and immutable SQL evidence", async () => {
			const f = await page();
			const p = await propose(f.id, f.updatedAt);
			const own = {
				type: "organization" as const,
				tenantId: actor.organizationId,
				userId: actor.userId,
			};
			expect(
				(
					await asRlsRole(own, (tx) =>
						tx.frameChangeProposal.findMany({
							where: { frameId: f.id },
						}),
					)
				).length,
			).toBe(1);
			expect(
				await asRlsRole({ ...own, userId: other }, (tx) =>
					tx.frameChangeProposal.count({ where: { frameId: f.id } }),
				),
			).toBe(0);
			expect(
				await asRlsRole(
					{ ...own, tenantId: "example-other-org" },
					(tx) =>
						tx.frameChangeProposal.count({
							where: { frameId: f.id },
						}),
				),
			).toBe(0);
			await expect(
				asRlsRole(own, (tx) =>
					tx.frameChangeProposal.update({
						where: { id: p.id },
						data: { proposedContent: "{}" },
					}),
				),
			).rejects.toThrow();
			await expect(
				asRlsRole(own, (tx) =>
					tx.frameChangeProposal.delete({ where: { id: p.id } }),
				),
			).rejects.toThrow();
		});
		it("rechecks current project write access for the Frame owner", async () => {
			const projectId = `example-review-project-${randomUUID()}`;
			await db.project.create({
				data: {
					id: projectId,
					...actor,
					name: "Example review project",
					techStack: [],
					features: [],
					tags: [],
				},
			});
			await db.projectMember.create({
				data: {
					projectId,
					userId: other,
					role: "EDITOR",
					invitedBy: actor.userId,
					acceptedAt: new Date(),
				},
			});
			const f = await createFrame({
				userId: other,
				organizationId: actor.organizationId,
				projectId,
				title: "Example restricted page",
				blocks: [{ id: "main", type: "markdown", content: "Example" }],
			});
			frames.push(f.id);
			const p = await proposeFrameChange(
				{ ...actor, userId: other },
				f.id,
				{
					requestId: randomUUID(),
					expectedUpdatedAt: f.updatedAt.toISOString(),
					edit: { title: "Example proposal" },
				},
			);
			await db.projectMember.deleteMany({
				where: { projectId, userId: other },
			});
			await expect(
				applyFrameChange({ ...actor, userId: other }, f.id, {
					proposalId: p.id,
					expectedProposalHash: p.proposedContentHash,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	},
);
