/**
 * deleteSyncedFile — delete a synced text file from a project's Context by
 * its path, only in the version the caller names (Fizzy #2636).
 *
 * The session half; the key-backed twin, which `fabric context push --prune`
 * calls behind the `projects:write` scope, is
 * `DELETE /api/v1/projects/:projectId/contexts/synced-files` in
 * `modules/v1/contexts.ts`. Both call `deleteSyncedContext`, which owns the
 * validation, the row-first delete (with its queued index cleanup and audit
 * row, in one transaction) and the realtime events, so this file is
 * authorization and the wire contract only; change the two together. Every
 * answer is final (Living Memory design 2026-09-23 §6): `deleted`, `absent`,
 * CONFLICT with the stored version, or CONFLICT with
 * `data.code: "REPOSITORY_MANAGED"` for a row a repository sync owns.
 *
 * Authorization, all answered server-side, on the terms of the upsert twin
 * (`upsert-synced-file.ts`) with the Context tab's delete permission, in
 * this order:
 *  - visibility (`projectNotFoundUnlessVisible`, `hasProjectAccess`) FIRST:
 *    a project the caller cannot see is NOT_FOUND in the words a missing id
 *    gets, so the answer never tells an outsider the project exists. It is
 *    also needed on its own terms, because the permission resolver's
 *    org-role fallback grants an org member their role's permissions on
 *    projects hidden from them;
 *  - CONTEXT_DELETE, the permission `delete-context.ts` requires, so this is
 *    never broader than the tab's own delete (FORBIDDEN, to a caller who can
 *    see the project);
 *  - the project's hosting organization, never a caller-supplied one.
 *
 * A thrown call carries no file content (the input is a path and a hash), so
 * the audit-error middleware may record it as it records any failure.
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
import { deleteSyncedContext } from "../../lib/delete-synced-context";
import { syncedContextDeleteConflictMessage } from "../../lib/synced-context-conflict";

/** The upsert twin's bound on the path as sent, before normalising. */
const MAX_SOURCE_PATH_INPUT_LENGTH = 2048;

export const deleteSyncedFileProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/contexts/synced-files",
		tags: ["Projects", "Contexts"],
		summary: "Delete a synced context file by path",
		description:
			"Delete a file pushed into the project's Context by its path, but only the version named in `expectedContentHash`: when the path holds another version (someone changed it since), the call answers CONFLICT with the stored hash and who last changed it, and deletes nothing. A path with no source answers `absent`. A file synced from a connected repository answers CONFLICT with `data.code` `REPOSITORY_MANAGED`, naming the repository and branch to remove it from. The source is deleted at once and its entries in the search index are queued for removal in the same step.",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			sourcePath: z
				.string()
				.min(1)
				.max(MAX_SOURCE_PATH_INPUT_LENGTH)
				.describe(
					"The path the file was pushed under, e.g. `docs/architecture.md`, normalised as on push.",
				),
			expectedContentHash: z
				.string()
				.regex(/^[0-9a-fA-F]{64}$/)
				.describe(
					"The `contentHash` of the version you mean to delete, from a previous push or from a CONFLICT. Required: a delete never removes a version you have not named.",
				),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const access = await resolveEffectiveProjectPermissions(
			input.projectId,
			user.id,
		);
		// Visibility was answered by `projectNotFoundUnlessVisible`; this
		// resolution is for the hosting organization, and refuses on the
		// permission gate's terms so the two can never disagree.
		if (!access) {
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		}

		if (
			access.source !== "owner" &&
			!hasPermission(access.permissions, Permissions.CONTEXT_DELETE)
		) {
			throw new ORPCError("FORBIDDEN", {
				message: `Missing required permission: ${Permissions.CONTEXT_DELETE}`,
			});
		}

		const result = await deleteSyncedContext({
			projectId: input.projectId,
			sourcePath: input.sourcePath,
			expectedContentHash: input.expectedContentHash,
			userId: user.id,
			organizationId: access.organizationId,
			via: "web",
			request: context,
		});

		if (result.status === "conflict") {
			throw new ORPCError("CONFLICT", {
				message: syncedContextDeleteConflictMessage(),
				data: result,
			});
		}

		return result;
	});
