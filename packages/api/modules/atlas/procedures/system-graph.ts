import { AtlasService, systemGraphInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** The merged multi-repository "System map" graph for a lens. */
export const systemGraphProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/system-graph",
		tags: ["Atlas"],
		summary: "Get the merged multi-repository System map graph",
	})
	.input(systemGraphInputSchema)
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
			return await service.getSystemGraph({
				projectId: input.projectId,
				repositoryIntegrationIds: input.repositoryIntegrationIds,
				mode: input.mode,
				includeDeleted: input.includeDeleted,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
