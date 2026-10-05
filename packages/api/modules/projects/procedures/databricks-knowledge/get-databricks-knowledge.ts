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
import { resolveProjectOrganizationId } from "../../lib/project-organization";

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

		// The lookup below scopes the project by this organization, so it must
		// be the project's own — a caller-named one would either miss the row
		// or, for `null`, select the personal arm and miss an organization
		// project. A different input organization is refused.
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);

		const binding = await getProjectDatabricksKnowledgeBinding({
			projectId: input.projectId,
			userId: user.id,
			organizationId,
		});

		return { binding };
	});
