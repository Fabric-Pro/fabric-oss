import { AtlasService, createEdgeInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Create a MANUAL connection (user-drawn edge with no underlying AI/structural
 * edge). Restores a previously-deleted override for the same endpoints instead
 * of duplicating it. Mirrors `updateNode` (PROJECT_SETTINGS_EDIT).
 */
export const createEdgeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/edge/create",
		tags: ["Atlas"],
		summary: "Create a manual connection (edge) between two nodes",
	})
	.input(createEdgeInputSchema)
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
			return await service.createEdge({
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
				kind: input.kind,
				userDescription: input.userDescription,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
