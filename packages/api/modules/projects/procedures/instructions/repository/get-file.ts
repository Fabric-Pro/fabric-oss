import { instructionTextPage } from "@repo/instructions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { commitShaSchema } from "./commit-sha";
import { getDirectRepositoryFileForApi } from "./direct-query";

const FILE_BODY_DEFAULT_MAX = 50_000;
const FILE_BODY_MAX = 200_000;

/** Read one direct repository file as provider bytes at an already-pinned commit. */
export const getDirectInstructionRepositoryFileProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository/file",
			tags: ["Projects", "Instructions"],
			summary:
				"Read one direct repository instruction file at a pinned commit",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				generation: z.number().int().nonnegative(),
				commitSha: commitShaSchema,
				path: z.string().min(1).max(512),
				offset: z.number().int().min(0).default(0),
				maxLength: z
					.number()
					.int()
					.min(1)
					.max(FILE_BODY_MAX)
					.default(FILE_BODY_DEFAULT_MAX),
			}),
		)
		.handler(async ({ input, context, signal }) => {
			const { read } = await getDirectRepositoryFileForApi({
				projectId: input.projectId,
				generation: input.generation,
				commitSha: input.commitSha,
				path: input.path,
				userId: context.user.id,
				signal,
			});
			if (read.state !== "found") {
				return read;
			}
			return {
				state: "found" as const,
				size: read.size,
				...instructionTextPage(
					read.text,
					input.offset,
					input.maxLength,
				),
			};
		});
