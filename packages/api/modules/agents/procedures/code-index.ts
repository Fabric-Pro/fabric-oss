import {
	aggregateCodeIndexStatus,
	getProjectCodeIndexes,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * Surfaces the project's code-index status so UI surfaces (e.g. the Fabric
 * Agent launcher repo chip) can tell users whether `code_search` is wired up.
 *
 * Returned status values mirror `ProjectCodeIndex.status` plus a synthetic
 * `MISSING` value for projects that have never been indexed. The raw
 * `ProjectCodeIndex.error` string is intentionally NOT returned — it can carry
 * internal clone/indexer detail and no client renders it; UI surfaces show a
 * fixed "indexing failed" message from the `FAILED` status instead.
 */
export const getProjectCodeIndexStatus = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/agents/code-index/project/{projectId}",
		tags: ["Agents", "Code Index"],
		summary: "Get project code-index status",
	})
	.input(inputSchema)
	.handler(async ({ input }) => {
		// The index is per-repo; roll all connected repos into one project-level
		// signal for the launcher chip — the best status across repos, with
		// summed file/chunk counts.
		const indexes = await getProjectCodeIndexes(input.projectId);
		const status = aggregateCodeIndexStatus(indexes);
		if (!status) {
			return {
				status: "MISSING" as const,
				indexedAt: null,
				filesIndexed: 0,
				chunksCreated: 0,
				branch: null,
				commitSha: null,
				indexedFileCount: null,
				totalFileCount: null,
				lastFullIndexAt: null,
				lastIncrementalAt: null,
			};
		}

		const mostRecentIndexedAt = indexes.reduce<Date | null>(
			(latest, index) =>
				index.indexedAt && (!latest || index.indexedAt > latest)
					? index.indexedAt
					: latest,
			null,
		);

		// Representative row for the per-repo detail fields (branch, commit,
		// progress, full/incremental timestamps): the repo driving the aggregate
		// status, most-recently-indexed first. These fields are per-repo, so on a
		// multi-repo project they reflect that primary repo, while filesIndexed /
		// chunksCreated stay summed across all repos.
		const primary =
			[...indexes]
				.filter((index) => index.status === status)
				.sort(
					(a, b) =>
						(b.indexedAt?.getTime() ?? 0) -
						(a.indexedAt?.getTime() ?? 0),
				)[0] ?? null;

		return {
			status,
			indexedAt: mostRecentIndexedAt,
			filesIndexed: indexes.reduce((sum, i) => sum + i.filesIndexed, 0),
			chunksCreated: indexes.reduce((sum, i) => sum + i.chunksCreated, 0),
			branch: primary?.branch ?? null,
			commitSha: primary?.commitSha ?? null,
			indexedFileCount: primary?.indexedFileCount ?? null,
			totalFileCount: primary?.totalFileCount ?? null,
			lastFullIndexAt: primary?.lastFullIndexAt ?? null,
			lastIncrementalAt: primary?.lastIncrementalAt ?? null,
		};
	});
