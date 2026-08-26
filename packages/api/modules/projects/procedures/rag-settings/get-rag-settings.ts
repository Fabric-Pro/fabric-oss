import { ORPCError } from "@orpc/server";
import { getProjectRagSettings, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getRagSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/rag-settings",
		tags: ["Projects", "RAG"],
		summary: "Get RAG settings",
		description: "Get the RAG settings for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId } = input;
		const user = context.user;

		// Check project access
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

		const settings = await getProjectRagSettings(projectId);

		// Code indexing only runs when the deployment opts in. The toggle is
		// independent of the flag, so the UI needs to know when a user has
		// enabled code search but the server-side workflow won't actually
		// index anything (FEATURE_CODE_INDEXING off).
		const featureCodeIndexingEnabled =
			process.env.FEATURE_CODE_INDEXING === "true";

		return { settings, featureCodeIndexingEnabled };
	});
