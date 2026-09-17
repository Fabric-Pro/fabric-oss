import { ORPCError } from "@orpc/client";
import {
	db,
	getWorkflowById,
	hasWorkflowAccess,
	markExecutionRunningIfPending,
	type Prisma,
} from "@repo/database";
import { isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	concurrencyRefusalMessage,
	createExecutionWithinConcurrencyCap,
} from "../../lib/execution-concurrency";
import {
	attemptWorkflowBuilderStart,
	startFailureMessage,
	unconfirmedStartMessage,
} from "../../lib/start-builder-execution";
import { validateWorkflowBeforeExecution } from "../../lib/workflow-validation";

export const startWorkflowExecutionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/{id}/execute",
		tags: ["Workflows"],
		summary: "Start workflow execution",
		description: "Start a new execution of a workflow",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			triggerData: z.record(z.string(), z.unknown()).optional(),
			variables: z.record(z.string(), z.unknown()).optional(),
			// Optional: current nodes/edges from UI (if not saved yet)
			nodes: z.array(z.any()).optional(),
			edges: z.array(z.any()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Check workflow access
		const hasAccess = await hasWorkflowAccess(
			input.id,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// Get workflow to get current version
		const workflow = await getWorkflowById(
			input.id,
			user.id,
			organizationId,
		);

		if (!workflow) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// Validate workflow before execution
		const nodes = input.nodes || (workflow.nodes as unknown[]) || [];
		const edges = input.edges || (workflow.edges as unknown[]) || [];

		const validation = validateWorkflowBeforeExecution(nodes, edges);

		if (!validation.valid) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Workflow validation failed: ${validation.errors.join("; ")}`,
			});
		}

		// Log any warnings (but don't block execution)
		if (validation.warnings.length > 0) {
			console.log(
				`[Workflow Execution] Warnings for ${workflow.id}:`,
				validation.warnings,
			);
		}

		// The row is created inside the capacity reservation, so the cap
		// holds under concurrent starts rather than only when nobody races
		// for it. A refusal creates nothing: an execution record for a run
		// that is only going to queue behind the tenant's own backlog is
		// noise in the run history.
		const reservation = await createExecutionWithinConcurrencyCap({
			userId: user.id,
			organizationId,
			data: {
				workflowId: input.id,
				version: workflow.version,
				triggerType: "MANUAL",
				triggerInput: {
					triggerData: input.triggerData,
					variables: input.variables,
				} as Prisma.InputJsonValue,
			},
		});

		if (!reservation.allowed) {
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: concurrencyRefusalMessage(reservation),
			});
		}
		const execution = reservation.execution;

		// Check if Temporal is available
		const temporalAvailable = await isTemporalAvailable();
		let failure =
			"Workflow engine unavailable — the run was not started. Try again.";

		if (temporalAvailable) {
			// Type, id scheme, queue and run ceiling all live in the shared
			// helper so every trigger surface agrees with the cancel paths and
			// with the worker — and so does what a failed start call means.
			const outcome = await attemptWorkflowBuilderStart({
				executionId: execution.id,
				workflowId: input.id,
				userId: user.id,
				organizationId,
				// Owning project — enables the Read-only mode write gate even
				// when nodes/edges are passed inline (the workflow only loads
				// the row when they are not)
				projectId: workflow.projectId ?? undefined,
				triggerData: input.triggerData,
				variables: input.variables,
				// Pass current nodes/edges if provided (unsaved changes)
				nodes: input.nodes,
				edges: input.edges,
			});

			if (outcome.status === "confirmed") {
				// The run exists in the engine from here on. A failure to
				// persist that fact must not be reported as "not started" —
				// a retry would start a second run with the same side
				// effects — so it is logged and the start is still reported.
				// The workflow writes its own status as it progresses, and
				// its id is deterministic from the execution id.
				// PENDING → RUNNING only: a fast run may already have
				// written its terminal status, which must not move back.
				try {
					await markExecutionRunningIfPending({
						executionId: execution.id,
						temporalRunId: outcome.workflowId,
					});
				} catch (error) {
					console.error(
						"Workflow started but the execution row could not be marked RUNNING:",
						{
							executionId: execution.id,
							workflowId: outcome.workflowId,
						},
						error,
					);
				}

				return {
					execution,
					temporalWorkflowId: outcome.workflowId,
					status: "started",
					outcome: "started" as const,
				};
			}

			if (outcome.status === "unknown") {
				// The start call failed and the follow-up describe could not
				// settle whether Temporal accepted it. The run may be in
				// progress under the deterministic id, so the row stays
				// active: failing it would invite a retry, which creates a
				// new row and a second run with the same side effects.
				console.warn(
					"Workflow start unconfirmed; leaving the execution row active:",
					{
						executionId: execution.id,
						workflowId: outcome.workflowId,
					},
					outcome.error,
				);
				// Resolved, not thrown: an error reads as "retry", and a
				// retry is exactly the duplicate this avoids. The caller gets
				// the execution id and polls it.
				return {
					execution,
					temporalWorkflowId: outcome.workflowId,
					status: "unconfirmed",
					outcome: "unconfirmed" as const,
					message: unconfirmedStartMessage(execution.id),
				};
			}

			console.error("Failed to start Temporal workflow:", outcome.error);
			failure = `The workflow engine rejected the start: ${startFailureMessage(outcome.error)}`;
		}

		// Nothing picked this run up, and Temporal confirmed nothing will: no
		// sweeper reclaims a PENDING execution, so leaving the row as it was
		// created reads in the run history as "queued" forever rather than
		// "never started". Record the terminal state instead, and say so to
		// the caller.
		const failedAt = new Date();
		await db.workflowExecution.update({
			where: { id: execution.id },
			data: {
				status: "FAILED",
				error: failure,
				completedAt: failedAt,
				duration: failedAt.getTime() - execution.startedAt.getTime(),
			},
		});

		return {
			execution: { ...execution, status: "FAILED" as const },
			temporalWorkflowId: null,
			status: "failed",
			outcome: "failed" as const,
			message: failure,
		};
	});
