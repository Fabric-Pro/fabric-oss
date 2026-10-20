import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { readDirectRepositoryFilesForApi } from "./direct-batch";
import { repositoryFilesReadSchema } from "./direct-batch-schema";

export const readDirectInstructionRepositoryFilesProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "POST",
			path: "/projects/:projectId/instructions/repository/files/read",
			tags: ["Projects", "Instructions"],
			summary:
				"Read a bounded batch of pinned repository instruction files",
		})
		.input(
			repositoryFilesReadSchema.and(
				z.object({
					projectId: z.string(),
					organizationId: z.string().nullable().optional(),
				}),
			),
		)
		.handler(({ input, context, signal }) =>
			readDirectRepositoryFilesForApi({
				projectId: input.projectId,
				generation: input.generation,
				commitSha: input.commitSha,
				paths: input.paths,
				startIndex: input.startIndex,
				userId: context.user.id,
				signal,
			}),
		);
