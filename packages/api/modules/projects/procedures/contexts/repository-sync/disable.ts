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
import { deleteContextRepositorySync } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "./access";

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
		const result = await deleteContextRepositorySync({
			projectId: input.projectId,
			organizationId,
		});
		if (!result.deleted || !result.syncId) {
			return { disabled: false as const };
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
