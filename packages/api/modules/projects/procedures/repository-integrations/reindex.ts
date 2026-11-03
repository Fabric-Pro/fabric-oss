/**
 * Re-index Repository Integration
 *
 * Manually (re)starts Phase 2 code indexing for one connected repository, in one
 * of two modes:
 *   - "incremental" — the fast, diff-only update: compare the indexed commit to
 *     the current branch HEAD (all providers), then re-embed only the changed
 *     files. Falls back to a full index when there's no baseline to diff from, or
 *     the compare fails / is capped.
 *   - "full" — the dangerous, expensive rebuild: re-embed the entire repository.
 *
 * PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT). Refused unless the project's code
 * search mode is RAG (enforced inside the shared trigger) and the repository is
 * included in code search.
 */

import { ORPCError } from "@orpc/client";
import { getProjectRepoIntegration } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { planIncrementalReindex } from "../../lib/code-index-refresh";
import { startCodeIndexingForProject } from "../../lib/code-indexing-trigger";

export const reindexRepoIntegrationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/repository-integrations/:integrationId/reindex",
		tags: ["Projects", "Repository Integrations", "Code Indexing"],
		summary: "Re-index a connected repository",
	})
	.input(
		z.object({
			projectId: z.string(),
			integrationId: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * "incremental" re-embeds only the changed files (fast, cheap);
			 * "full" rebuilds the whole index (expensive, consumes embedding
			 * credits). Defaults to "full" for backward compatibility.
			 */
			mode: z.enum(["incremental", "full"]).default("full"),
		}),
	)
	.handler(async ({ input, context }) => {
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
		if (!integration.includedInCodeSearch) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Include this repository in AI code search before indexing it",
			});
		}

		let incremental = false;
		let changedFiles: string[] | undefined;
		let fellBackToFull = false;

		if (input.mode === "incremental") {
			const plan = await planIncrementalReindex({
				projectId: input.projectId,
				integrationId: input.integrationId,
				repo: integration,
				userId: context.user.id,
				organizationId,
			});
			if (plan.kind === "up-to-date") {
				// Nothing to pull in — don't start a run.
				return {
					success: true,
					started: 0,
					upToDate: true,
					fellBackToFull: false,
				};
			}
			if (plan.kind === "incremental") {
				incremental = true;
				changedFiles = plan.changedFiles;
			} else {
				fellBackToFull = true;
			}
		}

		const result = await startCodeIndexingForProject({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			repositoryIntegrationId: input.integrationId,
			incremental,
			changedFiles,
		});

		if (result.disabledReason) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Set this project's code search to RAG before indexing",
			});
		}

		if (result.started === 0) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"No usable credentials for this repository — reconnect it and try again",
			});
		}

		return {
			success: true,
			started: result.started,
			upToDate: false,
			fellBackToFull,
		};
	});
