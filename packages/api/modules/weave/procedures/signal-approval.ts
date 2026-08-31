/**
 * Signal Approval Procedure
 *
 * Sends an approval/rejection signal to the Fabric Loom workflow
 * for a weave execution checkpoint.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import {
	orchestratorApprovalSignal,
	orchestratorAutoApproveAllSignal,
	orchestratorRetryFromStepSignal,
	orchestratorRevokeAutoApproveSignal,
} from "@repo/temporal/workflows";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	protectedProcedure,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

const SignalApprovalInputSchema = z.object({
	executionId: z.string(),
	organizationId: z.string().nullable().optional(),
	approved: z.boolean(),
	feedback: z.string().optional(),
	// Accepted for UI compatibility but looked up from DB for security
	workflowId: z.string().optional(),
	runId: z.string().optional(),
});

export const signalApprovalProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/executions/:executionId/signal",
		tags: ["Weave"],
		summary: "Signal approval for checkpoint",
	})
	.input(SignalApprovalInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const execution = await db.weaveExecution.findFirst({
			where: {
				id: input.executionId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found or access denied",
			});
		}

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names an execution, so
		// the project is only known here.
		await assertProjectPermission(
			execution.projectId,
			userId,
			Permissions.AGENT_UPDATE,
		);

		if (execution.status !== "CHECKPOINT") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot signal execution in status: ${execution.status}`,
			});
		}

		try {
			const temporal = await getTemporalClient();
			const handle = temporal.workflow.getHandle(
				execution.workflowId,
				execution.runId,
			);

			await handle.signal(orchestratorApprovalSignal, {
				approved: input.approved,
				feedback: input.feedback,
			});
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to signal workflow: ${error instanceof Error ? error.message : "Workflow may have already completed"}`,
			});
		}

		return {
			success: true,
			message: `Signal sent: ${input.approved ? "approved" : "rejected"}`,
		};
	});

const AutoApproveAllInputSchema = z.object({
	executionId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const autoApproveAllProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/executions/:executionId/auto-approve",
		tags: ["Weave"],
		summary: "Auto-approve all checkpoints for this execution",
	})
	.input(AutoApproveAllInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const execution = await db.weaveExecution.findFirst({
			where: {
				id: input.executionId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found or access denied",
			});
		}

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names an execution, so
		// the project is only known here.
		await assertProjectPermission(
			execution.projectId,
			userId,
			Permissions.AGENT_UPDATE,
		);

		const activeStatuses = ["RUNNING", "PAUSED", "CHECKPOINT"];
		if (!activeStatuses.includes(execution.status)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot auto-approve execution in status: ${execution.status}`,
			});
		}

		try {
			const temporal = await getTemporalClient();
			const handle = temporal.workflow.getHandle(
				execution.workflowId,
				execution.runId,
			);

			await handle.signal(orchestratorAutoApproveAllSignal);
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to signal workflow: ${error instanceof Error ? error.message : "Workflow may have already completed"}`,
			});
		}

		return { success: true, message: "Auto-approve-all enabled" };
	});

const RevokeAutoApproveInputSchema = z.object({
	executionId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const revokeAutoApproveProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/executions/:executionId/revoke-auto-approve",
		tags: ["Weave"],
		summary:
			"Revoke auto-approve, restoring human review for future checkpoints",
	})
	.input(RevokeAutoApproveInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const execution = await db.weaveExecution.findFirst({
			where: {
				id: input.executionId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found or access denied",
			});
		}

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names an execution, so
		// the project is only known here.
		await assertProjectPermission(
			execution.projectId,
			userId,
			Permissions.AGENT_UPDATE,
		);

		const activeStatuses = ["RUNNING", "PAUSED", "CHECKPOINT"];
		if (!activeStatuses.includes(execution.status)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot revoke auto-approve for execution in status: ${execution.status}`,
			});
		}

		try {
			const temporal = await getTemporalClient();
			const handle = temporal.workflow.getHandle(
				execution.workflowId,
				execution.runId,
			);

			await handle.signal(orchestratorRevokeAutoApproveSignal);
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to signal workflow: ${error instanceof Error ? error.message : "Workflow may have already completed"}`,
			});
		}

		return {
			success: true,
			message:
				"Auto-approve revoked — future checkpoints will require review",
		};
	});

const RetryFromStepInputSchema = z.object({
	executionId: z.string(),
	stepId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const retryFromStepProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/executions/:executionId/retry-from-step",
		tags: ["Weave"],
		summary: "Retry execution from a specific failed step",
	})
	.input(RetryFromStepInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const execution = await db.weaveExecution.findFirst({
			where: {
				id: input.executionId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found or access denied",
			});
		}

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names an execution, so
		// the project is only known here.
		await assertProjectPermission(
			execution.projectId,
			userId,
			Permissions.AGENT_UPDATE,
		);

		if (
			!["RUNNING", "PAUSED", "CHECKPOINT", "FAILED"].includes(
				execution.status,
			)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot retry steps for execution in status: ${execution.status}`,
			});
		}

		try {
			const temporal = await getTemporalClient();
			const handle = temporal.workflow.getHandle(
				execution.workflowId,
				execution.runId,
			);

			await handle.signal(orchestratorRetryFromStepSignal, {
				stepId: input.stepId,
			});
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to signal workflow: ${error instanceof Error ? error.message : "Workflow may have already completed"}`,
			});
		}

		return {
			success: true,
			message:
				"Retry signal sent — execution will resume from the specified step",
		};
	});
