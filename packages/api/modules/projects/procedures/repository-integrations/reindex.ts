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
 * PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT). No-op unless FEATURE_CODE_INDEXING
 * and the project's `codeSearchEnabled` RAG setting are on (enforced inside the
 * shared trigger).
 */

import { ORPCError } from "@orpc/client";
import {
	getProjectCodeIndexes,
	getProjectRepoIntegration,
} from "@repo/database";
import { resolveFreshRepoToken } from "@repo/integrations";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { startCodeIndexingForProject } from "../../lib/code-indexing-trigger";
import {
	compareIndexedCommitToHead,
	type RepoCompareRef,
} from "../../lib/repo-compare";

/** How a requested incremental re-index should actually run. */
type IncrementalPlan =
	| { kind: "up-to-date" }
	| { kind: "incremental"; changedFiles: string[] }
	| { kind: "full-fallback" };

/**
 * Decide how an incremental re-index should run for one repo: compute the changed
 * files from the indexed commit → branch HEAD, or fall back to a full index when
 * there is no baseline / the compare is unusable, or report already up to date.
 */
async function planIncrementalReindex(params: {
	projectId: string;
	integrationId: string;
	repo: RepoCompareRef;
	userId: string;
	organizationId: string | null | undefined;
}): Promise<IncrementalPlan> {
	const indexes = await getProjectCodeIndexes(params.projectId);
	const index = indexes
		.filter((i) => i.repositoryIntegrationId === params.integrationId)
		.sort(
			(a, b) =>
				(b.indexedAt?.getTime() ?? 0) - (a.indexedAt?.getTime() ?? 0),
		)[0];

	// Never fully indexed (no row, a placeholder commit, or no branch) — an
	// incremental run needs a real baseline, so rebuild fully instead.
	if (
		!index ||
		!index.commitSha ||
		index.commitSha === "pending" ||
		!index.branch
	) {
		return { kind: "full-fallback" };
	}

	const { token } = await resolveFreshRepoToken({
		integrationId: params.integrationId,
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
	});
	// No usable token → can't diff. Fall back to full, which surfaces the
	// no-credentials error via the shared trigger if the token is genuinely gone.
	if (!token) {
		return { kind: "full-fallback" };
	}

	const compare = await compareIndexedCommitToHead({
		repo: params.repo,
		token,
		base: index.commitSha,
		head: index.branch,
	});

	// Compare failed, or the provider capped the changed-file list — a diff-only
	// run off a partial list would miss files, so rebuild fully.
	if (compare.status === "unknown" || compare.truncated) {
		return { kind: "full-fallback" };
	}
	// No new commits / nothing changed — don't start a no-op run.
	if (compare.aheadBy === 0 || compare.changedFiles.length === 0) {
		return { kind: "up-to-date" };
	}
	return { kind: "incremental", changedFiles: compare.changedFiles };
}

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
					result.disabledReason === "feature-flag"
						? "Code indexing is not enabled for this environment"
						: "Enable code search for this project before indexing",
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
