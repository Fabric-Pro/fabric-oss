import { ORPCError } from "@orpc/server";
import {
	getProjectRagSettings,
	hasProjectAccess,
	isFeatureEnabled,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../lib/project-organization";

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
		const { projectId } = input;
		const user = context.user;

		// Check project access
		const hasAccess = await hasProjectAccess(projectId, user.id);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const settings = await getProjectRagSettings(projectId);

		// Content-type chunking is offered only while its flag is on for the
		// project's organization (spec 2026-10-28 §8 step 1).
		const contentAwareChunkingEnabled = await isFeatureEnabled(
			"CONTENT_AWARE_CHUNKING",
			await resolveProjectOrganizationId(input.organizationId, projectId),
		);

		return {
			settings,
			contentAwareChunkingEnabled,
		};
	});
