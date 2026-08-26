import {
	AtlasService,
	listBranchesInputSchema,
	setPinnedBranchesInputSchema,
} from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** List the connected repository's branches (default + pinned first). */
export const listBranchesProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/branches",
		tags: ["Atlas"],
		summary: "List the repository's branches for the Atlas branch switcher",
	})
	.input(listBranchesInputSchema)
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
				branches: await service.listBranches({
					projectId: input.projectId,
					repositoryIntegrationId:
						input.repositoryIntegrationId ?? null,
				}),
			};
		} catch (error) {
			mapAtlasError(error);
		}
	});

/** Replace the pinned-branches set for a repository (per project+repo). */
export const setPinnedBranchesProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/branches/pin",
		tags: ["Atlas"],
		summary: "Set the pinned branches for a repository",
	})
	.input(setPinnedBranchesInputSchema)
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
			return await service.setPinnedBranches({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				branches: input.branches,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
