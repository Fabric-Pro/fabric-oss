import { db, getProjectCodeIndexes } from "@repo/database";
import { resolveFreshRepoToken } from "@repo/integrations";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { compareIndexedCommitToHead } from "../../projects/lib/repo-compare";

const inputSchema = z.object({
	projectId: z.string(),
	repositoryIntegrationId: z.string(),
	organizationId: z.string().nullable().optional(),
});

interface PendingChangesResult {
	/**
	 * Whether the index is current with the branch HEAD. `null` means we can't
	 * tell — no index yet, no usable token, or a failed compare — and the UI omits
	 * the line entirely rather than guessing.
	 */
	upToDate: boolean | null;
	behindByCommits: number;
	changedFiles: number;
	/** Current branch HEAD SHA when the index is behind. */
	aheadCommitSha?: string;
}

const UNKNOWN: PendingChangesResult = {
	upToDate: null,
	behindByCommits: 0,
	changedFiles: 0,
};

/**
 * Compare a connected repo's indexed commit to its current branch HEAD, so the
 * repository-settings "indexing details" panel can show whether the index is up
 * to date or "N commits behind · M files changed since last index".
 *
 * Works for GitHub, GitLab, and Azure DevOps via the provider-agnostic
 * `compareRepositoryCommits`. Any unresolvable / not-yet-indexed repo — no index
 * row, no usable token, or a failed compare — resolves to `upToDate: null` rather
 * than erroring, so the panel degrades quietly. Tenant scoping matches the
 * sibling status procedure: `tenantProtectedProcedure` + PROJECT read permission.
 */
export const getCodeIndexPendingChanges = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/agents/code-index/project/{projectId}/pending-changes",
		tags: ["Agents", "Code Index"],
		summary: "Compare a repo's indexed commit to its current branch HEAD",
	})
	.input(inputSchema)
	.handler(async ({ input, context }): Promise<PendingChangesResult> => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// The indexed commit for this repo. No row / no real commit ⇒ nothing to
		// compare against.
		const indexes = await getProjectCodeIndexes(input.projectId);
		const index = indexes
			.filter(
				(i) =>
					i.repositoryIntegrationId === input.repositoryIntegrationId,
			)
			.sort(
				(a, b) =>
					(b.indexedAt?.getTime() ?? 0) -
					(a.indexedAt?.getTime() ?? 0),
			)[0];
		if (!index || !index.commitSha || index.commitSha === "pending") {
			return UNKNOWN;
		}

		const integration = await db.projectRepositoryIntegration.findFirst({
			where: {
				id: input.repositoryIntegrationId,
				projectId: input.projectId,
			},
			select: {
				provider: true,
				repositoryOwner: true,
				repositoryName: true,
				repositoryUrl: true,
				azureOrganization: true,
			},
		});
		if (!integration) {
			return UNKNOWN;
		}

		const { token } = await resolveFreshRepoToken({
			integrationId: input.repositoryIntegrationId,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});
		if (!token) {
			return UNKNOWN;
		}

		// Compare the indexed commit (base) to the current branch HEAD (head). The
		// helper never throws — a force-pushed-away base or transient API error
		// degrades to `status: "unknown"`.
		const compare = await compareIndexedCommitToHead({
			repo: integration,
			token,
			base: index.commitSha,
			head: index.branch,
		});
		if (compare.status === "unknown") {
			return UNKNOWN;
		}
		// `aheadBy` = commits the branch HEAD is ahead of the indexed commit
		// = new commits since the last index.
		return {
			upToDate: compare.aheadBy === 0,
			behindByCommits: compare.aheadBy,
			changedFiles: compare.changedFiles.length,
			aheadCommitSha: compare.headSha ?? undefined,
		};
	});
