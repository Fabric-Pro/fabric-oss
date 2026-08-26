import { AtlasService, saveLayoutInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Persist dragged node positions for the graph. PROJECT_READ — rearranging is a
 * collaborative action any member may perform (the layout is stored on the node
 * row, so it's shared by construction).
 */
export const saveLayoutProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/layout",
		tags: ["Atlas"],
		summary: "Save shared node positions (draggable layout)",
	})
	.input(saveLayoutInputSchema)
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
			return await service.saveLayout({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				mode: input.mode,
				positions: input.positions,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
