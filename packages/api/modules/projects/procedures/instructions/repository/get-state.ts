import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveDirectRepositoryState } from "./direct-state";

/** Metadata-only direct repository state. It does not list or read tree data. */
export const getDirectInstructionRepositoryStateProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/repository",
			tags: ["Projects", "Instructions"],
			summary: "Get direct coding-instructions repository state",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context, signal }) => {
			const state = await resolveDirectRepositoryState({
				projectId: input.projectId,
				userId: context.user.id,
				signal,
			});
			if (state.availability !== "READY") {
				return state;
			}
			return {
				availability: "READY" as const,
				readState: "DIRECT" as const,
				provider: state.source.repository.provider,
				repositoryUrl: state.source.repository.repositoryUrl,
				ref: state.source.ref,
				rootPath: state.source.rootPath,
				generation: state.pin.generation,
				currentCommitSha: state.pin.commitSha,
			};
		});
