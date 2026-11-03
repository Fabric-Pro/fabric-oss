/**
 * Include or leave out one repository from AI code search
 *
 * Whether the project's code tools (live or RAG, per its code search mode)
 * read and index this repository (spec 2026-10-29 code-index-sync §6a).
 * Leaving one out cancels its in-flight indexing and keeps its index points,
 * which search no longer reads; including it again under RAG indexes it when
 * it has no usable index. PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT).
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
import {
	cancelCodeIndexingForRepo,
	startCodeIndexingForUnindexedRepos,
} from "../../lib/code-indexing-trigger";

export const updateRepoCodeSearchInclusionProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/repository-integrations/:integrationId/code-search",
		tags: ["Projects", "Repository Integrations"],
		summary: "Include or leave out a repository from AI code search",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			integrationId: z.string().min(1),
			organizationId: z.string().nullable().optional(),
			included: z.boolean(),
		}),
	)
	.output(
		z.object({
			integration: z.object({
				id: z.string(),
				includedInCodeSearch: z.boolean(),
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

		const updated = await db.projectRepositoryIntegration.update({
			where: { id: input.integrationId },
			data: { includedInCodeSearch: input.included },
			select: { id: true, includedInCodeSearch: true },
		});

		if (integration.includedInCodeSearch !== input.included) {
			try {
				if (input.included) {
					const settings = await db.projectRagSettings.findUnique({
						where: { projectId: input.projectId },
						select: { codeSearchMode: true },
					});
					if (settings?.codeSearchMode === "RAG") {
						await startCodeIndexingForUnindexedRepos({
							projectId: input.projectId,
							userId: user.id,
							organizationId,
							repositoryIntegrationId: integration.id,
						});
					}
				} else {
					await cancelCodeIndexingForRepo({
						projectId: input.projectId,
						repositoryIntegrationId: integration.id,
					});
				}
			} catch (error) {
				// The setting is saved; indexing follows at the next trigger.
				console.error(
					"[update-code-search-inclusion] Indexing follow-up failed:",
					error instanceof Error ? error.name : typeof error,
				);
			}
		}

		const repositoryName = `${integration.repositoryOwner}/${integration.repositoryName}`;
		await logRepoIntegrationActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || "Unknown",
			organizationId,
			activityType: "repo_integration_configured",
			integrationId: integration.id,
			repositoryName,
			metadata: {
				action: "update_code_search_inclusion",
				previousIncluded: integration.includedInCodeSearch,
				included: input.included,
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
				name: repositoryName,
			},
			metadata: {
				previousIncludedInCodeSearch: integration.includedInCodeSearch,
				includedInCodeSearch: input.included,
			},
		});

		return { integration: updated };
	});
