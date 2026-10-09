/**
 * `projects.instructions.repositorySync.listCommits` — the synced branch's
 * history within the sync's folder, with Fabric's view of each commit laid
 * over it (Fizzy #2878 §10): the History tab of a repository-backed project,
 * where rollback is a revert commit and diff is a commit diff.
 *
 * Authorization: `projectNotFoundUnlessVisible`, then INSTRUCTION_READ (the
 * same bar as the version list it replaces on these projects), then the
 * hosting organization resolved server-side; any `organizationId` in the input
 * is ignored. A project that is not repository-backed has no branch
 * (`NOT_REPOSITORY_SOURCED`).
 *
 * The commits come from the provider's own commits API through the sync's
 * integration credential (`loadCommitSource`), one page of 30 at a time, newest
 * first. `cursor` is the page number the previous answer's `nextCursor` named
 * (1 when absent); `nextCursor` is null on the last page. A failed read throws
 * the configure dialog's errors, never an empty history.
 *
 * The page is cached for 60 seconds per (integration, ref, folder, page, the
 * published commit): a push that Fabric has since synced changes the published
 * commit and so misses the cache at once, and a push it has not seen yet shows
 * within a minute. Only the provider's answer is cached; the overlay below is
 * read on every call.
 *
 * Each row: `{ sha, author: { name }, date, message, messageWithheld, url,
 * parent, published, refused, isFabric }`.
 *
 *  - `message`, `author.name`: provider text a reader sees only if it would
 *    pass the check a file gets before Fabric serves it. A message the secret
 *    scanner refuses is `null` with `messageWithheld: true` (the text is never
 *    returned, and neither is a line or a rule); an author name it refuses is
 *    "a Fabric user". The commit itself stays listed: its sha, date and
 *    place in the history are not secret.
 *
 *  - `published`: the version number of Fabric's READY copy of that commit, or
 *    null when Fabric holds none;
 *  - `refused`: a sync run evaluated that commit and the secret scan refused
 *    its tree, so Fabric serves nothing from it;
 *  - `isFabric`: Fabric wrote it (a direct commit, a revert, or a pull request
 *    commit): Fabric is the committer or a Fabric trailer is present.
 *
 * Names only: no email address leaves this procedure. Not audited: it returns
 * metadata the repository already shows its readers, and writes nothing.
 */

import { listRepositoryCommits, type RepositoryCommit } from "@repo/connectors";
import { getInstructionCommitOverlay } from "@repo/database";
import { z } from "zod";
import { TtlCache } from "../../../../../lib/ttl-cache";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { presentRepositoryCommit } from "../repository/commit-presentation";
import { loadCommitSource, readError } from "./commit-source";

const historyCache = new TtlCache<{
	commits: RepositoryCommit[];
	hasMore: boolean;
}>({
	ttlMs: 60_000,
	maxEntries: 200,
});

/** For tests: forget every cached page. */
export function resetCommitHistoryCache(): void {
	historyCache.clear();
}

/** The most pages a history may be walked: a bound, not a feature. */
const MAX_CURSOR = 1000;

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ).
 */
export const listInstructionRepositoryCommitsProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository-sync/commits",
			tags: ["Projects", "Instructions"],
			summary: "List the synced branch's commits",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				cursor: z.number().int().min(1).max(MAX_CURSOR).optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const source = await loadCommitSource({
				projectId: input.projectId,
				userId: context.user.id,
			});
			const page = input.cursor ?? 1;
			const key = [
				source.integrationId,
				source.ref,
				source.rootPath,
				page,
				source.publishedCommitSha ?? "",
			].join("\u0000");
			let listed = historyCache.get(key);
			if (listed === undefined) {
				const result = await listRepositoryCommits({
					...source.repository,
					branch: source.ref,
					path: source.rootPath,
					page,
				});
				if (!result.ok) {
					throw readError(source, result.outcome);
				}
				listed = { commits: result.commits, hasMore: result.hasMore };
				historyCache.set(key, listed);
			}
			const overlay = await getInstructionCommitOverlay({
				projectId: input.projectId,
				organizationId: source.organizationId,
				shas: listed.commits.map((commit) => commit.sha),
			});
			return {
				commits: listed.commits.map((commit) =>
					presentRepositoryCommit(commit, {
						published: overlay.published.get(commit.sha) ?? null,
						refused: overlay.refused.has(commit.sha),
					}),
				),
				nextCursor: listed.hasMore ? page + 1 : null,
			};
		});
