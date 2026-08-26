/**
 * Get the project's Databricks Vector Search knowledge binding (if any),
 * for the Project Settings > Knowledge section.
 */

import { getProjectDatabricksKnowledgeBinding } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getProjectDatabricksKnowledgeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/databricks-knowledge",
		tags: ["Projects", "Knowledge"],
		summary: "Get Databricks knowledge binding",
		description:
			"Get the project's Databricks Vector Search knowledge binding",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Authorization is the requireProjectPermission middleware ALONE — it
		// resolves effective permissions including org admins/owners who have
		// no explicit ProjectMember row on this project. Do NOT re-check with
		// the legacy hasProjectAccess helper: it doesn't recognize the
		// org-role path and would deny exactly those admins.
		const user = context.user;

		const binding = await getProjectDatabricksKnowledgeBinding({
			projectId: input.projectId,
			userId: user.id,
			organizationId: input.organizationId ?? undefined,
		});

		return { binding };
	});
