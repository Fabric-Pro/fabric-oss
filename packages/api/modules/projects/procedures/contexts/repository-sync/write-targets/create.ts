/**
 * `projects.contexts.repositorySync.writeTargets.create` — name a folder of
 * the project's Living Memory sync that agents' files are written into
 * (ADR-022).
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then
 * CONTEXT_CREATE, then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`); the request carries no organization. A target
 * whose mode is DIRECT_PUSH also needs PROJECT_SETTINGS_EDIT (project admin
 * and up): it lets agents commit to the synced branch without a pull request,
 * which is an administrator's decision. That is checked on the result, and
 * answered `FORBIDDEN` with `data.code = "DIRECT_PUSH_REQUIRES_ADMIN"`. Fabric
 * records who turned it on and when.
 *
 * Everything else is decided in one transaction under the sync's
 * configuration lock, against the sync as it stands there
 * (`createContextWriteTarget`, `validateWriteTargetFolder`), so a concurrent
 * `configure` cannot leave a target outside the selection it just replaced.
 * No network, no credential and no run is involved: adding a write folder
 * changes nothing that is synced.
 *
 * Refusals are `BAD_REQUEST` with `data.code` and `data.path`: `INVALID_PATH`,
 * `TARGET_OUTSIDE_SELECTION`, `TARGET_EXCLUDED`, `TARGET_OVERLAP` and
 * `TARGET_OVERLAPS_INSTRUCTIONS` (with `data.withPath`, the other folder),
 * `TOO_MANY_TARGETS`, and `NOT_CONFIGURED` when the project has no sync.
 * Audited as `project.context.write_target_created`.
 */
import { createContextWriteTarget } from "@repo/database";
import { validateWriteTargetFolder } from "@repo/temporal/memory-write/target-rules";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../../orpc/procedures";
import { resolveContextSyncAccess } from "../access";
import { MAX_CONTEXT_SYNC_PATH_LENGTH } from "../paths";
import { settleIndexingChange } from "./indexing-effects";
import {
	toWriteTargetView,
	type WriteTargetRefusal,
	writeTargetRefusalError,
	writeTargetsNotConfigured,
} from "./shared";

export const createContextWriteTargetProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/repository-sync/write-targets",
		tags: ["Projects", "Contexts"],
		summary: "Add a Living Memory write folder",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			folder: z.string().max(MAX_CONTEXT_SYNC_PATH_LENGTH),
			mode: z
				.enum(["PULL_REQUEST", "DIRECT_PUSH"])
				.default("PULL_REQUEST"),
			indexMode: z.enum(["INDEXED", "STORE_ONLY"]).default("INDEXED"),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId, canEnableDirectPush } =
			await resolveContextSyncAccess(
				input.projectId,
				context.user.id,
				Permissions.CONTEXT_CREATE,
			);

		const result = await createContextWriteTarget<WriteTargetRefusal>(
			{
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
			},
			(state) => {
				if (input.mode === "DIRECT_PUSH" && !canEnableDirectPush) {
					return {
						accept: false,
						refusal: { kind: "direct-push-requires-admin" },
					};
				}
				const problem = validateWriteTargetFolder({
					folder: input.folder,
					selection: state.sync,
					instructionRoots: state.instructionRoots,
					siblingFolders: state.siblings.map(
						(sibling) => sibling.folder,
					),
				});
				return problem
					? { accept: false, refusal: { kind: "invalid", problem } }
					: {
							accept: true,
							folder: input.folder,
							mode: input.mode,
							indexMode: input.indexMode,
						};
			},
		);
		if (result.status === "not-configured") {
			throw writeTargetsNotConfigured();
		}
		if (result.status === "refused") {
			throw writeTargetRefusalError(result.refusal);
		}

		const { target, reindex } = result;
		recordAuditFromRequest(context, {
			action: "project.context.write_target_created",
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
				indexMode: target.indexMode,
			},
		});
		await settleIndexingChange({
			reindex,
			projectId: input.projectId,
			organizationId,
			syncId: target.syncId,
			userId: context.user.id,
		});
		return toWriteTargetView(target);
	});
