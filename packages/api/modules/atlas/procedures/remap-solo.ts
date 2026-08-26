import { AtlasService, remapSoloInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Re-map a SOLO repo's relationships via the AI intra-repo reference pass.
 * `fresh` wipes this repo's edge edits (both lenses) first; otherwise only the
 * prior AI-generated references are replaced and the user's edits are kept. A
 * WRITE action — gated at the editor permission.
 */
export const remapSoloProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/remap-solo",
		tags: ["Atlas"],
		summary: "Re-map a single repository's relationships (AI references)",
	})
	.input(remapSoloInputSchema)
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
			return await service.remapSolo({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				fresh: input.fresh,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
