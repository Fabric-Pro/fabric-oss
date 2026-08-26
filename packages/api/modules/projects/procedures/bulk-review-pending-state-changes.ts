import { ORPCError } from "@orpc/client";
import {
	applyPmUnlinkTx,
	db,
	hasProjectAccess,
	recordAuditTx,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

async function applyHideInTransaction(
	tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
	entityType: string,
	entityId: string,
	projectId: string,
	userId: string,
	userName: string | null,
	organizationId: string | undefined | null,
) {
	const now = new Date();

	// Stories are the only work-item rows — legacy EPIC/FEATURE pending rows
	// are no-ops (the folder tables were dropped).
	if (entityType !== "STORY") {
		return;
	}

	const story = await tx.userStory.findUnique({
		where: { id: entityId, projectId },
		select: {
			id: true,
			version: true,
			description: true,
			acceptanceCriteria: true,
			draftingStage: true,
		},
	});

	if (!story) {
		return;
	}
	if (story.draftingStage === "CLOSED") {
		return;
	}

	const currentVersion = story.version ?? 1;
	const newVersion = currentVersion + 1;

	await tx.featureVersion.upsert({
		where: {
			storyId_version: {
				storyId: story.id,
				version: newVersion,
			},
		},
		create: {
			storyId: story.id,
			version: newVersion,
			description: story.description ?? null,
			acceptanceCriteria: story.acceptanceCriteria ?? null,
			draftingStage: "CLOSED",
			changeDescription: "ADO state sync: item moved to terminal state",
			changedBy: userId,
			userId,
			organizationId: organizationId ?? null,
		},
		update: {},
	});

	await tx.userStory.update({
		where: { id: entityId, projectId },
		data: {
			draftingStage: "CLOSED",
			draftingStageUpdatedAt: now,
			version: newVersion,
			lastEditedAt: now,
			lastEditedByName: userName,
			lastEditedSource: "PM_PULL",
			// Clear the auto-hide marker: a user-approved HIDE is intentional,
			// not auto-hidden, so the UNHIDE provenance is reset (#1360 D1 matrix).
			pmAutoHidden: false,
		},
	});
}

async function applyUnhideInTransaction(
	tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
	entityType: string,
	entityId: string,
	projectId: string,
	userId: string,
	userName: string | null,
	organizationId: string | undefined | null,
): Promise<{ applied: boolean }> {
	// UNHIDE reverses a PM-driven close (#1360). STORY restores draftingStage=DRAFT,
	// bumps version, clears pmAutoHidden/pmTicketTerminal/pmTicketTerminalStatus.
	// Legacy EPIC/FEATURE pending rows are no-ops (the folder tables were dropped).
	const now = new Date();

	if (entityType !== "STORY") {
		return { applied: false };
	}

	const story = await tx.userStory.findUnique({
		where: { id: entityId, projectId },
		select: {
			id: true,
			version: true,
			description: true,
			acceptanceCriteria: true,
			draftingStage: true,
			pmTicketTerminal: true,
			pmAutoHidden: true,
		},
	});

	if (!story) {
		return { applied: false };
	}
	if (story.draftingStage === "DRAFT" && !story.pmTicketTerminal) {
		return { applied: false };
	}

	// Idempotency guard: only reverse an auto-hide if the story is still in
	// the state the auto-hide produced (CLOSED + pmAutoHidden:true). A stale
	// PENDING UNHIDE row approved after the story was already manually re-opened
	// must not double-apply (bogus version history).
	if (story.draftingStage !== "CLOSED" || story.pmAutoHidden !== true) {
		return { applied: false };
	}

	const currentVersion = story.version ?? 1;
	const newVersion = currentVersion + 1;

	await tx.featureVersion.upsert({
		where: {
			storyId_version: {
				storyId: story.id,
				version: newVersion,
			},
		},
		create: {
			storyId: story.id,
			version: newVersion,
			description: story.description ?? null,
			acceptanceCriteria: story.acceptanceCriteria ?? null,
			draftingStage: "DRAFT",
			changeDescription:
				"PM state sync: ticket reopened — story unhidden",
			changedBy: userId,
			userId,
			organizationId: organizationId ?? null,
		},
		update: {},
	});

	await tx.userStory.update({
		where: { id: entityId, projectId },
		data: {
			draftingStage: "DRAFT",
			draftingStageUpdatedAt: now,
			version: newVersion,
			lastEditedAt: now,
			lastEditedByName: userName,
			lastEditedSource: "PM_PULL",
			pmAutoHidden: false,
			pmTicketTerminal: false,
			pmTicketTerminalStatus: null,
		},
	});

	return { applied: true };
}

export const bulkReviewPendingStateChangesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pending-state-changes/bulk-review",
		tags: ["Projects", "PM Sync"],
		summary: "Bulk review pending PM state changes",
		description:
			"Approve or dismiss multiple pending ADO state change proposals in a transaction",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			ids: z.array(z.string()).min(1).max(100),
			decision: z.enum(["APPROVED", "DISMISSED"]),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const reviewed = await db.$transaction(async (tx) => {
			const changes = await tx.pendingPmStateChange.findMany({
				where: {
					id: { in: input.ids },
					projectId: input.projectId,
					status: "PENDING",
				},
			});

			// CONTENT_DRIFT carries four outcomes + a heavy per-item ADO ingest
			// (re-fetch + version bump + push) that does not fit the all-or-nothing
			// bulk approve/dismiss shape. Refuse loudly so a bulk
			// "Approve all" never silently runs ADO ingests — single-row
			// resolution via `resolveContentDrift` is the only Chunk C path.
			if (changes.some((c) => c.proposedAction === "CONTENT_DRIFT")) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Content-drift items cannot be bulk-reviewed; resolve each one individually.",
				});
			}

			for (const change of changes) {
				if (
					input.decision === "APPROVED" &&
					change.proposedAction === "HIDE"
				) {
					await applyHideInTransaction(
						tx,
						change.entityType,
						change.entityId,
						input.projectId,
						user.id,
						user.name ?? null,
						organizationId,
					);
				} else if (
					input.decision === "APPROVED" &&
					change.proposedAction === "UNHIDE"
				) {
					const { applied } = await applyUnhideInTransaction(
						tx,
						change.entityType,
						change.entityId,
						input.projectId,
						user.id,
						user.name ?? null,
						organizationId,
					);

					// If the story was missing or already unhidden (idempotency guard),
					// dismiss the row instead of recording a no-op as APPROVED.
					if (!applied) {
						await tx.pendingPmStateChange.update({
							where: { id: change.id },
							data: {
								status: "DISMISSED",
								reviewedAt: new Date(),
								reviewedBy: user.id,
							},
						});
						continue;
					}
				} else if (
					input.decision === "APPROVED" &&
					change.proposedAction === "FLAG_MISSING"
				) {
					// Atomically claim the PENDING row before unlinking (#1360),
					// compare-and-swap on the snapshot (externalId + server) so a
					// poll-refreshed row (different ticket, same id) yields count 0
					// and is skipped without DISMISSED-poisoning (Codex plan-R2).
					const consumed = await tx.pendingPmStateChange.updateMany({
						where: {
							id: change.id,
							status: "PENDING",
							proposedAction: "FLAG_MISSING",
							externalId: change.externalId,
							expectedExternalMcpServerId:
								change.expectedExternalMcpServerId,
						},
						data: {
							status: "APPROVED",
							reviewedAt: new Date(),
							reviewedBy: user.id,
						},
					});
					if (consumed.count !== 1) {
						continue; // auto-dismissed / refreshed / already done
					}

					const { applied } = await applyPmUnlinkTx(tx, {
						projectId: input.projectId,
						entityType: change.entityType,
						entityId: change.entityId,
						expectedExternalId: change.externalId,
						expectedExternalMcpServerId:
							change.expectedExternalMcpServerId,
					});
					if (!applied) {
						await tx.pendingPmStateChange.update({
							where: { id: change.id },
							data: { status: "DISMISSED" },
						});
						continue;
					}

					await recordAuditTx(tx, {
						action: "story.pm_ticket_unlinked",
						category: "story",
						actor: { type: "user", userId: user.id },
						organizationId: organizationId ?? null,
						projectId: input.projectId,
						resource: {
							type: change.entityType.toLowerCase(),
							id: change.entityId,
						},
						metadata: {
							externalId: change.externalId,
							entityType: change.entityType,
						},
					});
					continue; // status already APPROVED — skip the generic trailing update
				}

				await tx.pendingPmStateChange.update({
					where: { id: change.id },
					data: {
						status: input.decision,
						reviewedAt: new Date(),
						reviewedBy: user.id,
					},
				});
			}

			return changes.length;
		});

		return { reviewed };
	});
