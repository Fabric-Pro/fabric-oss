/**
 * Get Repository Integration Health Status
 *
 * Returns the health status of a specific integration.
 * Accessible to all project members (OWNER, EDITOR, VIEWER).
 */

import { ORPCError } from "@orpc/client";
import { getProjectRepoIntegration, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const repoIntegrationHealthProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "GET",
		path: "/projects/:projectId/repository-integrations/:integrationId/health",
		tags: ["Projects", "Repository Integrations"],
		summary: "Get health status of a repository integration",
	})
	.input(
		z.object({
			projectId: z.string(),
			integrationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const integration = await getProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);
		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository integration not found",
			});
		}

		return {
			status: integration.status,
			lastHealthCheck: integration.lastHealthCheck?.toISOString() ?? null,
			lastError: integration.lastError,
			provider: integration.provider,
			repositoryName: `${integration.repositoryOwner}/${integration.repositoryName}`,
		};
	});
