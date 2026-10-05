import { moveWizardTempContextsToProject } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../projects/lib/project-organization";

export const moveToProjectProcedure = tenantProtectedProcedure
	// The contexts become the DESTINATION project's, so the caller must be
	// able to add context to that project — the permission creating one
	// directly requires (`contexts/create-context.ts`). A project the caller
	// can only view is refused; so is an organization other than the
	// project's, before the handler runs.
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
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
		const { sessionId, projectId } = input;
		const user = context.user;

		// Always the authorized project's organization — whatever was named,
		// or nothing — for the temp-context lookup, the move and the binding
		// workflow. A project with no organization is refused (ADR-018).
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			projectId,
		);

		// Move temp contexts to project
		const result = await moveWizardTempContextsToProject(
			sessionId,
			projectId,
			user.id,
			organizationId,
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
								organizationId,
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
