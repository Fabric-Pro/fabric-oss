/**
 * `projects.contexts.repositorySync.writeTargets.list` — the folders of the
 * project's Living Memory sync that agents' files are written into
 * (ADR-022).
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then CONTEXT_READ,
 * then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`), the same as `get`: a read-only member sees
 * the folders. `canEnableDirectPush` says whether the caller may turn direct
 * push on, so a client can offer the choice only to those who could make it.
 * A project with no sync has no folders, and gets an empty list.
 */
import { listContextWriteTargets } from "@repo/database";
import { MAX_CONTEXT_WRITE_TARGETS } from "@repo/temporal/memory-write/target-rules";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "../access";
import { toWriteTargetView } from "./shared";

export const listContextWriteTargetsProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/repository-sync/write-targets",
		tags: ["Projects", "Contexts"],
		summary: "List the Living Memory write folders",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId, canConfigure, canEnableDirectPush } =
			await resolveContextSyncAccess(
				input.projectId,
				context.user.id,
				Permissions.CONTEXT_READ,
			);
		const targets = await listContextWriteTargets({
			projectId: input.projectId,
			organizationId,
		});
		return {
			canConfigure,
			canEnableDirectPush,
			maxTargets: MAX_CONTEXT_WRITE_TARGETS,
			targets: targets.map(toWriteTargetView),
		};
	});
