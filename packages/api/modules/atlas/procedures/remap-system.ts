import { AtlasService, remapSystemInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Force a re-map of the System map's cross-repo relationships. Unlike the
 * idempotent, viewer-triggerable `linkRepositories` auto-recompute, this is a
 * WRITE action (it recomputes, and `fresh` deletes the user's cross-repo edge
 * edits) — gated at the editor permission.
 */
export const remapSystemProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/remap-system",
		tags: ["Atlas"],
		summary: "Force a re-map of cross-repository relationships",
	})
	.input(remapSystemInputSchema)
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
				force: input.fresh ? "fresh" : "keep",
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
