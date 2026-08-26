import { AtlasService, atlasStatusInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

export const atlasStatusProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/status",
		tags: ["Atlas"],
		summary: "Analysis status + new-commit count for a repository",
	})
	.input(atlasStatusInputSchema)
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
			return await service.getStatus({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
