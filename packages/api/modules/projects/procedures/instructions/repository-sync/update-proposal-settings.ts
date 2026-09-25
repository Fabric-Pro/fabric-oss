import { ORPCError } from "@orpc/client";
import { updateInstructionRepositorySyncProposalSettings } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 *
 * "Let read-only members propose changes as pull requests" (Fizzy #2563
 * spec §12, §16.1; plan Decision 4). Its own procedure, not a `configure`
 * field, because `configure` re-points the configuration and bumps
 * `generation`, which fails every in-flight proposal with
 * CONFIGURATION_CHANGED; this writes `allowReaderProposals` alone. Admission
 * and the open activity read the setting live, so turning it off stops new
 * pushes by read-only proposers without touching proposals already admitted
 * by others.
 */
export const updateRepositorySyncProposalSettingsProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
		.route({
			method: "PATCH",
			path: "/projects/:projectId/instructions/repository-sync/proposal-settings",
			tags: ["Projects", "Instructions"],
			summary:
				"Choose whether read-only members may propose coding-instruction changes as pull requests",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				allowReaderProposals: z.boolean(),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			);
			const sync = await updateInstructionRepositorySyncProposalSettings({
				projectId: input.projectId,
				organizationId,
				allowReaderProposals: input.allowReaderProposals,
			});
			if (!sync) {
				throw new ORPCError("NOT_FOUND", {
					message:
						"This project's coding instructions are not synced from a repository",
				});
			}
			recordAuditFromRequest(context, {
				action: "project.instructions.repository_sync_configured",
				category: "project",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "project_instruction_repository_sync",
					id: sync.id,
					name: `${sync.repositoryIntegration.repositoryOwner}/${sync.repositoryIntegration.repositoryName}`,
				},
				metadata: {
					change: "allow_reader_proposals",
					allowReaderProposals: sync.allowReaderProposals,
					provider: sync.repositoryIntegration.provider,
					generation: sync.generation,
				},
			});
			return {
				allowReaderProposals: sync.allowReaderProposals,
				generation: sync.generation,
			};
		});
