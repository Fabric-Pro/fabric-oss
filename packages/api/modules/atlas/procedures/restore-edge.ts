import { AtlasService, restoreEdgeInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Restore a soft-deleted connection (edge) — clears `deletedAt` and records a
 * `restored` history row. Mirrors `updateNode` (PROJECT_SETTINGS_EDIT).
 */
export const restoreEdgeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/edge/restore",
		tags: ["Atlas"],
		summary: "Restore a soft-deleted connection (edge)",
	})
	.input(restoreEdgeInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			return await service.restoreEdge({
				projectId: input.projectId,
				mode: input.mode,
				source: {
					repositoryIntegrationId:
						input.sourceRepositoryIntegrationId ?? null,
					key: input.sourceKey,
				},
				target: {
					repositoryIntegrationId:
						input.targetRepositoryIntegrationId ?? null,
					key: input.targetKey,
				},
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
