import {
	getInstructionRepositorySync,
	getLatestInstructionRepositorySyncRun,
	getProjectInstructionSettings,
	listProjectRepoIntegrations,
} from "@repo/database";
import { hasPermission } from "@repo/permissions";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveHostingOrganizationAccess } from "../hosting-organization";
import { isInstructionRepositorySyncRunning } from "./start-sync-workflow";
import { toSyncRunView } from "./views";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_READ).
 *
 * The tab's repository-sync state (design 2026-09-23 §5.1, §7). Read-only
 * members see the status; `availableIntegrations` goes only to members who
 * could act on it (instruction:create), and the delegate is a display name.
 */
export const getRepositorySyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/repository-sync",
		tags: ["Projects", "Instructions"],
		summary: "Get the coding-instructions repository sync state",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const access = await resolveHostingOrganizationAccess(
			input.projectId,
			context.user.id,
		);
		const { organizationId } = access;
		const canConfigure =
			access.source === "owner" ||
			hasPermission(access.permissions, Permissions.INSTRUCTION_CREATE);
		const [settings, sync, latestRun, running, integrations] =
			await Promise.all([
				getProjectInstructionSettings(input.projectId, organizationId),
				getInstructionRepositorySync(input.projectId, organizationId),
				getLatestInstructionRepositorySyncRun(
					input.projectId,
					organizationId,
				),
				isInstructionRepositorySyncRunning(input.projectId),
				canConfigure
					? listProjectRepoIntegrations(input.projectId)
					: Promise.resolve([]),
			]);
		return {
			sourceOfTruth:
				settings.sourceOfTruth === "REPOSITORY"
					? ("REPOSITORY" as const)
					: ("UPLOAD" as const),
			canConfigure,
			running,
			configured: sync
				? {
						syncId: sync.id,
						repositoryIntegrationId: sync.repositoryIntegrationId,
						provider: sync.repositoryIntegration.provider,
						repositoryOwner:
							sync.repositoryIntegration.repositoryOwner,
						repositoryName:
							sync.repositoryIntegration.repositoryName,
						integrationStatus: sync.repositoryIntegration.status,
						ref: sync.ref,
						rootPath: sync.rootPath,
						automatic: sync.automatic,
						automaticPausedReason: sync.automaticPausedReason,
						automaticPausedAt: sync.automaticPausedAt,
						delegateName: sync.user.name,
					}
				: null,
			latestRun: latestRun ? toSyncRunView(latestRun) : null,
			availableIntegrations: integrations
				.filter((i) => i.status === "ACTIVE")
				.map((i) => ({
					id: i.id,
					provider: i.provider,
					repositoryOwner: i.repositoryOwner,
					repositoryName: i.repositoryName,
					defaultBranch: i.defaultBranch,
				})),
		};
	});
