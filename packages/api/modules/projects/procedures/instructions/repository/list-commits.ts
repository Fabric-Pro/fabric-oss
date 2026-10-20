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
	directRepositoryPath,
	directRepositoryReadError,
	loadDirectRepositorySource,
	resolveDirectRepositoryHead,
} from "./direct-source";
import {
	assertInstructionRepositoryFileVisible,
	instructionRepositoryFilePathSchema,
} from "./file-path";

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
				path: instructionRepositoryFilePathSchema.optional(),
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
				if (input.path !== undefined) {
					const current = await resolveDirectRepositoryHead(source);
					await assertInstructionRepositoryFileVisible({
						source,
						pin: current,
						path: input.path,
					});
					if (current.commitSha !== input.commitSha) {
						await assertInstructionRepositoryFileVisible({
							source,
							pin: input,
							path: input.path,
						});
					}
				}
				const result = await listRepositoryCommits({
					...source.repository,
					branch: source.ref,
					commitSha: input.commitSha,
					path:
						input.path === undefined
							? source.rootPath
							: directRepositoryPath(source, input.path),
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
					hasMore: result.hasMore,
					historyLimitReached:
						result.hasMore && input.cursor === 1000,
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
