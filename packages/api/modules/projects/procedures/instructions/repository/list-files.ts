import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { commitShaSchema } from "./commit-sha";
import { listDirectRepositoryFilesForApi } from "./direct-query";

/**
 * Read the configured repository's bounded file metadata at one commit. The
 * first request resolves HEAD and returns its pin; every subsequent request
 * supplies both commit and generation, so files cannot drift with a branch.
 */
export const listDirectInstructionRepositoryFilesProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository/files",
			tags: ["Projects", "Instructions"],
			summary:
				"List direct repository instruction files at a pinned commit",
		})
		.input(
			z
				.object({
					projectId: z.string(),
					organizationId: z.string().nullable().optional(),
					generation: z.number().int().nonnegative().optional(),
					commitSha: commitShaSchema.optional(),
				})
				.refine(
					(input) =>
						(input.generation === undefined) ===
						(input.commitSha === undefined),
					"generation and commitSha must be provided together",
				),
		)
		.handler(({ input, context, signal }) =>
			listDirectRepositoryFilesForApi({
				projectId: input.projectId,
				generation: input.generation,
				commitSha: input.commitSha,
				userId: context.user.id,
				signal,
			}),
		);
