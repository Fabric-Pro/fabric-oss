import { listRepositoryCommits } from "@repo/connectors";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { presentRepositoryCommit } from "./commit-presentation";
import { commitShaSchema } from "./commit-sha";
import {
	assertDirectRepositoryPin,
	assertDirectRepositorySourceCurrent,
	directRepositoryReadError,
	loadDirectRepositorySource,
} from "./direct-source";

export const listDirectInstructionRepositoryCommitsProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository/commits",
			tags: ["Projects", "Instructions"],
			summary: "Read native repository commit history",
		})
		.input(
			z.object({
				projectId: z.string(),
				generation: z.number().int().nonnegative(),
				commitSha: commitShaSchema,
				cursor: z.number().int().min(1).max(1000).default(1),
			}),
		)
		.handler(async ({ input, context, signal }) => {
			const caller = {
				projectId: input.projectId,
				userId: context.user.id,
				signal,
			};
			const source = await loadDirectRepositorySource(caller);
			try {
				await assertDirectRepositoryPin(source, input);
				const result = await listRepositoryCommits({
					...source.repository,
					branch: source.ref,
					commitSha: input.commitSha,
					path: source.rootPath,
					page: input.cursor,
					includeParents: false,
				});
				if (!result.ok) {
					throw directRepositoryReadError(source, result.outcome);
				}
				return {
					commits: result.commits.map((commit) =>
						presentRepositoryCommit(commit),
					),
					nextCursor:
						result.hasMore && input.cursor < 1000
							? input.cursor + 1
							: null,
				};
			} finally {
				await assertDirectRepositorySourceCurrent({
					...caller,
					source,
				});
			}
		});
