import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { commitShaSchema } from "./commit-sha";
import {
	previewInstructionFileRestore,
	restoreInstructionFile,
} from "./file-history";
import { instructionRepositoryFilePathSchema } from "./file-path";

const fileVersionInput = z.object({
	projectId: z.string(),
	generation: z.number().int().positive(),
	path: instructionRepositoryFilePathSchema,
	targetCommitSha: commitShaSchema,
});

export const previewInstructionFileRestoreProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/repository/file-restore",
		tags: ["Projects", "Instructions"],
		summary: "Compare a file with a historical Git version",
	})
	.input(
		fileVersionInput.extend({
			currentCommitSha: commitShaSchema.optional(),
		}),
	)
	.handler(({ input, context, signal }) =>
		previewInstructionFileRestore({
			...input,
			userId: context.user.id,
			signal,
		}),
	);

export const restoreInstructionFileProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/repository/file-restore",
		tags: ["Projects", "Instructions"],
		summary: "Restore one file as a new Git change",
	})
	.input(fileVersionInput.extend({ currentCommitSha: commitShaSchema }))
	.handler(({ input, context, signal }) =>
		restoreInstructionFile({
			...input,
			userId: context.user.id,
			audit: context,
			signal,
		}),
	);
