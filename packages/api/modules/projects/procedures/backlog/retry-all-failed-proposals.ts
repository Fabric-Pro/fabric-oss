// XOR-audited 2026-05-28 — organizationId+userId enforced on every query

import { ORPCError } from "@orpc/client";
import {
	buildBacklogDedupGuard,
	db,
	finalizeBacklogUpdateSession,
	getPendingBacklogProposal,
	inferDedupFamily,
	listFailedProposals,
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

const RETRY_BATCH_LIMIT = 50;

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
 * Sequentially retry every FAILED proposal under a project.
 *
 * Bounded at 50 per call so a runaway retry-all cannot DoS Temporal or the
 * downstream PM tool. Above that, the caller gets RESOURCE_EXHAUSTED with
 * a copy nudge to retry the remaining rows individually.
 *
 * Sequencing keeps per-error attribution deterministic; concurrent starts
 * would scramble the order of error rows in the results array, making it
 * hard for the user to map "row N" to a workflow.
 *
 * Each row runs through the same dedup-guard + tenant-XOR + atomic flip
 * sequence as `retryFailedProposalProcedure`. We re-import the shared
 * helpers rather than calling into the single-row procedure handler so the
 * sequential loop doesn't pay the procedure-stack overhead per row.
 */
export const retryAllFailedProposalsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/proposals/retry-all-failed",
		tags: ["Projects", "Backlog"],
		summary: "Retry all failed backlog proposals",
		description:
			"Sequentially retries every FAILED proposal for the project, bounded at 50 rows per call",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			retriedCount: z.number(),
			results: z.array(
				z.object({
					proposalId: z.string(),
					workflowId: z.string().nullable(),
					status: z.enum(["queued", "dedup_only_applied", "error"]),
					message: z.string().optional(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify the project is in the caller's tenancy first; the failure
		// list query that follows is project-scoped so the XOR check here
		// gates every row returned downstream.
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

		const failed = await listFailedProposals({
			projectId: input.projectId,
		});

		// Belt-and-suspenders XOR check on every row — listFailedProposals
		// filters by projectId only; the caller MUST verify tenancy per row.
		const resolvedOrgId = organizationId ?? null;
		const tenantOwned = failed.filter(
			(p) =>
				(p.organizationId ?? null) === resolvedOrgId &&
				p.userId === user.id,
		);

		if (tenantOwned.length > RETRY_BATCH_LIMIT) {
			throw new ORPCError("RESOURCE_EXHAUSTED", {
				message: `Too many failed proposals (${tenantOwned.length}); retry up to ${RETRY_BATCH_LIMIT} at a time`,
			});
		}

		const results: Array<{
			proposalId: string;
			workflowId: string | null;
			status: "queued" | "dedup_only_applied" | "error";
			message?: string;
		}> = [];

		const client = await getTemporalClient().catch((error) => {
			// Temporal unavailable — every row will return as `error`. We
			// still walk the list to give the user a per-row breakdown.
			return { error } as { error: unknown };
		});

		for (const proposal of tenantOwned) {
			// Re-read the latest state in case another retry call landed
			// between the listFailedProposals call and this iteration.
			const fresh = await getPendingBacklogProposal(proposal.id);
			if (!fresh || fresh.status !== "FAILED") {
				results.push({
					proposalId: proposal.id,
					workflowId: null,
					status: "error",
					message: fresh
						? `Skipped — status is now '${fresh.status}'`
						: "Skipped — proposal vanished",
				});
				continue;
			}

			const proposalPayload = fresh.proposal as {
				changes?: unknown;
			} | null;
			const storedChanges: StoredChange[] = Array.isArray(
				proposalPayload?.changes,
			)
				? (proposalPayload?.changes as StoredChange[])
				: [];
			if (storedChanges.length === 0) {
				results.push({
					proposalId: proposal.id,
					workflowId: null,
					status: "error",
					message: "Stored proposal has no changes",
				});
				continue;
			}
			const sourceMetadata = (fresh.sourceMetadata ??
				{}) as StoredSourceMetadata;
			const alreadyApplied = new Set(fresh.appliedChangeIndexes ?? []);

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
						// Soft dedup-success — no UserStory mutation.
						newlyApplied.push(i);
						dedupCollisionCount += 1;
						continue;
					}
				}
				workflowChanges.push(change);
				workflowIndexes.push(i);
			}

			const mergedApplied = Array.from(
				new Set([
					...(fresh.appliedChangeIndexes ?? []),
					...newlyApplied,
				]),
			);

			if (workflowChanges.length === 0) {
				// Full-dedup short-circuit — mark APPLIED, no workflow start.
				await db.pendingBacklogProposal.update({
					where: { id: fresh.id },
					data: {
						status: "APPLIED",
						appliedAt: new Date(),
						applyError: null,
						appliedChangeIndexes: mergedApplied,
					},
				});
				await markPendingProposalApplied(fresh.id).catch(() => {
					// no-op: already APPLIED.
				});
				// This terminal flip bypasses the apply workflow's finalize
				// activity, so finalize any session-history row directly (best-
				// effort, no-op when none exists) to avoid a stuck APPLYING row.
				try {
					await finalizeBacklogUpdateSession({
						pendingProposalId: fresh.id,
						status: "APPLIED",
					});
				} catch {
					// Non-fatal: a stuck session row only affects the history tab.
				}
				results.push({
					proposalId: fresh.id,
					workflowId: null,
					status: "dedup_only_applied",
					message:
						dedupCollisionCount > 0
							? `${dedupCollisionCount} change(s) already on roadmap.`
							: "Already on roadmap.",
				});
				continue;
			}

			if (!client || "error" in client) {
				results.push({
					proposalId: fresh.id,
					workflowId: null,
					status: "error",
					message:
						client &&
						"error" in client &&
						client.error instanceof Error
							? client.error.message
							: "Temporal client unavailable",
				});
				continue;
			}

			const newWorkflowId = `backlog-apply-retry-all-${input.projectId}-${fresh.id}-${Date.now()}`;
			try {
				await db.pendingBacklogProposal.update({
					where: { id: fresh.id },
					data: {
						status: "PENDING",
						applyWorkflowId: newWorkflowId,
						// Reset the dispatch clock the stuck-apply watchdog
						// measures from — `createdAt` is stale on a retry.
						applyStartedAt: new Date(),
						applyError: null,
						errorClass: null,
						errorMessage: null,
						failedAt: null,
						appliedChangeIndexes: mergedApplied,
					},
				});

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
								pendingProposalId: fresh.id,
								// Bug 1429 / Codex round 6: gate epic-suppression
								// PER proposal source so a mixed batch sets the flag
								// correctly for each workflow start (channel-monitor
								// → normalize epics; AI_UPDATE_SIDEBAR → keep epics).
								forbidEpics: isChannelMonitorSource(
									fresh.source,
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

				results.push({
					proposalId: fresh.id,
					workflowId: handle.workflowId,
					status: "queued",
					message:
						dedupCollisionCount > 0
							? `Queued; ${dedupCollisionCount} resolved via dedup.`
							: undefined,
				});
			} catch (error) {
				// Revert the row to FAILED so the inbox still surfaces it.
				await db.pendingBacklogProposal
					.update({
						where: { id: fresh.id },
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
					.catch(() => {});
				results.push({
					proposalId: fresh.id,
					workflowId: null,
					status: "error",
					message:
						error instanceof Error
							? error.message
							: "Failed to start retry workflow",
				});
			}
		}

		return {
			retriedCount: results.filter((r) => r.status !== "error").length,
			results,
		};
	});
