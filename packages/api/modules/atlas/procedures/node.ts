import { AtlasService, atlasNodeInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

export const atlasNodeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/node",
		tags: ["Atlas"],
		summary: "Get a single node's detail (AI description + neighbours)",
	})
	.input(atlasNodeInputSchema)
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
			return await service.getNode({
				projectId: input.projectId,
				analysisId: input.analysisId,
				mode: input.mode,
				key: input.key,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
