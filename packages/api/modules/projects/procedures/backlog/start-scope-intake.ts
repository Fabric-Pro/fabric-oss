import { ORPCError } from "@orpc/server";
import { getContextById } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Deterministic workflow id: one intake per context at a time. */
export function scopeIntakeWorkflowId(contextId: string): string {
	return `scope-intake-${contextId}`;
}

/**
 * Start the scope-intake workflow for an uploaded customer document
 * (plan §Slice 1). Nothing is written to the backlog: the workflow produces a
 * `SCOPE_DOCUMENT` PendingBacklogProposal for the review inbox.
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)`. The context must
 * belong to the project AND the caller's tenant (XOR filter via
 * `getContextById(contextId, projectId, tenant)`); anything else is
 * NOT_FOUND so ids from other tenants are indistinguishable from missing.
 *
 * Idempotent: `WorkflowExecutionAlreadyStartedError` is treated as success.
 */
export const startScopeIntakeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/scope-intake",
		tags: ["Projects", "Backlog"],
		summary: "Extract scope items from a document",
		description:
			"Starts the scope intake workflow that turns an extracted customer document into a reviewable backlog proposal.",
	})
	.input(
		z.object({
			projectId: z.string(),
			contextId: z.string(),
			organizationId: z.string().nullable().optional(),
			hints: z.string().max(2000).optional(),
		}),
	)
	.output(
		z.object({
			success: z.literal(true),
			workflowId: z.string(),
			contextId: z.string(),
			alreadyRunning: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			context.user.id,
		);

		const projectContext = await getContextById(
			input.contextId,
			input.projectId,
			{ userId: user.id, organizationId: organizationId ?? null },
		);
		if (!projectContext || projectContext.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Context not found in this project",
			});
		}

		if (projectContext.extractionStatus === "FAILED") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Text extraction failed for this document. Re-upload it before extracting scope.",
			});
		}

		const workflowId = scopeIntakeWorkflowId(input.contextId);

		try {
			const client = await getTemporalClient();
			await client.workflow.start("scopeIntakeWorkflow", {
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						contextId: input.contextId,
						userId: user.id,
						organizationId:
							organizationId ??
							projectContext.organizationId ??
							undefined,
						hints: input.hints,
					},
				],
			});
			logger.info(
				`[StartScopeIntake] Started ${workflowId} for project ${input.projectId}`,
			);
			return {
				success: true as const,
				workflowId,
				contextId: input.contextId,
				alreadyRunning: false,
				message: "Scope extraction started",
			};
		} catch (error) {
			const isAlreadyStarted =
				error instanceof Error &&
				(error.name === "WorkflowExecutionAlreadyStartedError" ||
					error.message?.includes("already started") ||
					error.message?.includes("already exists"));
			if (isAlreadyStarted) {
				logger.info(
					`[StartScopeIntake] ${workflowId} already running, returning existing`,
				);
				return {
					success: true as const,
					workflowId,
					contextId: input.contextId,
					alreadyRunning: true,
					message: "Scope extraction already in progress",
				};
			}
			logger.error(
				`[StartScopeIntake] Failed to start ${workflowId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start scope extraction",
			});
		}
	});
