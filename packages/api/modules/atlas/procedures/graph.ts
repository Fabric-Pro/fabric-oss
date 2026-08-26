import { AtlasService, atlasGraphInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

export const atlasGraphProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/graph",
		tags: ["Atlas"],
		summary: "Get the analysed graph for a mode (technical/business)",
	})
	.input(atlasGraphInputSchema)
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
			return await service.getGraph({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				mode: input.mode,
				includeDeleted: input.includeDeleted,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
