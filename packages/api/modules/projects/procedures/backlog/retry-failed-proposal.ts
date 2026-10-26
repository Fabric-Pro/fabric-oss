// XOR-audited 2026-05-28 — organizationId+userId enforced on every query

import { ORPCError } from "@orpc/client";
import {
	buildBacklogDedupGuard,
	db,
	getAppliedChangeIndexes,
	getPendingBacklogProposal,
	getPendingProposalReview,
	inferDedupFamily,
	markProposalApplyDispatched,
	recordProposalDuplicateResolution,
	returnFailedProposalToReview,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { describeSyncErrorForUser } from "@repo/temporal/pm-sync-user-error";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isChannelMonitorSource } from "../../lib/channel-monitor-source";
import type { PmSyncOverride } from "./change-item-schema";

/**
 * Minimal shape of a stored proposal change. The stored JSON came from the
 * sidebar `applyChangesProcedure` input schema; we don't redeclare every
 * field here — only what the retry path reads.
 */
interface StoredChange {
	type: "epic" | "feature" | "story" | "bug";
	action: "create" | "update";
	title: { from?: string | null; to: string };
	kindOverride?: "BUG" | "FEATURE" | null;
	[key: string]: unknown;
}

interface StoredSourceMetadata {
	syncToPM?: boolean;
	pmConfig?: {
		mcpConfigId: string;
		containerId: string;
		additionalContext?: Record<string, string>;
	} | null;
	conversationId?: string | null;
	[key: string]: unknown;
}

/** Replay a bound review, or the approved-only payload of a legacy sidebar row.
 * Other legacy sources return to review. Claims are fenced to the attempt read.
 */
export const retryFailedProposalProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/proposals/{proposalId}/retry",
		tags: ["Projects", "Backlog"],
		summary: "Retry a failed backlog proposal",
		description:
			"Re-runs the backlog apply workflow for a FAILED proposal, skipping changes that the dedup guard maps to existing rows",
	})
	.input(
		z.object({
			projectId: z.string(),
			proposalId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			workflowId: z.string().nullable(),
			runId: z.string().optional(),
			dedupCollisionCount: z.number(),
			message: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// 1. Load proposal + verify scope.
		const proposal = await getPendingBacklogProposal(input.proposalId);
		if (!proposal) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal not found",
			});
		}
		if (proposal.projectId !== input.projectId) {
			throw new ORPCError("FORBIDDEN", {
				message: "Proposal does not belong to this project",
			});
		}
		// Tenant XOR — the proposal row carries the tenancy pair that
		// `applyChangesProcedure` resolved at write time. Compare BOTH the
		// organizationId AND the userId; never short-circuit on a single key.
		const resolvedOrgId = organizationId ?? null;
		const proposalOrgId = proposal.organizationId ?? null;
		if (proposalOrgId !== resolvedOrgId || proposal.userId !== user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "Proposal does not belong to this tenant",
			});
		}
		if (proposal.status !== "FAILED") {
			throw new ORPCError("CONFLICT", {
				message: `Proposal is in '${proposal.status}' state, not FAILED`,
			});
		}

		const boundReview =
			!!proposal.applyReviewId &&
			proposal.applyReviewWorkflowId === proposal.applyWorkflowId;
		const review =
			proposal.source !== "ROADMAP_RECOMMENDATION" && boundReview
				? await getPendingProposalReview(
						proposal.id,
						proposal.applyReviewId!,
					)
				: null;
		const retryWhere = {
			id: proposal.id,
			status: "FAILED" as const,
			applyWorkflowId: proposal.applyWorkflowId ?? null,
			applyReviewId: proposal.applyReviewId ?? null,
		};
		if (
			proposal.source === "ROADMAP_RECOMMENDATION" ||
			(!review &&
				(!!proposal.applyReviewId ||
					proposal.source !== "AI_UPDATE_SIDEBAR"))
		) {
			const returned = await returnFailedProposalToReview(proposal.id, {
				applyWorkflowId: proposal.applyWorkflowId ?? null,
				applyReviewId: proposal.applyReviewId ?? null,
			});
			if (!returned) {
				throw new ORPCError("CONFLICT", {
					message: "Proposal is no longer FAILED",
				});
			}
			return {
				workflowId: null,
				dedupCollisionCount: 0,
				message:
					proposal.source === "ROADMAP_RECOMMENDATION"
						? "Returned to review — select the features to accept again."
						: "Returned to review — select the changes to apply again.",
			};
		}

		// 2. Decode stored payload + metadata snapshot.
		const proposalPayload = proposal.proposal as {
			changes?: unknown;
		} | null;
		const storedChanges: StoredChange[] = Array.isArray(
			proposalPayload?.changes,
		)
			? (proposalPayload?.changes as StoredChange[])
			: [];
		if (!review && storedChanges.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Stored proposal has no changes to retry",
			});
		}
		const sourceMetadata = (proposal.sourceMetadata ??
			{}) as StoredSourceMetadata;
		const alreadyApplied = await getAppliedChangeIndexes(proposal.id);
		for (const index of proposal.appliedChangeIndexes ?? []) {
			alreadyApplied.add(index);
		}
		const replayEntries = review
			? review.entries
					.filter((entry) => entry.selected)
					.map((entry) => ({
						change: entry.change as unknown as StoredChange,
						index: entry.changeIndex,
						override: entry.pmSyncOverride as PmSyncOverride | null,
					}))
			: storedChanges.map((change, index) => ({
					change,
					index,
					override: null,
				}));
		const syncSettings = review
			? {
					syncToPM: review.syncToPM,
					pmConfig:
						review.pmConfig as StoredSourceMetadata["pmConfig"],
				}
			: sourceMetadata;
		const workflowOverrides: Record<number, PmSyncOverride> = {};

		// 3. Dedup guard pass on every remaining CREATE.
		const dedupGuard = await buildBacklogDedupGuard(input.projectId);
		const duplicateResolutions: Parameters<
			typeof recordProposalDuplicateResolution
		>[0][] = [];
		const recordDuplicates = async () => {
			for (const resolution of duplicateResolutions) {
				try {
					await recordProposalDuplicateResolution(resolution);
				} catch {
					console.warn(
						"Failed to record proposal duplicate resolution",
						{
							proposalId: resolution.proposalId,
							changeIndex: resolution.changeIndex,
						},
					);
				}
			}
		};
		const newlyApplied: number[] = [];
		const workflowChanges: StoredChange[] = [];
		const workflowIndexes: number[] = [];
		let dedupCollisionCount = 0;

		for (const entry of replayEntries) {
			const i = entry.index;
			const change = entry.change;
			if (i === null || !change) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Selected review entry has no stored change or index",
				});
			}
			if (alreadyApplied.has(i)) {
				continue;
			}

			if (change.action === "create") {
				const family = inferDedupFamily({
					kindOverride: change.kindOverride ?? null,
					type: change.type,
				});
				const collision = dedupGuard.findCollision(
					family,
					change.title.to,
				);
				if (collision) {
					duplicateResolutions.push({
						proposalId: input.proposalId,
						changeIndex: i,
						existingEntityId: collision.existingId,
						existingEntityType: family === "BUG" ? "bug" : "story",
					});
					// Dedup-collision: the change resolves to a pre-existing
					// UserStory. Treat as soft-success. We deliberately do NOT
					// mutate `pmAutoSyncEnabled` on the existing target row —
					// retry must not flip the PM-sync gate on stories the user
					// previously configured.
					newlyApplied.push(i);
					dedupCollisionCount += 1;
					continue;
				}
			}

			// Miss or non-create — include in the workflow payload.
			if (entry.override) {
				workflowOverrides[workflowChanges.length] = entry.override;
			}
			workflowChanges.push(change);
			workflowIndexes.push(i);
		}

		// 4. Full-dedup short-circuit. All remaining changes already exist by
		//    title → mark APPLIED directly; skip the workflow start.
		if (workflowChanges.length === 0) {
			const mergedApplied = Array.from(
				new Set([...alreadyApplied, ...newlyApplied]),
			);
			// Close only a still-FAILED row; a concurrent dispatch owns its claim.
			const finalized = await db.pendingBacklogProposal.updateMany({
				where: retryWhere,
				data: {
					status: "APPLIED",
					appliedAt: new Date(),
					applyError: null,
					appliedChangeIndexes: mergedApplied,
				},
			});
			if (finalized.count !== 1) {
				throw new ORPCError("CONFLICT", {
					message: "This proposal is no longer failed.",
				});
			}
			await recordDuplicates();
			return {
				workflowId: null,
				dedupCollisionCount,
				message: "Already on roadmap.",
			};
		}

		// Resolve project scope and PM metadata before taking the apply claim.
		const project = await db.project.findFirst({
			where: {
				id: input.projectId,
				...(organizationId
					? { organizationId, userId: user.id }
					: { organizationId: null, userId: user.id }),
			},
			select: {
				id: true,
				organizationId: true,
				projectManagementContainerName: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// 5. Compare-and-set FAILED → APPLYING before dispatch. A competing
		// retry that already loaded FAILED must still win this write to start.
		const newWorkflowId = `backlog-apply-retry-${input.projectId}-${Date.now()}`;
		const mergedApplied = Array.from(
			new Set([...alreadyApplied, ...newlyApplied]),
		);
		const claimed = await db.pendingBacklogProposal.updateMany({
			where: retryWhere,
			data: {
				status: "APPLYING",
				reviewedAt: new Date(),
				reviewedBy: user.id,
				applyWorkflowId: newWorkflowId,
				...(review ? { applyReviewWorkflowId: newWorkflowId } : {}),
				// This claim is unconfirmed until workflow.start returns. The
				// watchdog uses the fresh reviewedAt while the start is in flight.
				applyStartedAt: null,
				applyError: null,
				errorClass: null,
				errorMessage: null,
				failedAt: null,
				appliedChangeIndexes: mergedApplied,
			},
		});

		if (claimed.count !== 1) {
			throw new ORPCError("CONFLICT", {
				message: "This proposal is no longer failed.",
			});
		}

		await recordDuplicates();

		try {
			const client = await getTemporalClient();
			const handle = await client.workflow.start(
				"backlogApplyChangesWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId: newWorkflowId,
					args: [
						{
							projectId: input.projectId,
							userId: user.id,
							approvedByName: user.name ?? null,
							// A person clicked and waits for this: it may run on their own ChatGPT plan (Fizzy #2770).
							planEligible: true,
							organizationId:
								organizationId ??
								project.organizationId ??
								undefined,
							approvedChanges: workflowChanges,
							approvedChangeIndexes: workflowIndexes,
							syncToPM: Boolean(syncSettings.syncToPM),
							pmSyncOverrides: workflowOverrides,
							pmConfig: syncSettings.pmConfig
								? {
										...syncSettings.pmConfig,
										containerName:
											project.projectManagementContainerName ??
											undefined,
									}
								: undefined,
							pendingProposalId: input.proposalId,
							// Bug 1429 / Codex round 6: the retry path replays a
							// FAILED proposal of ANY source. Gate epic-suppression
							// on the proposal's source so a FAILED channel-monitor
							// proposal carrying a stored pre-fix `type:"epic"`
							// change is normalized server-side on replay, while a
							// general AI Update (AI_UPDATE_SIDEBAR) proposal keeps
							// its epics first-class.
							forbidEpics: isChannelMonitorSource(
								proposal.source,
							),
							conversationId:
								typeof sourceMetadata.conversationId ===
								"string"
									? sourceMetadata.conversationId
									: undefined,
						},
					],
				}),
			);

			await markProposalApplyDispatched({
				proposalId: input.proposalId,
				applyWorkflowId: newWorkflowId,
				mode: "claimed",
			}).catch(() => 0);

			return {
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
				dedupCollisionCount,
				message: `Retrying ${workflowChanges.length} change(s)${
					dedupCollisionCount > 0
						? `; ${dedupCollisionCount} resolved via dedup`
						: ""
				}.`,
			};
		} catch (error) {
			console.error("[backlog] retry-failed-proposal failed:", error);
			// Return this claim to FAILED if start failed. A concurrent cancel,
			// finalization, or replacement claimant must keep its outcome.
			await db.pendingBacklogProposal
				.updateMany({
					where: {
						id: input.proposalId,
						status: "APPLYING",
						applyWorkflowId: newWorkflowId,
					},
					data: {
						status: "FAILED",
						applyError: (error instanceof Error
							? describeSyncErrorForUser(error)
							: "retry-workflow-start failed"
						).slice(0, 4000),
						errorClass: "TemporalScheduleFailed",
						errorMessage: "Background job couldn't start.",
						failedAt: new Date(),
					},
				})
				.catch(() => {
					// non-fatal — surfaced via the thrown ORPCError below.
				});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? describeSyncErrorForUser(error)
						: "Failed to start retry workflow",
			});
		}
	});
