/**
 * `projects.contexts.repositorySync.get` — the Context tab's Living Memory
 * repository-sync state (design 2026-09-23 §5.1, §7.1, Fizzy #2657).
 *
 * Authorization, in order: `projectNotFoundUnlessVisible` (a project the
 * caller cannot discover is NOT_FOUND, in the words a missing id gets,
 * before any permission is evaluated), then CONTEXT_READ, then the hosting
 * organization resolved server-side (`resolveContextSyncAccess`). Any
 * `organizationId` in the input is accepted for client compatibility and
 * ignored. Read-only members see the status; the repositories to choose from
 * go only to members holding CONTEXT_CREATE, who could configure with them.
 */
import {
	type ContextRepositorySyncRunReceipt,
	countAwaitingIndexContexts,
	countContextRepositorySyncRunCleanupPending,
	countManagedContexts,
	db,
	getContextRepositorySync,
	getContextRepositorySyncRun,
	getNewestContextRepositorySyncRun,
	listProjectRepoIntegrations,
} from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { isContextRepositorySyncRunning } from "../../../lib/context-repository-sync-workflow";
import { resolveContextSyncAccess } from "./access";
import { toContextSyncConfigurationView, toContextSyncRunView } from "./views";

export const getContextRepositorySyncProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/repository-sync",
		tags: ["Projects", "Contexts"],
		summary: "Get the Living Memory repository sync state",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { organizationId, canConfigure } = await resolveContextSyncAccess(
			input.projectId,
			context.user.id,
			Permissions.CONTEXT_READ,
		);
		const scope = { projectId: input.projectId, organizationId };
		const [sync, integrations] = await Promise.all([
			getContextRepositorySync(input.projectId, organizationId),
			canConfigure
				? listProjectRepoIntegrations(input.projectId)
				: Promise.resolve([]),
		]);
		const availableIntegrations = integrations.map((integration) => ({
			id: integration.id,
			provider: integration.provider,
			repositoryOwner: integration.repositoryOwner,
			repositoryName: integration.repositoryName,
			defaultBranch: integration.defaultBranch,
			status: integration.status,
		}));

		if (!sync) {
			return {
				canConfigure,
				running: false,
				configured: null,
				latestRun: null,
				lastAppliedRun: null,
				managedCount: 0,
				awaitingIndexCount: 0,
				cleanupPending: 0,
				availableIntegrations,
			};
		}

		const [
			running,
			latestRun,
			lastAppliedRun,
			managedCount,
			awaitingIndexCount,
		] = await Promise.all([
			isContextRepositorySyncRunning(input.projectId),
			getNewestContextRepositorySyncRun(sync.id, scope),
			sync.lastAppliedRunId
				? getContextRepositorySyncRun(sync.lastAppliedRunId, scope)
				: Promise.resolve<ContextRepositorySyncRunReceipt | null>(null),
			countManagedContexts(db, input.projectId, sync.id),
			countAwaitingIndexContexts(input.projectId, sync.id),
		]);
		// Live from the queue: the records the run's prune stamped with its
		// run key that no drain has cleared yet (see the query's doc comment).
		const cleanupPending = lastAppliedRun
			? await countContextRepositorySyncRunCleanupPending(lastAppliedRun)
			: 0;

		return {
			canConfigure,
			running,
			configured: toContextSyncConfigurationView(sync),
			latestRun: latestRun ? toContextSyncRunView(latestRun) : null,
			lastAppliedRun: lastAppliedRun
				? toContextSyncRunView(lastAppliedRun)
				: null,
			managedCount,
			awaitingIndexCount,
			cleanupPending,
			availableIntegrations,
		};
	});
