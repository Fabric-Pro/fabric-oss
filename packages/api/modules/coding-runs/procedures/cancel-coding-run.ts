import {
	type CodingRunActor,
	requireCodingRunProject,
} from "../lib/commands-access";
import {
	remoteServerConnectionId,
	requireRemoteServerAccess,
} from "../lib/remote-server-access";
/**
 * Cancel Coding Run Procedure
 *
 * AUTHORIZATION: Org-level AGENT_DELETE via middleware, PLUS a project-level
 * STORY_UPDATE check inside the handler (the input has only the run id, so
 * the project-scoped middleware can't gate this — resolve the projectId
 * after loading the run and check manually).
 */

import { ORPCError } from "@orpc/client";
import {
	canEditProject,
	getCodingRun,
	updateCodingRunStatus,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { codingRunWorkflowId } from "../lib/workflow-id";

export const codingRunIdentityInput = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const cancelCodingRunProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_DELETE))
	.route({
		method: "POST",
		path: "/coding-runs/{id}/cancel",
		tags: ["CodingRuns"],
		summary: "Cancel an active coding run",
	})
	.input(codingRunIdentityInput)
	.output(
		z.object({
			status: z.string(),
		}),
	)
	.handler(async ({ input, context }) =>
		cancelCodingRun(
			{
				userId: context.user.id,
				organizationId: resolveOrganizationId(
					input.organizationId,
					context.session,
				),
			},
			input,
		),
	);

export async function cancelCodingRun(
	actor: CodingRunActor,
	input: z.infer<typeof codingRunIdentityInput>,
) {
	const user = { id: actor.userId };
	const organizationId = actor.organizationId ?? undefined;

	const run = await getCodingRun(input.id, user.id, organizationId);
	if (!run) {
		throw new ORPCError("NOT_FOUND", {
			message: "Coding run not found",
		});
	}
	await requireCodingRunProject(
		actor,
		run.projectId,
		Permissions.AGENT_DELETE,
		true,
	);

	// Project-level authorization uses the same effective write permission as start.
	// Only callers with STORY_UPDATE
	// on this specific project can cancel runs on it. Middleware above
	// already confirmed AGENT_DELETE at the org level.
	if (!(await canEditProject(run.projectId, user.id))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have permission to manage this coding run",
		});
	}

	const connectionId = remoteServerConnectionId(run.providerMetadata);
	if (connectionId) {
		await requireRemoteServerAccess({
			id: connectionId,
			projectId: run.projectId,
			userId: actor.userId,
			allowDisabled: true,
		});
	}

	// Only cancel if in an active state
	if (
		![
			"QUEUED",
			"STARTING",
			"RUNNING",
			"AWAITING_REVIEW",
			"PR_OPENED",
		].includes(run.status)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Cannot cancel a coding run with status: ${run.status}`,
		});
	}

	if (
		run.provider === "BACKGROUND_AGENTS" &&
		(run.providerMetadata as Record<string, unknown> | null)
			?.executionRuntime === "fabric-agent-server"
	) {
		const { isFabricAgentsBridgeEnabled } = await import(
			"@repo/temporal/coding-execution-rollout"
		);
		if (!isFabricAgentsBridgeEnabled()) {
			throw new ORPCError("CONFLICT", {
				message:
					"Restore the native execution mode before cancelling this run",
			});
		}
	}
	if (
		run.provider === "BACKGROUND_AGENTS" &&
		run.providerSessionId &&
		(run.providerMetadata as Record<string, unknown> | null)
			?.executionRuntime === "fabric-agent-server"
	) {
		const { isFabricAgentsBridgeEnabled } = await import(
			"@repo/temporal/coding-execution-rollout"
		);
		if (!isFabricAgentsBridgeEnabled()) {
			throw new ORPCError("CONFLICT", {
				message:
					"Restore this run's native execution configuration before cancelling it",
			});
		}
		const { getCodingExecutionProvider } = await import(
			"@repo/temporal/coding-execution"
		);
		// A signal ACK is not a remote stop ACK. Preserve the active row on unknown outcomes.
		await getCodingExecutionProvider(
			run.provider,
			run.providerMetadata,
		).cancelSession(run.providerSessionId);
	}

	// Signal the Temporal workflow to cancel. The workflow id is
	// deterministic, so an empty column only means post-start bookkeeping
	// failed, not that no execution exists: always address the derived id
	// and let Temporal say whether anything is there.
	const workflowId = run.workflowId ?? codingRunWorkflowId(run.id);
	let signalDelivered = false;
	try {
		const temporal = await getTemporalClient();
		const handle = temporal.workflow.getHandle(workflowId);
		await handle.signal("cancelCodingRun");
		signalDelivered = true;
	} catch (error) {
		// WorkflowNotFoundError means it's already done — safe to mark cancelled.
		// Any other error (e.g. Temporal unavailable) means the agent may still
		// be running, so surface it rather than silently marking cancelled.
		const isNotFound =
			error instanceof Error && error.name === "WorkflowNotFoundError";
		if (!isNotFound) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to cancel workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	}

	if (run.provider === "BACKGROUND_AGENTS" && !run.providerSessionId) {
		const { isFabricAgentsBridgeEnabled } = await import(
			"@repo/temporal/coding-execution-rollout"
		);
		if (isFabricAgentsBridgeEnabled()) {
			if (!signalDelivered) {
				throw new ORPCError("CONFLICT", {
					message:
						"The workflow is unavailable and native session creation has no confirmed outcome. Reconcile work on the original server before starting another run.",
				});
			}
			return { status: "cancelling" };
		}
	}

	await updateCodingRunStatus(run.id, "CANCELLED");

	return { status: "cancelled" };
}
