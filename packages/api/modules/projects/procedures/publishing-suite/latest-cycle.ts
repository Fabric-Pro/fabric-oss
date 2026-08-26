import { getLatestPublishingCycle } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

export const latestPublishingCycleProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/latest-cycle",
		tags: ["Projects", "Publishing Suite"],
		summary: "Get the project's latest publishing suggestion cycle",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_READ) gates
		// project access.
		const cycle = await getLatestPublishingCycle(input.projectId);
		return { cycle };
	});
