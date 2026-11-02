import { ORPCError } from "@orpc/client";
import {
	canEditProject,
	db,
	getCodingRun,
	recordAuditTx,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	remoteServerConnectionId,
	requireRemoteServerAccess,
} from "../lib/remote-server-access";
import { codingRunWorkflowId } from "../lib/workflow-id";

const unknownOutcomeEvents = [
	"cancellation_unknown",
	"continuation_recovery_required",
];
const warning =
	"Check the original server for an orphaned session and stop it before starting another run. Closing this record does not stop remote work.";

export const recoverCodingRunProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_DELETE))
	.route({
		method: "POST",
		path: "/coding-runs/{id}/recover",
		tags: ["CodingRuns"],
		summary: "Close a coding run with an unknown remote outcome",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			confirmOrphanCheck: z.literal(true),
		}),
	)
	.output(z.object({ status: z.literal("failed"), warning: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const run = await getCodingRun(
			input.id,
			context.user.id,
			organizationId,
		);
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Coding run not found",
			});
		}
		if (!(await canEditProject(run.projectId, context.user.id))) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to manage this coding run",
			});
		}
		const connectionId = remoteServerConnectionId(run.providerMetadata);
		if (connectionId) {
			await requireRemoteServerAccess({
				id: connectionId,
				projectId: run.projectId,
				userId: context.user.id,
				allowDisabled: true,
			});
		}
		if (
			run.status !== "AWAITING_REVIEW" ||
			!run.events.some((event) =>
				unknownOutcomeEvents.includes(event.eventType),
			)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Only a coding run awaiting unknown-outcome recovery can be closed",
			});
		}
		try {
			const temporal = await getTemporalClient();
			const description = await temporal.workflow
				.getHandle(run.workflowId ?? codingRunWorkflowId(run.id))
				.describe();
			if (description.status.name === "RUNNING") {
				throw new ORPCError("CONFLICT", {
					message:
						"The workflow is still running. Wait for it to close before recovering this run.",
				});
			}
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.name !== "WorkflowNotFoundError"
			) {
				throw error;
			}
		}

		await db.$transaction(async (tx) => {
			const updated = await tx.codingRun.updateMany({
				where: {
					id: run.id,
					organizationId,
					status: "AWAITING_REVIEW",
					workflowId: run.workflowId,
					events: {
						some: { eventType: { in: unknownOutcomeEvents } },
					},
				},
				data: {
					status: "FAILED",
					lastError: `Manually closed after an unknown remote outcome. ${warning}`,
				},
			});
			if (updated.count !== 1) {
				throw new ORPCError("CONFLICT", {
					message:
						"The coding run changed; refresh before recovering it",
				});
			}
			await tx.codingRunEvent.create({
				data: {
					codingRunId: run.id,
					eventType: "recovery_closed",
					payloadJson: { warning, authorId: context.user.id },
				},
			});
			await recordAuditTx(tx, {
				action: "weave.session.recovery_closed",
				category: "weave",
				severity: "warning",
				actor: { type: "user", userId: context.user.id },
				organizationId,
				projectId: run.projectId,
				resource: { type: "coding_run", id: run.id },
				metadata: {
					workflowId: run.workflowId,
					orphanCheckAcknowledged: true,
				},
			});
		});
		return { status: "failed" as const, warning };
	});
