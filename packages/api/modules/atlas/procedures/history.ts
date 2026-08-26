import { AtlasService, atlasHistoryInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** Analysis history (who / when / commit) for a project's repository. */
export const atlasHistoryProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/history",
		tags: ["Atlas"],
		summary: "List recent analysis runs (who/when/commit) for a repository",
	})
	.input(atlasHistoryInputSchema)
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
			// Returns { runs, total } — total drives the panel's "X analyses"
			// label and the "Show more" affordance (offset-based pagination).
			return await service.getHistory({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				limit: input.limit,
				offset: input.offset,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
