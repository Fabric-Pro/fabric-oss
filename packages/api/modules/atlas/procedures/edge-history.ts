import { AtlasService, edgeHistoryInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** Edit history for a connection (edge) override (action, old → new, editor, when). */
export const edgeHistoryProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/edge/history",
		tags: ["Atlas"],
		summary: "List a connection's (edge) override edit history",
	})
	.input(edgeHistoryInputSchema)
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
			return {
				history: await service.getEdgeHistory({
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
				}),
			};
		} catch (error) {
			mapAtlasError(error);
		}
	});
