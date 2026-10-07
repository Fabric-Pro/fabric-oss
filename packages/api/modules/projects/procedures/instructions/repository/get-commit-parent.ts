import { readRepositoryCommitParent } from "@repo/connectors";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { commitShaSchema } from "./commit-sha";
import { directParentCache } from "./direct-cache";
import {
	assertDirectRepositoryPin,
	assertDirectRepositorySourceCurrent,
	directRepositoryReadError,
	loadDirectRepositorySource,
} from "./direct-source";
import { settle, unsettle } from "./settle";

/**
 * The first parent of the one commit a person selected in native history.
 * Azure DevOps lists commits without parents, and `listCommits` does not read
 * one per row; Compare and Revert need it for the commit being acted on. The
 * commit must be on the configured branch, as every other direct read requires.
 */
export const getDirectInstructionRepositoryCommitParentProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository/commit-parent",
			tags: ["Projects", "Instructions"],
			summary: "Read the parent of one native repository commit",
		})
		.input(
			z.object({
				projectId: z.string(),
				generation: z.number().int().nonnegative(),
				sha: commitShaSchema,
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
				const checking = settle(
					assertDirectRepositoryPin(source, {
						generation: input.generation,
						commitSha: input.sha,
					}),
				);
				const cached = directParentCache.get(source, input.sha);
				if (cached !== undefined) {
					unsettle(await checking);
					return { sha: input.sha, parent: cached };
				}
				const [checked, read] = await Promise.all([
					checking,
					settle(
						readRepositoryCommitParent({
							...source.repository,
							sha: input.sha,
						}),
					),
				]);
				unsettle(checked);
				const result = unsettle(read);
				if (!result.ok) {
					throw directRepositoryReadError(source, result.outcome);
				}
				directParentCache.set(source, input.sha, result.parent);
				return { sha: input.sha, parent: result.parent };
			} finally {
				await assertDirectRepositorySourceCurrent({
					...caller,
					source,
				});
			}
		});
