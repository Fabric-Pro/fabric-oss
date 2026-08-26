import { AtlasService, updateNodeInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Save a STABLE user override (description / category) for a node. The override
 * is keyed by (project, repo, branch, mode, node key) so it survives
 * re-analysis, an edit-history row is written per changed field, and the updated
 * effective node detail is returned.
 */
export const updateNodeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/node/update",
		tags: ["Atlas"],
		summary: "Save a user override (description/category) for a node",
	})
	.input(updateNodeInputSchema)
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
			return await service.updateNode({
				projectId: input.projectId,
				analysisId: input.analysisId,
				mode: input.mode,
				key: input.key,
				userDescription: input.userDescription,
				userCategory: input.userCategory,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
