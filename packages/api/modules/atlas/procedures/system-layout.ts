import { AtlasService, saveSystemLayoutInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Persist dragged node positions for the multi-repo "System map" canvas.
 * PROJECT_READ — rearranging is a collaborative action any member may perform
 * (positions are shared per project+mode), mirroring `saveLayout`.
 */
export const saveSystemLayoutProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/system-layout",
		tags: ["Atlas"],
		summary: "Save shared System-map node positions (draggable layout)",
	})
	.input(saveSystemLayoutInputSchema)
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
			return await service.saveSystemLayout({
				projectId: input.projectId,
				mode: input.mode,
				positions: input.positions,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
