import { ORPCError } from "@orpc/client";
import {
	createWorkflowExecutionIdempotent,
	db,
	getWorkflowById,
	hasWorkflowAccess,
	markExecutionRunningIfPending,
	type Prisma,
	releasedIdempotencyTriggerInput,
	type WorkflowExecution,
} from "@repo/database";
import { isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import {
	enforceWorkflowRateLimit,
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	concurrencyRefusalMessage,
	createExecutionWithinConcurrencyCap,
	resolveExecutionConcurrencyLimit,
} from "../../lib/execution-concurrency";
import {
	boundedInlineGraphSchema,
	boundedJsonRecord,
	EXECUTION_INPUT_BOUNDS,
} from "../../lib/execution-input-bounds";
import {
	attemptWorkflowBuilderStart,
	type StartWorkflowBuilderExecutionInput,
	startFailureMessage,
	unconfirmedStartMessage,
} from "../../lib/start-builder-execution";
import { validateWorkflowBeforeExecution } from "../../lib/workflow-validation";

/**
 * How long a client idempotency key identifies its run. Long enough to cover
 * a double-click, a browser retry after a dropped connection, and a user
 * mashing the button while the first response is in flight; short enough
 * that a key the client accidentally reuses tomorrow starts a fresh run.
 */
const EXECUTION_IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

export const startWorkflowExecutionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	// `RATE_LIMIT_PRESETS.workflow` (30/min per user per path). Starting a run
	// holds a worker slot and creates a row, and this procedure had no cap at
	// all — `workflowRateLimitedProcedure` exists but is built on the
	// non-tenant chain, so no workflow procedure could use it. Mounted after
	// the permission gate so a caller the gate refuses never spends budget,
	// and before the handler so a limited call does no database work.
	.use(async ({ context, next, path }) => {
		await enforceWorkflowRateLimit(context.user.id, path);
		return await next();
	})
	.route({
		method: "POST",
		path: "/workflows/{id}/execute",
		tags: ["Workflows"],
		summary: "Start workflow execution",
		description: "Start a new execution of a workflow",
	})
	.input(
		z
			.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
				// Everything below is written to the row and serialised into
				// the Temporal start request as one payload; the bounds keep
				// the sum under the engine's 2 MiB payload ceiling. See
				// `execution-input-bounds.ts`.
				triggerData: boundedJsonRecord(
					EXECUTION_INPUT_BOUNDS.triggerDataBytes,
					"triggerData",
				).optional(),
				variables: boundedJsonRecord(
					EXECUTION_INPUT_BOUNDS.variablesBytes,
					"variables",
				).optional(),
				// Client-generated. When present, a second start with the same key
				// from the same user for the same workflow inside
				// EXECUTION_IDEMPOTENCY_WINDOW_MS returns the run the first one
				// created instead of starting another. Bounded because it is
				// persisted into `triggerInput` and used as a lock key.
				idempotencyKey: z.string().trim().min(1).max(128).optional(),
			})
			// Optional: current nodes/edges from UI (if not saved yet)
			.and(boundedInlineGraphSchema),
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

		// Create the execution row inside the capacity reservation, so the
		// tenant's in-flight cap holds under concurrent starts rather than only
		// when nobody races for it. A refusal creates nothing: a row for a run
		// that is only going to queue behind the tenant's own backlog is noise
		// in the run history.
		//
		// With an idempotency key the row is a find-or-create serialised on
		// the key, and the key is resolved BEFORE the cap: a retry carrying the
		// key of a run already started asks for nothing new and must get that
		// run back even when the tenant is at its cap — the case where the
		// first request started the last permitted run and lost its response.
		const triggerInput = {
			triggerData: input.triggerData,
			variables: input.variables,
		};
		let execution: WorkflowExecution;
		if (input.idempotencyKey) {
			const result = await createWorkflowExecutionIdempotent({
				workflowId: input.id,
				version: workflow.version,
				triggerType: "MANUAL",
				triggerInput: triggerInput as Record<
					string,
					Prisma.InputJsonValue | undefined
				>,
				userId: user.id,
				organizationId,
				idempotencyKey: input.idempotencyKey,
				windowMs: EXECUTION_IDEMPOTENCY_WINDOW_MS,
				limit: await resolveExecutionConcurrencyLimit(organizationId),
			});
			if (result.outcome === "limit-reached") {
				throw new ORPCError("TOO_MANY_REQUESTS", {
					message: concurrencyRefusalMessage(result),
				});
			}
			if (result.outcome === "existing") {
				const existing = result.execution;
				// A PENDING row with no run id has no confirmed start: the
				// first request may still be between its insert and its
				// engine start, or its start was unconfirmed. Reporting that
				// as "started" told the editor a run existed; it is
				// "unconfirmed", and the caller polls the same execution id.
				const status =
					existing.status === "FAILED"
						? ("failed" as const)
						: existing.status === "PENDING" &&
								!existing.temporalRunId
							? ("unconfirmed" as const)
							: ("started" as const);
				return {
					execution: existing,
					temporalWorkflowId: existing.temporalRunId,
					status,
					outcome: status,
					deduplicated: true as const,
				};
			}
			execution = result.execution;
		} else {
			const reservation = await createExecutionWithinConcurrencyCap({
				userId: user.id,
				organizationId,
				data: {
					workflowId: input.id,
					version: workflow.version,
					triggerType: "MANUAL",
					triggerInput: triggerInput as Prisma.InputJsonValue,
				},
			});
			if (!reservation.allowed) {
				throw new ORPCError("TOO_MANY_REQUESTS", {
					message: concurrencyRefusalMessage(reservation),
				});
			}
			execution = reservation.execution;
		}

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
				// Pass current nodes/edges if provided (unsaved changes). The
				// schema bounds their size and count, not their shape; the
				// validator above has already refused a malformed graph.
				nodes: input.nodes as StartWorkflowBuilderExecutionInput["nodes"],
				edges: input.edges as StartWorkflowBuilderExecutionInput["edges"],
			});

			if (outcome.status === "confirmed") {
				// The run exists in the engine from here on. A failure to
				// persist that fact must not be reported as "not started" —
				// a retry would start a second run with the same side
				// effects — so it is logged and the start is still reported.
				// The workflow writes its own status as it progresses, and
				// its id is deterministic from the execution id.
				// PENDING → RUNNING only: a fast run may already have
				// written its terminal status, which must not move back. If
				// this write fails the row keeps its idempotency key, so a
				// same-key retry still finds this run rather than starting
				// another.
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
				// active — and, with it, the idempotency key stays claimed:
				// failing the row would release the key, and the same-key
				// retry would then create a new row and a second run with
				// the same side effects.
				console.warn(
					"Workflow start unconfirmed; leaving the execution row active:",
					{
						executionId: execution.id,
						workflowId: outcome.workflowId,
					},
					outcome.error,
				);
				// Resolved, not thrown: an error reads as "retry", and the
				// editor treats an unconfirmed result as a run to follow,
				// keeping its idempotency key for any retry.
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
		// the caller. This is the one write that releases an idempotency key,
		// in the same statement as the FAILED status, and it happens only on
		// that confirmation: any other FAILED row keeps its key.
		const failedAt = new Date();
		const releasedTriggerInput = releasedIdempotencyTriggerInput(
			execution.triggerInput,
		);
		await db.workflowExecution.update({
			where: { id: execution.id },
			data: {
				status: "FAILED",
				error: failure,
				completedAt: failedAt,
				duration: failedAt.getTime() - execution.startedAt.getTime(),
				...(releasedTriggerInput
					? { triggerInput: releasedTriggerInput }
					: {}),
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
