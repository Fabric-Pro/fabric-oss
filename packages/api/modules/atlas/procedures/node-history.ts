import { AtlasService, getNodeHistoryInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** Override edit history for a node (field, old → new, editor, when). */
export const nodeHistoryProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/node/history",
		tags: ["Atlas"],
		summary: "List a node's user-override edit history",
	})
	.input(getNodeHistoryInputSchema)
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
				history: await service.getNodeHistory({
					projectId: input.projectId,
					analysisId: input.analysisId,
					mode: input.mode,
					key: input.key,
				}),
			};
		} catch (error) {
			mapAtlasError(error);
		}
	});
