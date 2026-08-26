import { AtlasService, deleteEdgeInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Soft-delete a connection (edge). For an AI/structural edge with no override
 * yet, a tracking override is created first so the removal is recorded. Mirrors
 * `updateNode` (PROJECT_SETTINGS_EDIT).
 */
export const deleteEdgeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/edge/delete",
		tags: ["Atlas"],
		summary: "Soft-delete a connection (edge)",
	})
	.input(deleteEdgeInputSchema)
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
			return await service.deleteEdge({
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
