import { AtlasService, systemRemapHistoryInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * System-map relationship history — the cross-link recompute runs (auto + user
 * re-maps) with cost / tokens / model / duration. READ-gated (observability).
 */
export const systemRemapHistoryProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/system-remap-history",
		tags: ["Atlas"],
		summary: "List System-map relationship recompute (re-map) runs",
	})
	.input(systemRemapHistoryInputSchema)
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
			return await service.getSystemRemapHistory({
				projectId: input.projectId,
				limit: input.limit,
				offset: input.offset,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
