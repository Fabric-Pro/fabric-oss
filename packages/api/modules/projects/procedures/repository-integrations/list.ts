/**
 * List Repository Integrations
 *
 * Returns all project-level repository integrations for a project.
 * Accessible to all project members (OWNER, EDITOR, VIEWER).
 * Never returns encrypted credential fields.
 */

import { ORPCError } from "@orpc/client";
import {
	getProjectCodeIndexes,
	hasProjectAccess,
	listProjectRepoIntegrations,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listRepoIntegrationsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/repository-integrations",
		tags: ["Projects", "Repository Integrations"],
		summary: "List repository integrations for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
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

		const [integrations, codeIndexes] = await Promise.all([
			listProjectRepoIntegrations(input.projectId),
			getProjectCodeIndexes(input.projectId),
		]);

		// Attach each repo's per-repo code-index status (for the Settings badge +
		// Re-index/Cancel controls). Never returns the raw index error string.
		// Flag whether the project carries any legacy/unlinked index record (repositoryIntegrationId is null)
		// so the UI never falsely attributes legacy project-level index data to un-indexed repos.
		const hasLegacyIndexRecord = codeIndexes.some(
			(index) => !index.repositoryIntegrationId,
		);

		const indexByIntegration = new Map(
			codeIndexes
				.filter(
					(
						index,
					): index is typeof index & {
						repositoryIntegrationId: string;
					} => index.repositoryIntegrationId !== null,
				)
				.map((index) => [index.repositoryIntegrationId, index]),
		);

		const integrationsWithIndex = integrations.map((integration) => {
			const index = indexByIntegration.get(integration.id) ?? null;
			return {
				...integration,
				codeIndex: index
					? {
							status: index.status,
							branch: index.branch,
							commitSha: index.commitSha,
							indexedAt: index.indexedAt,
							filesIndexed: index.filesIndexed,
							chunksCreated: index.chunksCreated,
							indexedFileCount: index.indexedFileCount,
							totalFileCount: index.totalFileCount,
							lastFullIndexAt: index.lastFullIndexAt,
							lastIncrementalAt: index.lastIncrementalAt,
						}
					: null,
			};
		});

		return {
			integrations: integrationsWithIndex,
			hasLegacyIndexRecord,
		};
	});
