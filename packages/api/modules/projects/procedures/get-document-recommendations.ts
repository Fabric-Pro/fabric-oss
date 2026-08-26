import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { recommendDocuments } from "../utils/document-recommendations";

/**
 * Get AI-powered document recommendations for a project
 *
 * This endpoint analyzes the project's characteristics and suggests
 * relevant document types with custom prompts
 */
export const getDocumentRecommendationsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/document-recommendations",
		tags: ["Projects", "Documents"],
		summary: "Get AI-powered document recommendations for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId } = input;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify user has access to the project (checks org membership + project access)
		const canAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Get project data
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				id: true,
				name: true,
				description: true,
				goals: true,
				projectTypes: true,
				techStack: true,
				features: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Generate recommendations
		const recommendations = recommendDocuments({
			name: project.name,
			description: project.description || undefined,
			goals: project.goals || undefined,
			projectTypes:
				project.projectTypes.length > 0
					? project.projectTypes
					: undefined,
			techStack: project.techStack,
			features: project.features,
		});

		return {
			projectId: project.id,
			projectName: project.name,
			recommendations,
		};
	});
