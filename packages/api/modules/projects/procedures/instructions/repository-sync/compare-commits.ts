/**
 * `projects.instructions.repositorySync.compareCommits` — what changed
 * between two commits of the synced branch, within the sync's folder (Fizzy
 * #2878 §10): the Compare dialog of a repository-backed project, and a
 * commit's own diff (a commit against its `parent`, which every `listCommits`
 * row carries). The snapshot compare (`compareSnapshots`) stays for uploaded
 * projects and proposal previews.
 *
 * The answer has `compareSnapshots`'s shape: `added`, `removed` and `changed`
 * path lists with each file's `kind` and `isText`, paths relative to the
 * folder as a snapshot's are. Sizes are not part of it: nothing is read but
 * the provider's changed-path list, and a body is fetched per expanded row
 * through `readCommitFile`.
 *
 * What it will not name, so a path is never disclosed that a snapshot would
 * not hold: anything outside the sync's folder, anything the published
 * version's frozen ignore rules (and the always-excluded set) leave out, and
 * any credential-shaped file name. Both commits must be part of the synced
 * branch's history (`assertCommitOnBranch`): a commit on a pull request's
 * branch is the review gate's to release, not a reader's, and is answered
 * NOT_FOUND exactly as a missing commit is.
 *
 * `truncated` is true when the provider capped its own list (300 files on
 * GitHub), so a list that stops short is never read as complete.
 *
 * Authorization: `projectNotFoundUnlessVisible`, then INSTRUCTION_CREATE, then
 * the hosting organization resolved server-side. Both ids are full object ids.
 * The write permission, not INSTRUCTION_READ, for `listTree`'s reason: the
 * read spends the integration's own credential against the customer's
 * provider, and a reader of the published copy has no use for the repository's
 * history that would justify spending it. Not audited: structure only, no
 * content, no write.
 */
import { compareRepositoryRefs } from "@repo/connectors";
import {
	buildIgnoreMatcher,
	classifyPath,
	fileTypingFor,
	isSecretFileName,
	readFrozenIgnoreGlobs,
	validateRelativePath,
} from "@repo/instructions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { commitShaSchema } from "../repository/commit-sha";
import {
	assertCommitOnBranch,
	type CommitSource,
	loadCommitSource,
	readError,
} from "./commit-source";

export { commitShaSchema } from "../repository/commit-sha";

/** Whether the snapshot's own rules would keep `path` (relative to the folder) out. */
export function pathIsExcluded(
	source: Pick<CommitSource, "settingsFrozen">,
): (path: string) => boolean {
	const ignored = buildIgnoreMatcher(
		readFrozenIgnoreGlobs(source.settingsFrozen) ?? {
			globs: [],
			layer: "default",
		},
	);
	return (path) =>
		!validateRelativePath(path).ok ||
		isSecretFileName(path) !== null ||
		ignored(path) !== null;
}

/** `path` under the sync's folder, relative to it, or null when it is outside. */
function relativeToRoot(rootPath: string, path: string): string | null {
	if (rootPath === "") {
		return path;
	}
	const prefix = `${rootPath}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function entry(path: string) {
	return {
		path,
		kind: classifyPath(path),
		isText: fileTypingFor(path).isText,
	};
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 */
export const compareInstructionRepositoryCommitsProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository-sync/compare",
			tags: ["Projects", "Instructions"],
			summary: "Compare two commits of the synced branch",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				from: commitShaSchema,
				to: commitShaSchema,
			}),
		)
		.handler(async ({ input, context }) => {
			const source = await loadCommitSource({
				projectId: input.projectId,
				userId: context.user.id,
			});
			await assertCommitOnBranch(source, input.from);
			await assertCommitOnBranch(source, input.to);
			const result = await compareRepositoryRefs({
				...source.repository,
				from: input.from,
				to: input.to,
			});
			if (!result.ok) {
				throw readError(source, result.outcome);
			}
			const excluded = pathIsExcluded(source);
			const added: Array<ReturnType<typeof entry>> = [];
			const removed: Array<ReturnType<typeof entry>> = [];
			const changed: Array<ReturnType<typeof entry>> = [];
			for (const file of result.files) {
				const path = relativeToRoot(source.rootPath, file.path);
				if (path === null || excluded(path)) {
					continue;
				}
				(file.status === "added"
					? added
					: file.status === "removed"
						? removed
						: changed
				).push(entry(path));
			}
			return {
				from: { sha: input.from },
				to: { sha: input.to },
				added,
				removed,
				changed,
				truncated: result.truncated,
			};
		});
