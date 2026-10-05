import {
	getInstructionRepositorySync,
	getInstructionSyncRunSnapshotProgress,
	getLatestInstructionRepositorySyncRun,
	getProjectInstructionSettings,
	listProjectRepoIntegrations,
} from "@repo/database";
import { hasPermission } from "@repo/permissions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveHostingOrganizationAccess } from "../hosting-organization";
import { isInstructionRepositorySyncRunning } from "./start-sync-workflow";
import { toSyncRunView } from "./views";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ).
 *
 * The tab's repository-sync state (design 2026-09-23 §5.1, §7). Read-only
 * members see the status; `availableIntegrations` goes only to members who
 * could act on it (instruction:create), and the delegate is a display name.
 */
export const getRepositorySyncProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
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
		// An open run's snapshot, found by the run's key, so the tab can carry
		// the run's progress on from the copy into the snapshot's own checks.
		// The receipt only names the snapshot once the run is recorded.
		const inFlightSnapshot =
			latestRun && latestRun.finishedAt === null
				? await getInstructionSyncRunSnapshotProgress(
						latestRun.id,
						input.projectId,
						organizationId,
					)
				: null;
		return {
			sourceOfTruth:
				settings.sourceOfTruth === "REPOSITORY"
					? ("REPOSITORY" as const)
					: ("UPLOAD" as const),
			// A move of uploaded instructions into a repository is open (Fizzy
			// #2878 §9): `configured` is then the sync row the move created,
			// paused `MIGRATING` and not yet the source of truth, and the
			// move's own read (`getMigration`) says where it stands.
			migration: settings.migration
				? { state: settings.migration.state }
				: null,
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
						// The canonical `https://host/owner/name` URL, with no
						// userinfo (`parseRepoUrl` strips it on write) and no
						// query or fragment (refused on write). Shown to every
						// member who can read this state so the Connect dialog
						// can print `git clone <repositoryUrl>` for a
						// repository-sourced project (Fizzy #2721).
						repositoryUrl: sync.repositoryIntegration.repositoryUrl,
						integrationStatus: sync.repositoryIntegration.status,
						ref: sync.ref,
						rootPath: sync.rootPath,
						automatic: sync.automatic,
						automaticPausedReason: sync.automaticPausedReason,
						automaticPausedAt: sync.automaticPausedAt,
						// Fizzy #2563 spec §12: whether read-only members may
						// propose as pull requests; the tab's `canPropose`
						// reads it for a reader.
						allowReaderProposals: sync.allowReaderProposals,
						delegateName: sync.user.name,
					}
				: null,
			// Kept after a switch to upload mode, and marked, so History stays
			// reachable while the status line leaves it out (Fizzy #2672).
			latestRun: latestRun
				? toSyncRunView(latestRun, sync?.id ?? null)
				: null,
			inFlightSnapshot: inFlightSnapshot
				? {
						status: inFlightSnapshot.status,
						version: inFlightSnapshot.version,
						scanPending:
							inFlightSnapshot.deferredScanStatus === "PENDING",
						progress:
							inFlightSnapshot.progressPhase === null
								? null
								: {
										phase: inFlightSnapshot.progressPhase,
										done: inFlightSnapshot.progressDone,
										total: inFlightSnapshot.progressTotal,
									},
					}
				: null,
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
