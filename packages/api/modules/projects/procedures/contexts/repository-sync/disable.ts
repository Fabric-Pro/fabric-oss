/**
 * `projects.contexts.repositorySync.disable` — stop syncing the project's
 * Living Memory from a repository (design 2026-09-23 §5.1, Fizzy #2657).
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then
 * CONTEXT_CREATE, then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`); any `organizationId` in the input is ignored.
 *
 * Deletes the configuration under its lock. The files it brought in stay,
 * released as ordinary synced files (the foreign key's ON DELETE SET NULL);
 * run receipts stay. Allowed during a run: that run's next fenced
 * transaction finds no configuration and stops without writing.
 */
import {
	db,
	deleteContextRepositorySync,
	listContextCoveredCodePaths,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "./access";

/**
 * The files the code index leaves to the sync, read before it is deleted;
 * `null` when there are none or they cannot be read (disabling goes on).
 */
async function coveredCodePathsBefore(
	projectId: string,
	organizationId: string,
): Promise<{ repositoryIntegrationId: string; paths: string[] } | null> {
	try {
		const sync = await db.projectContextRepositorySync.findFirst({
			where: { projectId, organizationId },
			select: { repositoryIntegrationId: true },
		});
		if (!sync) {
			return null;
		}
		const paths = await listContextCoveredCodePaths({
			projectId,
			repositoryIntegrationId: sync.repositoryIntegrationId,
		});
		return paths.size === 0
			? null
			: {
					repositoryIntegrationId: sync.repositoryIntegrationId,
					paths: [...paths],
				};
	} catch (error) {
		logger.warn(
			`[ContextSync] Could not read the Living Memory files the code index leaves out: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/** The released files are no longer the sync's: the code index takes them back. */
async function returnFilesToCodeIndex(
	projectId: string,
	covered: { repositoryIntegrationId: string; paths: string[] },
): Promise<void> {
	try {
		const { reindexContextCoveredPaths } = await import(
			"../../../lib/code-index-refresh"
		);
		await reindexContextCoveredPaths({ projectId, ...covered });
	} catch (error) {
		logger.warn(
			`[ContextSync] Could not return Living Memory files to the code index: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export const disableContextRepositorySyncProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/contexts/repository-sync",
		tags: ["Projects", "Contexts"],
		summary: "Stop syncing the Living Memory from a repository",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_CREATE,
		);
		const covered = await coveredCodePathsBefore(
			input.projectId,
			organizationId,
		);
		const result = await deleteContextRepositorySync({
			projectId: input.projectId,
			organizationId,
		});
		if (!result.deleted || !result.syncId) {
			return { disabled: false as const };
		}
		if (covered) {
			await returnFilesToCodeIndex(input.projectId, covered);
		}
		recordAuditFromRequest(context, {
			action: "project.context.repository_sync_disabled",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_context_repository_sync",
				id: result.syncId,
				name: null,
			},
			metadata: { reason: "user", managedCount: result.managedCount },
		});
		return { disabled: true as const, managedCount: result.managedCount };
	});
