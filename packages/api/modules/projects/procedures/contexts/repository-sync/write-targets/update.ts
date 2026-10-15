/**
 * `projects.contexts.repositorySync.writeTargets.update` — change a Living
 * Memory write folder's folder or mode (ADR-022).
 *
 * Authorization is `create`'s: `projectNotFoundUnlessVisible`, CONTEXT_CREATE,
 * the hosting organization resolved server-side. A change whose RESULT is
 * DIRECT_PUSH also needs PROJECT_SETTINGS_EDIT, whether the target already was
 * DIRECT_PUSH or not: re-pointing a direct-push target at another folder is
 * turning direct push on for that folder. The check is made inside the
 * transaction, on the target as stored there, so a request that read the
 * target a moment ago cannot slip past it. Switching to PULL_REQUEST needs
 * only CONTEXT_CREATE, and so does everything that does not end in
 * DIRECT_PUSH.
 *
 * Moving into DIRECT_PUSH, or re-pointing a DIRECT_PUSH target, records who
 * did it and when; leaving DIRECT_PUSH clears both. Every update bumps the
 * target's `version`, which a write admitted against the old version is
 * recorded under, and makes the caller the member who last edited it.
 *
 * The folder is validated again (`validateWriteTargetFolder`) when it
 * changes or when the result is DIRECT_PUSH, against the sync as it stands
 * under the lock. A target a later `configure` has left outside the selection
 * can therefore always be made PULL_REQUEST, or deleted, but never turned on
 * for direct push.
 *
 * Refusals are `create`'s, plus `NOTHING_TO_UPDATE` when neither a folder nor
 * a mode was sent and `NOT_FOUND` for a target that is not this project's.
 * Audited as `project.context.write_target_updated`.
 */
import { updateContextWriteTarget } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../../orpc/procedures";
import { validateWriteTargetFolder } from "../../../../lib/memory-write/target-rules";
import { resolveContextSyncAccess } from "../access";
import { MAX_CONTEXT_SYNC_PATH_LENGTH } from "../paths";
import {
	toWriteTargetView,
	type WriteTargetRefusal,
	writeTargetNotFound,
	writeTargetRefusalError,
	writeTargetsNotConfigured,
} from "./shared";

export const updateContextWriteTargetProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/contexts/repository-sync/write-targets/:targetId",
		tags: ["Projects", "Contexts"],
		summary: "Change a Living Memory write folder",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			targetId: z.string().min(1).max(128),
			folder: z.string().max(MAX_CONTEXT_SYNC_PATH_LENGTH).optional(),
			mode: z.enum(["PULL_REQUEST", "DIRECT_PUSH"]).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId, canEnableDirectPush } =
			await resolveContextSyncAccess(
				input.projectId,
				context.user.id,
				Permissions.CONTEXT_CREATE,
			);
		if (input.folder === undefined && input.mode === undefined) {
			throw writeTargetRefusalError({ kind: "nothing-to-update" });
		}

		const result = await updateContextWriteTarget<WriteTargetRefusal>(
			{
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
				targetId: input.targetId,
			},
			(state, current) => {
				const folder = input.folder ?? current.folder;
				const mode = input.mode ?? current.mode;
				if (mode === "DIRECT_PUSH" && !canEnableDirectPush) {
					return {
						accept: false,
						refusal: { kind: "direct-push-requires-admin" },
					};
				}
				if (folder !== current.folder || mode === "DIRECT_PUSH") {
					const problem = validateWriteTargetFolder({
						folder,
						selection: state.sync,
						instructionRoots: state.instructionRoots,
						siblingFolders: state.siblings.map(
							(sibling) => sibling.folder,
						),
					});
					if (problem) {
						return {
							accept: false,
							refusal: { kind: "invalid", problem },
						};
					}
				}
				return { accept: true, folder, mode };
			},
		);
		if (result.status === "not-configured") {
			throw writeTargetsNotConfigured();
		}
		if (result.status === "not-found") {
			throw writeTargetNotFound();
		}
		if (result.status === "refused") {
			throw writeTargetRefusalError(result.refusal);
		}

		const { target, previous } = result;
		recordAuditFromRequest(context, {
			action: "project.context.write_target_updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_context_write_target",
				id: target.id,
				name: target.folder,
			},
			metadata: {
				folder: target.folder,
				mode: target.mode,
				previousFolder: previous.folder,
				previousMode: previous.mode,
				version: target.version,
			},
		});
		return toWriteTargetView(target);
	});
