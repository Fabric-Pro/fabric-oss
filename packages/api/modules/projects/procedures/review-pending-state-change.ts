import { ORPCError } from "@orpc/client";
import {
	applyPmUnlinkTx,
	applyTerminalClose,
	applyTerminalUnhide,
	db,
	enforceStageTransition,
	hasProjectAccess,
	recordAudit,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { mapStageTransitionError } from "../lib/stage-transition-errors";

/**
 * Governed projects (plan §F1): closing a story is a drafting-stage
 * transition like any other, so when the project has configured stage
 * approvers the closure is recorded as a StageTransitionRequest and the
 * story is left unchanged. Returns the request id in that case; `undefined`
 * means the caller may close the story directly (`applyTerminalClose`).
 *
 * Only stories go through this: legacy EPIC/FEATURE pending rows are
 * no-ops in fabric-dev (the folder tables were dropped).
 */
async function requestStageClosureIfGoverned(
	entityType: string,
	entityId: string,
	projectId: string,
	userId: string,
	organizationId: string | undefined | null,
): Promise<string | undefined> {
	if (entityType !== "STORY") {
		return undefined;
	}
	const story = await db.userStory.findUnique({
		where: { id: entityId, projectId },
		select: { id: true, draftingStage: true },
	});
	if (!story || story.draftingStage === "CLOSED") {
		return undefined;
	}
	const decision = await enforceStageTransition(db, {
		storyId: story.id,
		projectId,
		toStage: "CLOSED",
		reason: "system",
		actor: { userId, organizationId: organizationId ?? null },
	});
	return decision.mode === "request" ? decision.requestId : undefined;
}

export const reviewPendingStateChangeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/pending-state-changes/{id}/review",
		tags: ["Projects", "PM Sync"],
		summary: "Review a pending PM state change",
		description:
			"Approve or dismiss a single pending ADO state change proposal",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
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

		const change = await db.pendingPmStateChange.findUnique({
			where: { id: input.id },
		});

		if (!change) {
			throw new ORPCError("NOT_FOUND", {
				message: "Pending state change not found",
			});
		}

		if (change.projectId !== input.projectId) {
			throw new ORPCError("FORBIDDEN", {
				message: "State change does not belong to this project",
			});
		}

		if (change.status !== "PENDING") {
			throw new ORPCError("CONFLICT", {
				message: "State change has already been reviewed",
			});
		}

		let pendingStageRequestId: string | undefined;
		if (input.decision === "APPROVED" && change.proposedAction === "HIDE") {
			try {
				// Governed review first (plan §F1): a project with configured
				// stage approvers records the closure as a request and leaves
				// the story unchanged; the pending change is still marked
				// APPROVED below so it is not re-proposed.
				pendingStageRequestId = await requestStageClosureIfGoverned(
					change.entityType,
					change.entityId,
					input.projectId,
					user.id,
					organizationId,
				);
				if (!pendingStageRequestId) {
					const { applied } = await applyTerminalClose({
						entityType: change.entityType,
						entityId: change.entityId,
						projectId: input.projectId,
						userId: user.id,
						lastEditedByName: user.name ?? null,
						organizationId: organizationId ?? null,
						changeDescription:
							"ADO state sync: item moved to terminal state",
						// Set the UNHIDE provenance marker for epic/feature: they have no
						// auto-hide poll path, so a single-row Accept-HIDE is the only
						// PM-driven close. Without it, an epic/feature hidden via the
						// single-row UI could never produce a later UNHIDE proposal. STORY
						// stays false — a human Accept is intentional, not auto-hidden, and
						// the STORY auto-hide poll path owns that marker.
						markAutoHidden:
							change.entityType === "EPIC" ||
							change.entityType === "FEATURE",
					});

					// If the entity is missing, already CLOSED, or the guard lost a
					// concurrent race (applyTerminalClose's { applied } no-op contract),
					// dismiss the row instead of recording a phantom APPROVED — mirrors
					// the UNHIDE handling below.
					if (!applied) {
						const dismissed = await db.pendingPmStateChange.update({
							where: { id: input.id },
							data: {
								status: "DISMISSED",
								reviewedAt: new Date(),
								reviewedBy: user.id,
							},
						});
						return { change: dismissed };
					}
				}
			} catch (error: any) {
				// If the entity was already deleted, auto-dismiss instead of throwing
				// P2025 comes from a direct Prisma update; "Story not found" comes
				// from the stage choke point when the story vanished between the
				// lookup and the transition (plan §F1).
				const isNotFound =
					error?.code === "P2025" ||
					error?.message?.includes("Record to update not found") ||
					/^Story not found/i.test(String(error?.message ?? ""));
				if (isNotFound) {
					const dismissed = await db.pendingPmStateChange.update({
						where: { id: input.id },
						data: {
							status: "DISMISSED",
							reviewedAt: new Date(),
							reviewedBy: user.id,
						},
					});
					return { change: dismissed, pendingStageRequest: null };
				}
				throw mapStageTransitionError(error);
			}
		}

		if (
			input.decision === "APPROVED" &&
			change.proposedAction === "UNHIDE"
		) {
			try {
				const { applied } = await applyTerminalUnhide({
					entityType: change.entityType,
					entityId: change.entityId,
					projectId: input.projectId,
					userId: user.id,
					lastEditedByName: user.name ?? null,
					organizationId: organizationId ?? null,
					changeDescription:
						"PM state sync: ticket reopened — story unhidden",
				});

				// If the story is missing or the idempotency guard fired (story
				// already unhidden), dismiss the row instead of recording a no-op
				// as APPROVED.
				if (!applied) {
					const dismissed = await db.pendingPmStateChange.update({
						where: { id: input.id },
						data: {
							status: "DISMISSED",
							reviewedAt: new Date(),
							reviewedBy: user.id,
						},
					});
					return { change: dismissed };
				}
			} catch (error: any) {
				const isNotFound =
					error?.code === "P2025" ||
					error?.message?.includes("Record to update not found");
				if (isNotFound) {
					const dismissed = await db.pendingPmStateChange.update({
						where: { id: input.id },
						data: {
							status: "DISMISSED",
							reviewedAt: new Date(),
							reviewedBy: user.id,
						},
					});
					return { change: dismissed };
				}
				throw error;
			}
		}

		if (
			input.decision === "APPROVED" &&
			change.proposedAction === "FLAG_MISSING"
		) {
			const outcome = await db.$transaction(async (tx) => {
				// Atomically claim the PENDING row — the authoritative gate.
				// Compare-and-swap on the reviewer's snapshot (Codex plan-R2):
				// externalId + expectedExternalMcpServerId pin the row to the exact
				// proposal the reviewer saw, so if the poll REFRESHED this same row
				// id to a different missing ticket (upsertPendingChange's in-place
				// update) between the read and now, count === 0 → "gone" (never
				// DISMISSED, so the refreshed proposal survives).
				const consumed = await tx.pendingPmStateChange.updateMany({
					where: {
						id: input.id,
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
					return "gone" as const;
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
						where: { id: input.id },
						data: { status: "DISMISSED" },
					});
					return "not_applied" as const;
				}
				return "applied" as const;
			});

			if (outcome === "gone") {
				throw new ORPCError("CONFLICT", {
					message:
						"This proposal is no longer pending — the ticket may have reappeared.",
				});
			}

			if (outcome === "applied") {
				recordAudit({
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
			}

			// Row state already finalized inside the transaction (APPROVED or
			// DISMISSED). Return it without falling through to the generic update.
			// `finalRow` is effectively non-null here: the consume set the row's
			// status to APPROVED/DISMISSED inside the tx, so a concurrent
			// auto-dismiss CAS (which requires status=PENDING) can no longer match
			// it — the nullable type is only a TOCTOU formality.
			const finalRow = await db.pendingPmStateChange.findUnique({
				where: { id: input.id },
			});
			return { change: finalRow };
		}

		const updated = await db.pendingPmStateChange.update({
			where: { id: input.id },
			data: {
				status: input.decision,
				reviewedAt: new Date(),
				reviewedBy: user.id,
			},
		});

		return {
			change: updated,
			pendingStageRequest: pendingStageRequestId
				? { id: pendingStageRequestId }
				: null,
		};
	});
