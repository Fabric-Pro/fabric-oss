import { ORPCError } from "@orpc/client";
import {
	createWorkflowExecution,
	db,
	getWorkflowById,
	hasWorkflowAccess,
	type Prisma,
} from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import { checkExecutionConcurrency } from "../../lib/execution-concurrency";
import {
	WORKFLOW_BUILDER_TASK_QUEUE,
	WORKFLOW_RUN_TIMEOUT,
} from "../../lib/execution-limits";
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

		// Refuse before creating a row: an execution record for a run that is
		// only going to queue behind the tenant's own backlog is noise in the
		// run history and still consumes a worker slot when it is picked up.
		const concurrency = await checkExecutionConcurrency({
			userId: user.id,
			organizationId,
		});

		if (!concurrency.allowed) {
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `This workspace already has ${concurrency.inFlight} workflow executions running (limit ${concurrency.limit}). Wait for one to finish, or cancel one.`,
			});
		}

		// Create execution record
		const execution = await createWorkflowExecution({
			workflowId: input.id,
			version: workflow.version,
			triggerType: "MANUAL",
			triggerInput: {
				triggerData: input.triggerData,
				variables: input.variables,
			} as Prisma.InputJsonValue,
			userId: user.id,
			organizationId,
		});

		// Check if Temporal is available
		const temporalAvailable = await isTemporalAvailable();

		if (temporalAvailable) {
			try {
				const client = await getTemporalClient();

				// Start the Temporal workflow
				const handle = await client.workflow.start(
					"workflowBuilderExecutionWorkflow",
					withCorrelationMemo({
						taskQueue: WORKFLOW_BUILDER_TASK_QUEUE,
						workflowId: `workflow-execution-${execution.id}`,
						// A run had no ceiling at all: node activities are
						// capped at ten minutes each, but the walk over them
						// was unbounded, so a large or wedged graph could hold
						// a worker slot indefinitely. Temporal marks the run
						// TIMED_OUT, which the status enum already carries.
						workflowExecutionTimeout: WORKFLOW_RUN_TIMEOUT,
						args: [
							{
								executionId: execution.id,
								workflowId: input.id,
								userId: user.id,
								organizationId,
								// Owning project — enables the Read-only mode write
								// gate even when nodes/edges are passed inline (the
								// workflow only loads the row when they are not)
								projectId: workflow.projectId ?? undefined,
								triggerData: input.triggerData,
								variables: input.variables,
								// Pass current nodes/edges if provided (unsaved changes)
								nodes: input.nodes,
								edges: input.edges,
							},
						],
					}),
				);

				// Update execution with Temporal run ID
				await db.workflowExecution.update({
					where: { id: execution.id },
					data: {
						temporalRunId: handle.workflowId,
						status: "RUNNING",
						startedAt: new Date(),
					},
				});

				return {
					execution,
					temporalWorkflowId: handle.workflowId,
					status: "started",
				};
			} catch (error) {
				console.error("Failed to start Temporal workflow:", error);
				// Fall through and fail the row below.
			}
		}

		// Nothing picked this run up. Nothing ever will: no sweeper reclaims a
		// PENDING execution, so leaving the row as it was created reads in the
		// run history as "queued" forever rather than "never started". Record
		// the terminal state instead, and say so to the caller.
		const failure =
			"Workflow engine unavailable — the run was not started. Try again.";
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
			message: failure,
		};
	});
