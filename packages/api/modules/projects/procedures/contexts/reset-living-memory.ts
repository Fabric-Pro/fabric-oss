/**
 * resetLivingMemory — delete every synced knowledge file of a project, or of
 * one folder (`folder`), at once: the Context tab's "Reset Living Memory" and
 * each folder's "Remove folder", for synced files in a state the per-file
 * delete cannot untangle.
 *
 * The session half; the key-backed twin, which `fabric context reset` calls
 * behind the `projects:write` scope, is
 * `POST /api/v1/projects/:projectId/contexts/reset` in `modules/v1/contexts.ts`.
 * Both call `resetSyncedContexts`, which owns the delete (with its queued
 * index cleanup and audit row, in one transaction) and the realtime events,
 * so this file is authorization and the wire contract only; change the two
 * together.
 *
 * Authorization, all answered server-side, in this order:
 *  - visibility (`projectNotFoundUnlessVisible`) FIRST: a project the caller
 *    cannot see is NOT_FOUND in the words a missing id gets. It is also
 *    needed on its own terms, because the permission resolver's org-role
 *    fallback grants an org member their role's permissions on projects
 *    hidden from them;
 *  - CONTEXT_DELETE, re-checked against the caller's live permissions. A
 *    reset deletes every member's files, and this is the permission that
 *    deletes any member's file one at a time; at project level only a
 *    project admin or the owner holds it, an editor does not;
 *  - the project's hosting organization, never a caller-supplied one.
 */
import { ORPCError } from "@orpc/client";
import { hasPermission, Permissions } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	PROJECT_NOT_FOUND_MESSAGE,
	projectNotFoundUnlessVisible,
} from "../../../../orpc/middleware/project-visibility";
import {
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	MAX_RESET_FOLDER_INPUT_LENGTH,
	resetSyncedContexts,
} from "../../lib/reset-synced-contexts";

export const resetLivingMemoryProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_DELETE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/living-memory/reset",
		tags: ["Projects", "Contexts"],
		summary: "Reset Living Memory",
		description:
			"Delete every file synced into the project's Living Memory (every context with a source path) at once, and queue their entries in the search index for removal in the same step. With `folder` (a relative folder path such as `docs/guides`), only the synced files under that folder are deleted. Answers `{ deleted }`, which is 0 when there was nothing to delete, so a repeat is harmless. A `folder` that is absolute, names the root, or holds a `.` or `..` segment answers BAD_REQUEST. While a repository sync is connected the call answers CONFLICT with `data.code` `REPOSITORY_SYNC_ACTIVE` and deletes nothing: disconnect the sync first.",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			// Normalized and validated by `resetSyncedContexts` with the
			// synced-file path rules; this only bounds the string.
			folder: z
				.string()
				.min(1)
				.max(MAX_RESET_FOLDER_INPUT_LENGTH)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const access = await resolveEffectiveProjectPermissions(
			input.projectId,
			user.id,
		);
		if (!access) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		}
		if (!hasPermission(access.permissions, Permissions.CONTEXT_DELETE)) {
			throw new ORPCError("FORBIDDEN", {
				message: `Missing required permission: ${Permissions.CONTEXT_DELETE}`,
			});
		}

		return await resetSyncedContexts({
			projectId: input.projectId,
			userId: user.id,
			organizationId: access.organizationId,
			via: "web",
			request: context,
			...(input.folder === undefined ? {} : { folder: input.folder }),
		});
	});
