/**
 * `projects.contexts.repositorySync.writeTargets.delete` — stop agents
 * writing into a Living Memory write folder (ADR-022).
 *
 * Authorization is `create`'s: `projectNotFoundUnlessVisible`, CONTEXT_CREATE,
 * the hosting organization resolved server-side. Deleting needs no more than
 * that, whatever the folder's mode: removing a direct-push folder only takes
 * rights away. Done under the sync's configuration lock, so it does not
 * interleave with a `configure` or a `disable`.
 *
 * The receipts of writes already admitted through the folder stay; they carry
 * no foreign key to it. Files already written stay in the repository. A
 * target that is not this project's is `NOT_FOUND`, in the words a missing one
 * gets. Audited as `project.context.write_target_deleted`.
 */
import { deleteContextWriteTarget } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "../access";
import { writeTargetNotFound, writeTargetsNotConfigured } from "./shared";

export const deleteContextWriteTargetProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/contexts/repository-sync/write-targets/:targetId",
		tags: ["Projects", "Contexts"],
		summary: "Remove a Living Memory write folder",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			targetId: z.string().min(1).max(128),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId } = await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_CREATE,
		);

		const result = await deleteContextWriteTarget({
			projectId: input.projectId,
			organizationId,
			targetId: input.targetId,
		});
		if (result.status === "not-configured") {
			throw writeTargetsNotConfigured();
		}
		if (result.status === "not-found") {
			throw writeTargetNotFound();
		}

		const { target } = result;
		recordAuditFromRequest(context, {
			action: "project.context.write_target_deleted",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_context_write_target",
				id: target.id,
				name: target.folder,
			},
			metadata: { folder: target.folder, mode: target.mode },
		});
		return { deleted: true as const };
	});
