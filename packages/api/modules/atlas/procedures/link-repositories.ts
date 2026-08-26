import { AtlasService, linkRepositoriesInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Detect & persist the project's cross-repository relationships for the System
 * map (structural always; AI best-effort). Idempotent — a no-op when the
 * participating analyses are unchanged. READ-gated: it only derives graph
 * metadata, so any project viewer may populate the map.
 */
export const linkRepositoriesProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/link-repositories",
		tags: ["Atlas"],
		summary: "Detect & persist cross-repository relationships",
	})
	.input(linkRepositoriesInputSchema)
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
			return await service.linkRepositories({
				projectId: input.projectId,
				repositoryIntegrationIds: input.repositoryIntegrationIds,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
