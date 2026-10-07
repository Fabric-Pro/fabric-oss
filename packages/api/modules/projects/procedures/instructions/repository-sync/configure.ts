import { ORPCError } from "@orpc/client";
import { verifyRepositoryBranch } from "@repo/connectors";
import { upsertInstructionRepositorySync } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";
import { projectIgnoreGlobsSchema } from "../ignore-globs-input";
import {
	assertNoOpenMigration,
	withMigrationFreeze,
} from "../migration-freeze";
import {
	instructionSyncRefSchema,
	loadInstructionSyncIntegration,
	MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH,
	normalizeRootPath,
	repositoryReadError,
	resolveInstructionSyncCredential,
} from "./repository";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 *
 * Saves the branch, folder and exclusions for direct repository reads.
 * Selection changes increment the generation under the project's lock,
 * fencing stale reads and already-admitted legacy workflows. Configuration
 * does not start an import or queue a follow-up run.
 *
 * `ignoreGlobs` (Fizzy #2726) carries the configure dialog's folder
 * exclusions: the project's own ignore list, written in the SAME transaction
 * as the configuration (`null` clears it, omitted leaves it alone). The
 * patterns are relative to the folder being configured, so they must land
 * with it or not at all — saved first by `updateSettings`, a `configure`
 * that then failed would leave the configuration still in place re-planning
 * under them. Writing the list is `updateSettings`' INSTRUCTION_UPDATE, so a
 * caller who sends it must hold that as well as INSTRUCTION_CREATE: the
 * combined call never grants more than the two procedures would. A changed
 * list is audited as `updateSettings` audits it.
 */
export const configureRepositorySyncProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/instructions/repository-sync",
		tags: ["Projects", "Instructions"],
		summary: "Configure coding-instructions repository sync",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			repositoryIntegrationId: z.string().min(1),
			ref: instructionSyncRefSchema,
			rootPath: z.string().max(MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH),
			automatic: z.boolean().optional(),
			ignoreGlobs: projectIgnoreGlobsSchema.nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Writing the ignore list is `updateSettings`' permission; checked
		// before anything is read, and answered as that procedure answers.
		if (input.ignoreGlobs !== undefined) {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.INSTRUCTION_UPDATE,
			);
		}
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		// A move from uploads into a repository owns the sync row until it
		// ends (Fizzy #2878 §9); re-pointing it would strand its pull request.
		await assertNoOpenMigration({
			projectId: input.projectId,
			organizationId,
		});
		const rootPath = normalizeRootPath(input.rootPath);
		if (rootPath === null) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The folder must be a relative path inside the repository.",
				data: { code: "INVALID_ROOT_PATH" },
			});
		}
		// Bound to THIS project before any credential column is read.
		const integration = await loadInstructionSyncIntegration({
			repositoryIntegrationId: input.repositoryIntegrationId,
			projectId: input.projectId,
		});
		const { token, refreshFault } = await resolveInstructionSyncCredential(
			integration,
			{ userId: context.user.id, organizationId },
		);
		const outcome = await verifyRepositoryBranch({
			provider: integration.provider,
			token,
			repositoryUrl: integration.repositoryUrl,
			owner: integration.repositoryOwner,
			repo: integration.repositoryName,
			azureOrganization: integration.azureOrganization,
			...(integration.provider === "GITLAB" &&
			integration.authMethod === "PAT"
				? { gitlabAuth: "private-token" as const }
				: {}),
			...(integration.provider === "AZURE_DEVOPS" &&
			integration.authMethod !== "PAT"
				? { azureDevOpsAuth: "bearer" as const }
				: {}),
			branch: input.ref,
		});
		if (outcome !== "exists") {
			throw repositoryReadError(outcome, {
				ref: input.ref,
				refreshFault,
				unreachableMessage:
					"Couldn't reach the repository to check the branch. Try again.",
			});
		}
		// The pre-check above is the fast answer; the writer decides the freeze
		// again under the project lock, so a move that started while the branch
		// was being verified is refused here rather than overwritten.
		const written = await withMigrationFreeze(
			{ projectId: input.projectId, organizationId },
			() =>
				upsertInstructionRepositorySync({
					projectId: input.projectId,
					organizationId,
					userId: context.user.id,
					repositoryIntegrationId: integration.id,
					ref: input.ref,
					rootPath,
					...(input.automatic === undefined
						? {}
						: { automatic: input.automatic }),
					...(input.ignoreGlobs === undefined
						? {}
						: { ignoreGlobs: input.ignoreGlobs }),
				}),
		);
		if (!written) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		recordAuditFromRequest(context, {
			action: "project.instructions.repository_sync_configured",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_repository_sync",
				id: written.sync.id,
				name: `${integration.repositoryOwner}/${integration.repositoryName}`,
			},
			metadata: {
				provider: integration.provider,
				automatic: written.sync.automatic,
				repositoryChanged: written.previous
					? written.previous.repositoryIntegrationId !==
						written.sync.repositoryIntegrationId
					: true,
				refChanged: written.previous
					? written.previous.ref !== written.sync.ref
					: true,
				// Not `rootPathChanged`: lowercased it contains `otp`, which the
				// audit writer's key denylist redacts (Fizzy #2746).
				rootChanged: written.previous
					? written.previous.rootPath !== written.sync.rootPath
					: true,
				ignoreGlobsChanged: written.ignoreGlobsChanged,
				generation: written.sync.generation,
			},
		});
		if (written.ignoreGlobsChanged) {
			// The same row `updateSettings` writes for the same change.
			recordAuditFromRequest(context, {
				action: "project.instructions.settings_updated",
				category: "project",
				organizationId,
				projectId: input.projectId,
				resource: { type: "project", id: input.projectId, name: null },
				metadata: { ignoreGlobCount: input.ignoreGlobs?.length ?? 0 },
			});
		}
		return {
			syncId: written.sync.id,
			generation: written.sync.generation,
		};
	});
