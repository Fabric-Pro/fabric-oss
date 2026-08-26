import { ORPCError } from "@orpc/client";
import {
	getOpenDecisionsForStories,
	hasProjectAccess,
	type MaturationTenantFilter,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Batch ceiling. Raised from 500 once counts stopped being computed by fetching
 * every open row's text: the work is now a PK lookup plus an aggregate plus one
 * bounded LATERAL, so the cost scales with features that HAVE open questions
 * rather than with the backlog. 2000 is past any real project — and a caller
 * that exceeds it gets a validation error rather than a silently short answer,
 * because a partial count would distort the ranking the client derives from it.
 */
const MAX_STORY_IDS = 2000;

/**
 * How many questions travel per feature. The roadmap row shows them inline, so
 * this is a readability bound rather than a data one — beyond a few the row
 * stops being scannable and the reader should open the feature's Decision Log.
 * The count is always exact regardless of this cap.
 */
const MAX_QUESTIONS_PER_STORY = 3;

const OpenDecisionSummarySchema = z.object({
	id: z.string(),
	summary: z.string().nullable(),
	content: z.string().nullable(),
});

/**
 * Open decision threads for a batch of work items: an exact count plus the
 * first few questions themselves.
 *
 * The roadmap's Priority layout ranks on the count and shows the questions in
 * the expanded row. Both come from one query — the per-story alternative would
 * be a round trip per row.
 */
export const openDecisionsProcedure = tenantProtectedProcedure
	// `organizationId` is caller input and `resolveOrganizationId` returns it
	// verbatim, so without this the target tenant is whatever the client says.
	// `requireProjectPermission` does not close it either — it resolves on
	// (projectId, userId) and never reads the org. This asserts membership of
	// the org actually being queried.
	.use(requireInputOrgPermission(Permissions.STORY_READ))
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/open-decisions",
		tags: ["Projects", "Stories"],
		summary: "Open decision threads for a batch of work items",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyIds: z.array(z.string()).max(MAX_STORY_IDS),
		}),
	)
	.output(
		z.object({
			counts: z.record(z.string(), z.number()),
			questions: z.record(z.string(), z.array(OpenDecisionSummarySchema)),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const tenantFilter: MaturationTenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		return await getOpenDecisionsForStories({
			tenantFilter,
			projectId: input.projectId,
			userStoryIds: input.storyIds,
			maxPerStory: MAX_QUESTIONS_PER_STORY,
		});
	});
