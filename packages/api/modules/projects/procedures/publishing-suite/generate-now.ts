import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";
import { requestPublishingGeneration } from "../../lib/request-publishing-generation";

export const generatePublishingTopicsNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/generate",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate topic suggestions now",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// Security ratchet — see `lib/publishing-topic-project.ts`. Its
		// `status: "ACTIVE", deletedAt: null` filter keeps this lookup in lockstep
		// with the eligibility filter `runPublishingSuggestionDispatch` re-applies
		// (find-eligible-projects.ts / dispatch-suggestion.ts F3) before it will do
		// anything. Without it, an archived or soft-deleted project resolves here,
		// the dispatch core silently no-ops on its own filter, and the caller is
		// told `{ status: "started" }` for a run that never happened.
		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		return await requestPublishingGeneration({
			projectId: project.id,
			triggeredByUserId: context.user.id,
		});
	});
