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
 * Points the project's coding instructions at a branch and optional folder
 * of one of its repository integrations (design 2026-09-23 §5.1). The caller
 * becomes the delegate automatic runs act as; the project flips to
 * REPOSITORY. Does not start a run: the client calls `syncNow` after this.
 *
 * Only a change to what is synced (the repository, the branch, the folder or
 * the ignore rules) bumps the generation, fencing an in-flight run and
 * making a proposal frozen at the old generation stale, and resets the rest
 * of the automatic schedule. The "Automatic sync" toggle and "Re-enable"
 * send the stored repository, branch and folder and no ignore rules, so they
 * keep the generation: a run already open finishes and publishes normally,
 * and a proposal in flight stays current (Fizzy #2744). Either clears a
 * pause and the failure count and makes the sync due now. The query decides
 * which under its lock. Either is audited as
 * `project.instructions.repository_sync_configured`; the `*Changed` flags
 * say which it was.
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
		const written = await upsertInstructionRepositorySync({
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
		});
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
				rootPathChanged: written.previous
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
		return { syncId: written.sync.id, generation: written.sync.generation };
	});
