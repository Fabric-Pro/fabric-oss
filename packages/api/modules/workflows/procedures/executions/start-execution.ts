import { z } from "zod";
import {
	enforceWorkflowRateLimit,
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	boundedInlineGraphSchema,
	boundedJsonRecord,
	EXECUTION_INPUT_BOUNDS,
} from "../../lib/execution-input-bounds";
import type { StartWorkflowBuilderExecutionInput } from "../../lib/start-builder-execution";
import { startWorkflowExecutionCommand } from "../../lib/workflow-execution-commands";
import { workflowActor, workflowCommandErrors } from "../workflow-actor";

export const startWorkflowExecutionProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
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
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const outcome = await startWorkflowExecutionCommand(
			workflowActor(context.user.id, organizationId),
			{
				workflowId: input.id,
				triggerData: input.triggerData,
				variables: input.variables,
				idempotencyKey: input.idempotencyKey,
				nodes: input.nodes as StartWorkflowBuilderExecutionInput["nodes"],
				edges: input.edges as StartWorkflowBuilderExecutionInput["edges"],
			},
		);
		return {
			execution: outcome.execution,
			temporalWorkflowId: outcome.temporalWorkflowId,
			status: outcome.status,
			outcome: outcome.status,
			...(outcome.message ? { message: outcome.message } : {}),
			...(outcome.deduplicated ? { deduplicated: true as const } : {}),
		};
	});
