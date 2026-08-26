/**
 * Get Weave Execution Procedure
 *
 * Queries execution status from the database and the Fabric Loom workflow.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import {
	orchestratorPendingApprovalQuery,
	orchestratorProgressQuery,
} from "@repo/temporal/workflows";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";

const GetExecutionInputSchema = z.object({
	executionId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * Don't reconcile rows younger than this: a freshly started execution may
 * not be visible to Temporal describe yet (startup race).
 */
const RECONCILE_GRACE_MS = 30_000;

/** Statuses the reconcile guard may transition away from. */
const NON_TERMINAL_EXECUTION_STATUSES = [
	"PENDING",
	"RUNNING",
	"PAUSED",
	"CHECKPOINT",
] as const;

export const getExecutionProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/weave/executions/:executionId",
		tags: ["Weave"],
		summary: "Get execution status",
	})
	.input(GetExecutionInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		let execution = await db.weaveExecution.findFirst({
			where: {
				id: input.executionId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
			include: {
				plan: true,
			},
		});

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found or access denied",
			});
		}

		// Reconcile-on-read: a workflow can die without persisting terminal
		// state (worker crash, Temporal-side termination), leaving the row
		// claiming to be live forever. When the row still looks live and is
		// past a short startup grace, ask Temporal for the workflow's actual
		// status and persist the terminal outcome. Wrapped so a Temporal
		// outage never breaks the read — the row is returned as-is.
		if (
			(execution.status === "RUNNING" ||
				execution.status === "PAUSED" ||
				execution.status === "CHECKPOINT") &&
			execution.startedAt &&
			Date.now() - execution.startedAt.getTime() > RECONCILE_GRACE_MS
		) {
			try {
				const temporal = await getTemporalClient();
				// No runId pin: the orchestrator uses continueAsNew, so the
				// handle must resolve to the latest run in the chain —
				// pinning the first run would mis-flag live successors as
				// terminal.
				const handle = temporal.workflow.getHandle(
					execution.workflowId,
				);

				let reconciled: {
					status: "FAILED" | "CANCELLED" | "COMPLETED";
					error?: string;
				} | null = null;
				try {
					const description = await handle.describe();
					const statusName = description.status.name;
					if (
						statusName === "FAILED" ||
						statusName === "TERMINATED" ||
						statusName === "TIMED_OUT"
					) {
						reconciled = {
							status: "FAILED",
							error: `Execution workflow ${statusName
								.toLowerCase()
								.replace(/_/g, " ")}`,
						};
					} else if (statusName === "CANCELLED") {
						reconciled = { status: "CANCELLED" };
					} else if (statusName === "COMPLETED") {
						// Row still non-terminal: the completion-phase write
						// was lost.
						reconciled = { status: "COMPLETED" };
					}
					// RUNNING / CONTINUED_AS_NEW: workflow is live — leave
					// the row alone and fall through to the progress query.
				} catch (error) {
					if (
						error instanceof Error &&
						error.name === "WorkflowNotFoundError"
					) {
						reconciled = {
							status: "FAILED",
							error: "Execution workflow no longer exists",
						};
					} else {
						throw error;
					}
				}

				if (reconciled) {
					// Guarded update: never overwrite a terminal state
					// another writer (workflow finally, watchdog, cancel)
					// got to first.
					const updated = await db.weaveExecution.updateMany({
						where: {
							id: execution.id,
							status: {
								in: [...NON_TERMINAL_EXECUTION_STATUSES],
							},
						},
						data: {
							status: reconciled.status,
							...(reconciled.error
								? { error: reconciled.error }
								: {}),
							completedAt: new Date(),
						},
					});

					if (
						updated.count > 0 &&
						(reconciled.status === "FAILED" ||
							reconciled.status === "CANCELLED")
					) {
						// Restore the parent plan so Execute/retry become
						// available again. When the guard lost the race
						// (count 0), the winning writer owns the plan
						// reconciliation.
						await db.weavePlan.updateMany({
							where: {
								status: "RUNNING",
								executions: { some: { id: execution.id } },
							},
							data: { status: "APPROVED" },
						});
					}

					// Re-read so the response reflects the terminal state
					// (and the live progress query below is skipped).
					const refreshed = await db.weaveExecution.findFirst({
						where: {
							id: input.executionId,
							userId,
							...(organizationId
								? { organizationId }
								: { organizationId: null }),
						},
						include: {
							plan: true,
						},
					});
					if (refreshed) {
						execution = refreshed;
					}
				}
			} catch (error) {
				console.error(
					"[weave] Execution reconcile-on-read failed:",
					error,
				);
			}
		}

		const runSelect = {
			id: true,
			status: true,
			executionChannel: true,
			provider: true,
			providerSessionId: true,
			providerMetadata: true,
			externalUrl: true,
			externalStatus: true,
			workingDirectory: true,
			targetBranch: true,
			pullRequestUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			createdAt: true,
		} as const;
		const implementationSession =
			(await db.codingRun.findFirst({
				where: {
					weaveExecutionId: execution.id,
					userId,
					...(organizationId
						? { organizationId }
						: { organizationId: null }),
				},
				select: runSelect,
			})) ??
			(execution.plan.userStoryId
				? await db.codingRun.findFirst({
						where: {
							projectId: execution.projectId,
							storyId: execution.plan.userStoryId,
							...(execution.plan.storyTaskId
								? { storyTaskId: execution.plan.storyTaskId }
								: {}),
							weaveExecutionId: null,
							userId,
							...(organizationId
								? { organizationId }
								: { organizationId: null }),
						},
						orderBy: { createdAt: "desc" },
						select: runSelect,
					})
				: null);

		// Query orchestrator workflow for live status
		let workflowStatus = null;
		let checkpoint = null;

		if (
			execution.status === "RUNNING" ||
			execution.status === "PAUSED" ||
			execution.status === "CHECKPOINT"
		) {
			try {
				const temporal = await getTemporalClient();
				const handle = temporal.workflow.getHandle(
					execution.workflowId,
					execution.runId,
				);
				workflowStatus = await handle.query(orchestratorProgressQuery);

				// Check for pending approvals
				if (execution.status === "CHECKPOINT") {
					const pendingApproval = await handle.query(
						orchestratorPendingApprovalQuery,
					);
					if (pendingApproval) {
						checkpoint = pendingApproval;
					}
				}
			} catch (error) {
				console.error("Failed to query workflow status:", error);
			}
		}

		return {
			...execution,
			workflowStatus,
			checkpoint,
			implementationSession,
		};
	});
