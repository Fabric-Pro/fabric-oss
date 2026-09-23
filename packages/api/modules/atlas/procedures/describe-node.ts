import { AtlasService, describeNodeInputSchema } from "@repo/atlas";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertCapabilityAvailable } from "../../capabilities/assert";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** On-demand AI description for a single FILE node (the "Describe with AI" button). */
export const describeNodeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/node/describe",
		tags: ["Atlas"],
		summary: "Generate an AI description for a single node on demand",
	})
	.input(describeNodeInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		// Same capability as the single-repository chat (Fizzy #1930): this is
		// AI over the codebase too, and an ungated sibling door would make the
		// gate on the other one a suggestion.
		await assertCapabilityAvailable({
			capabilityKey: "atlas.codebase-qa",
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			return await service.describeNodeOnDemand({
				projectId: input.projectId,
				analysisId: input.analysisId,
				mode: input.mode,
				key: input.key,
				instructions: input.instructions,
			});
		} catch (error) {
			mapAtlasError(error);
		}
	});
