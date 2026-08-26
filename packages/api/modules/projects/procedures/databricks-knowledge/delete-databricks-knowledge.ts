/**
 * Disconnect the project's Databricks Vector Search knowledge binding.
 * Freely reconnectable — nothing here replaces existing data, so there is
 * no lock-in and no confirmation ceremony beyond the settings-edit gate.
 */

import { db, deleteProjectDatabricksKnowledgeBinding } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const deleteProjectDatabricksKnowledgeProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
		.route({
			method: "DELETE",
			path: "/projects/:projectId/databricks-knowledge",
			tags: ["Projects", "Knowledge"],
			summary: "Delete Databricks knowledge binding",
			description:
				"Disconnect the project's Databricks Vector Search knowledge binding",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			// Authorization is the requireProjectPermission middleware ALONE —
			// it resolves effective permissions including org admins/owners
			// who have no explicit ProjectMember row on this project. Do NOT
			// re-check with the legacy hasProjectAccess helper: it doesn't
			// recognize the org-role path and would deny exactly those admins.
			const deleted = await deleteProjectDatabricksKnowledgeBinding({
				projectId: input.projectId,
			});

			if (deleted) {
				const project = await db.project.findUnique({
					where: { id: input.projectId },
					select: { organizationId: true },
				});
				recordAuditFromRequest(context, {
					action: "project.databricks_knowledge.disconnected",
					category: "project",
					severity: "info",
					outcome: "success",
					projectId: input.projectId,
					organizationId: project?.organizationId ?? null,
					resource: {
						type: "project_databricks_knowledge_binding",
						id: deleted.id,
					},
					metadata: { integrationId: deleted.integrationId },
				});
			}

			return { deleted: !!deleted };
		});
