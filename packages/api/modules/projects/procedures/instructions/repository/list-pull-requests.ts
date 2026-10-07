import { ORPCError } from "@orpc/client";
import { listRepositoryPullRequests } from "@repo/connectors";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import {
	assertDirectRepositorySourceCurrent,
	directRepositoryReadError,
	loadDirectRepositorySource,
} from "./direct-source";

export const listDirectInstructionRepositoryPullRequestsProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository/pull-requests",
			tags: ["Projects", "Instructions"],
			summary: "Read open native repository proposals",
		})
		.input(
			z.object({
				projectId: z.string(),
				generation: z.number().int().nonnegative(),
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
				if (input.generation !== source.generation) {
					throw new ORPCError("CONFLICT", {
						message:
							"The repository configuration changed. Refresh and try again.",
						data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
					});
				}
				const result = await listRepositoryPullRequests({
					...source.repository,
					branch: source.ref,
					page: input.cursor,
				});
				if (!result.ok) {
					throw directRepositoryReadError(source, result.outcome);
				}
				return {
					pullRequests: result.pullRequests,
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
