import { AtlasService, updateEdgeInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Save a STABLE user description override for a graph edge (solo intra-repo OR
 * System-map cross-repo). Keyed by endpoints so it survives re-analysis; an
 * edit-history row is written and the effective override is returned. Mirrors
 * `updateNode` (PROJECT_SETTINGS_EDIT — an authoritative edit of project data).
 */
export const updateEdgeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/edge/update",
		tags: ["Atlas"],
		summary: "Save a user description override for a connection (edge)",
	})
	.input(updateEdgeInputSchema)
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
			return await service.updateEdge({
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
				isUserKind: input.isUserKind,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
