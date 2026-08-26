/**
 * Update Repository Integration Role Tag
 *
 * Updates the custom role tag/label (e.g. "Legacy", "New", "V1 Reference") of a
 * project-level repository integration. PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT).
 */

import { ORPCError } from "@orpc/client";
import {
	db,
	getProjectRepoIntegration,
	logRepoIntegrationActivity,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const updateRepoIntegrationTagProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/repository-integrations/:integrationId/tag",
		tags: ["Projects", "Repository Integrations"],
		summary: "Update the role tag of a repository integration",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			integrationId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			roleTag: z
				.string()
				.trim()
				.max(50)
				.regex(/^(?!.*---)[a-zA-Z0-9_\-./ ]+$/, {
					message:
						"Role tag can only contain letters, numbers, spaces, hyphens, underscores, dots, and slashes (and cannot contain '---')",
				})
				.nullable()
				.optional(),
			expectedPreviousRoleTag: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			integration: z.object({
				id: z.string(),
				roleTag: z.string().nullable(),
			}),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const integration = await getProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);

		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository integration not found",
			});
		}

		if (
			input.expectedPreviousRoleTag !== undefined &&
			integration.roleTag !== input.expectedPreviousRoleTag
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"The repository role tag was modified by another user. Please refresh and try again.",
			});
		}

		const newRoleTag = input.roleTag?.trim() || null;

		if (newRoleTag) {
			const duplicate = await db.projectRepositoryIntegration.findFirst({
				where: {
					projectId: input.projectId,
					id: { not: input.integrationId },
					roleTag: { equals: newRoleTag, mode: "insensitive" },
				},
				select: {
					id: true,
					repositoryOwner: true,
					repositoryName: true,
				},
			});

			if (duplicate) {
				throw new ORPCError("CONFLICT", {
					message: `The role tag "${newRoleTag}" is already assigned to ${duplicate.repositoryOwner}/${duplicate.repositoryName}`,
				});
			}
		}

		const updated = await db.projectRepositoryIntegration.update({
			where: { id: input.integrationId },
			data: { roleTag: newRoleTag },
			select: { id: true, roleTag: true },
		});

		await logRepoIntegrationActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || "Unknown",
			organizationId,
			activityType: "repo_integration_configured",
			integrationId: integration.id,
			repositoryName: `${integration.repositoryOwner}/${integration.repositoryName}`,
			metadata: {
				action: "update_role_tag",
				previousRoleTag: integration.roleTag,
				newRoleTag,
			},
		});

		recordAuditFromRequest(context, {
			action: "org.integration.updated",
			category: "org",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: integration.id,
				name: `${integration.repositoryOwner}/${integration.repositoryName}`,
			},
			metadata: {
				previousRoleTag: integration.roleTag,
				newRoleTag,
			},
		});

		return { integration: updated };
	});
