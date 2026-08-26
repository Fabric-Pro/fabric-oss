import { ORPCError } from "@orpc/server";
import {
	hasProjectAccess,
	moveWizardTempContextsToProject,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const moveToProjectProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/wizard/temp-contexts/move-to-project",
		tags: ["Wizard", "Temp Contexts"],
		summary: "Move temp contexts to project",
		description:
			"Move all temp contexts from a wizard session to a created project",
	})
	.input(
		z.object({
			sessionId: z.string().min(1, "Session ID is required"),
			projectId: z.string().min(1, "Project ID is required"),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { sessionId, projectId, organizationId } = input;
		const user = context.user;

		// Verify user has access to the project
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Move temp contexts to project
		const result = await moveWizardTempContextsToProject(
			sessionId,
			projectId,
			user.id,
			organizationId ?? undefined,
		);

		// If contexts were migrated and have embeddings, bind them to the project
		if (
			result.movedCount > 0 &&
			Object.keys(result.contextIdMapping).length > 0
		) {
			try {
				const temporalClient = await getTemporalClient();

				// Trigger the binding workflow to update Qdrant payloads
				await temporalClient.workflow.start(
					"wizardToProjectBindingWorkflow" as any,
					withCorrelationMemo({
						taskQueue: "project-documents",
						workflowId: `wizard-binding-move-${projectId}-${Date.now()}`,
						args: [
							{
								sessionId: result.sessionId,
								projectId,
								contextIdMapping: result.contextIdMapping,
								userId: user.id,
								organizationId: organizationId ?? undefined,
							},
						],
					}),
				);

				console.log(
					`[MoveToProject] Triggered embedding binding for ${result.movedCount} contexts to project ${projectId}`,
				);
			} catch (bindingError) {
				// Log but don't fail - the embeddings can still be queried until binding completes
				console.error(
					"[MoveToProject] Failed to trigger embedding binding:",
					bindingError,
				);
			}
		}

		return {
			success: true,
			movedCount: result.movedCount,
			contextIds: result.contextIds,
		};
	});
