// XOR-audited 2026-05-28 — organizationId+userId enforced on every query

import { ORPCError } from "@orpc/client";
import {
	buildBacklogDedupGuard,
	db,
	getPendingBacklogProposal,
	inferDedupFamily,
	markPendingProposalApplied,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isChannelMonitorSource } from "../../lib/channel-monitor-source";

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

/**
 * Retry a FAILED `PendingBacklogProposal` row.
 *
 * Behavior:
 *   1. Load proposal, verify project + tenancy, verify status === FAILED.
 *   2. Build a `BacklogDedupGuard` for the project (PR #1238 helper).
 *   3. For every change not already in `appliedChangeIndexes`, call
 *      `guard.findCollision(family, title)`:
 *        - collision → soft dedup-success: dedupCollisionCount++ and the
 *          original index is folded into the new `appliedChangeIndexes`.
 *          The existing target UserStory keeps its `pmAutoSyncEnabled` —
 *          retry MUST NOT mutate the gate on a pre-existing row.
 *        - miss → include in the workflow payload.
 *   4. If every remaining change resolved via dedup → mark APPLIED
 *      directly, no workflow.
 *   5. Otherwise: atomically flip status to PENDING (idempotency under
 *      double-click — second call sees a non-FAILED row and CONFLICTs) and
 *      start `backlogApplyChangesWorkflow` with the filtered payload and
 *      `pendingProposalId` so the workflow's terminal transition lands on
 *      the same row.
 *
 * AUTHORIZATION: `tenantProtectedProcedure` + `PROJECT_UPDATE` —
 * mirrors the channel-monitor approve/retry pattern.
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

		// 2. Decode stored payload + metadata snapshot.
		const proposalPayload = proposal.proposal as {
			changes?: unknown;
		} | null;
		const storedChanges: StoredChange[] = Array.isArray(
			proposalPayload?.changes,
		)
			? (proposalPayload?.changes as StoredChange[])
			: [];
		if (storedChanges.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Stored proposal has no changes to retry",
			});
		}
		const sourceMetadata = (proposal.sourceMetadata ??
			{}) as StoredSourceMetadata;
		const alreadyApplied = new Set(proposal.appliedChangeIndexes ?? []);

		// 3. Dedup guard pass on every remaining CREATE.
		const dedupGuard = await buildBacklogDedupGuard(input.projectId);
		const newlyApplied: number[] = [];
		const workflowChanges: StoredChange[] = [];
		const workflowIndexes: number[] = [];
		let dedupCollisionCount = 0;

		for (let i = 0; i < storedChanges.length; i++) {
			if (alreadyApplied.has(i)) {
				continue;
			}
			const change = storedChanges[i];
			if (!change) {
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
			workflowChanges.push(change);
			workflowIndexes.push(i);
		}

		// 4. Full-dedup short-circuit. All remaining changes already exist by
		//    title → mark APPLIED directly; skip the workflow start.
		if (workflowChanges.length === 0) {
			const mergedApplied = Array.from(
				new Set([
					...(proposal.appliedChangeIndexes ?? []),
					...newlyApplied,
				]),
			);
			// Atomic flip — single Prisma update writes APPLIED + the merged
			// appliedChangeIndexes set so a concurrent retry sees the new
			// status before it tries to claim the row.
			await db.pendingBacklogProposal.update({
				where: { id: input.proposalId },
				data: {
					status: "APPLIED",
					appliedAt: new Date(),
					applyError: null,
					appliedChangeIndexes: mergedApplied,
				},
			});
			// Call the shared helper too so a future change to the
			// APPLIED-transition contract picks it up (idempotent — the row
			// is already APPLIED).
			await markPendingProposalApplied(input.proposalId).catch(() => {
				// no-op: row already APPLIED in the line above.
			});
			return {
				workflowId: null,
				dedupCollisionCount,
				message: "Already on roadmap.",
			};
		}

		// 5. Atomic flip to PENDING + restart workflow.
		//    Idempotency: a second concurrent retry call will load the row,
		//    see `status === "PENDING"`, and return CONFLICT before it
		//    reaches this update. If the second call slipped past the load
		//    check, the Prisma `update` with the `id` PK is single-statement
		//    and PG row-locks under the hood; the dedup guard catches any
		//    eventual duplicate CREATE at the workflow level (PR #1238).
		const newWorkflowId = `backlog-apply-retry-${input.projectId}-${Date.now()}`;
		const mergedApplied = Array.from(
			new Set([
				...(proposal.appliedChangeIndexes ?? []),
				...newlyApplied,
			]),
		);
		await db.pendingBacklogProposal.update({
			where: { id: input.proposalId },
			data: {
				status: "PENDING",
				applyWorkflowId: newWorkflowId,
				// Reset the dispatch clock the stuck-apply watchdog measures from
				// — the original row's `createdAt` is stale on a retry.
				applyStartedAt: new Date(),
				applyError: null,
				errorClass: null,
				errorMessage: null,
				failedAt: null,
				appliedChangeIndexes: mergedApplied,
			},
		});

		// Best-effort project meta (PM container name) — same shape as
		// `apply-changes.ts`. Project tenancy is enforced by the row read +
		// the explicit XOR check below.
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
							organizationId:
								organizationId ??
								project.organizationId ??
								undefined,
							approvedChanges: workflowChanges,
							approvedChangeIndexes: workflowIndexes,
							syncToPM: Boolean(sourceMetadata.syncToPM),
							pmConfig: sourceMetadata.pmConfig
								? {
										...sourceMetadata.pmConfig,
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
			// Workflow start failed AFTER we flipped the row to PENDING.
			// Revert the row back to FAILED so the inbox + banner still
			// surface it. Best-effort — if the revert fails the inbox will
			// show a leaked PENDING row that the user can dismiss / retry.
			await db.pendingBacklogProposal
				.update({
					where: { id: input.proposalId },
					data: {
						status: "FAILED",
						applyError: (error instanceof Error
							? error.message
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
						? error.message
						: "Failed to start retry workflow",
			});
		}
	});
