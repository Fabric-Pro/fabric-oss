/**
 * `projects.contexts.repositorySync.syncNow` — "Sync now" for the project's
 * Living Memory (design 2026-09-23 §5.1, §5.6, Fizzy #2657): a MANUAL run
 * acting as the caller.
 *
 * Authorization, in order: `projectNotFoundUnlessVisible`, then
 * CONTEXT_CREATE, then the hosting organization resolved server-side
 * (`resolveContextSyncAccess`); any `organizationId` in the input is ignored.
 * The workflow re-checks the acting member's CONTEXT_CREATE when it begins.
 *
 * Before starting, reconciliation (`./reconcile`) completes receipts whose
 * execution Temporal reports closed and refuses while one is running or
 * cannot be described. The start uses ONE workflow id per project with
 * `workflowIdConflictPolicy: "FAIL"`, so a concurrent start is refused by
 * Temporal itself and answered `already_running` too.
 */
import { getContextRepositorySync } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { startContextRepositorySync } from "../../../lib/context-repository-sync-workflow";
import { resolveContextSyncAccess } from "./access";
import { reconcileContextRepositorySync } from "./reconcile";

export const syncContextRepositoryNowProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/repository-sync/run",
		tags: ["Projects", "Contexts"],
		summary: "Sync the Living Memory from the repository now",
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
		const sync = await getContextRepositorySync(
			input.projectId,
			organizationId,
		);
		if (!sync) {
			return {
				started: false as const,
				reason: "not_configured" as const,
			};
		}
		if (sync.repositoryIntegration.status !== "ACTIVE") {
			return {
				started: false as const,
				reason: "integration_unavailable" as const,
			};
		}

		const reconciled = await reconcileContextRepositorySync({
			projectId: input.projectId,
			organizationId,
			syncId: sync.id,
			activeRunKey: sync.activeRunKey,
		});
		if (reconciled.status === "not-configured") {
			return {
				started: false as const,
				reason: "not_configured" as const,
			};
		}
		if (reconciled.status === "busy") {
			return {
				started: false as const,
				reason: "already_running" as const,
			};
		}

		const started = await startContextRepositorySync({
			projectId: input.projectId,
			organizationId,
			trigger: "MANUAL",
			requesterUserId: context.user.id,
		});
		if (!started) {
			return {
				started: false as const,
				reason: "already_running" as const,
			};
		}
		recordAuditFromRequest(context, {
			action: "project.context.repository_sync_started",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_context_repository_sync",
				id: sync.id,
				name: `${sync.repositoryIntegration.repositoryOwner}/${sync.repositoryIntegration.repositoryName}`,
			},
			metadata: { trigger: "MANUAL" },
		});
		return { started: true as const };
	});
