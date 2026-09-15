/**
 * Reject Stage Transition Request
 *
 * AUTHORIZATION: requireProjectPermission(STORY_STAGE_APPROVE). The database
 * function additionally requires the reviewer to be a configured
 * `ProjectStageApprover` and forbids reviewing one's own request.
 */

import {
	rejectStageTransitionRequest,
	type StageTransitionActor,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { mapStageTransitionError } from "../../../lib/stage-transition-errors";

export const rejectStageRequestProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_STAGE_APPROVE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/stage-requests/{requestId}/reject",
		tags: ["Projects", "Features", "Governance"],
		summary: "Reject a drafting-stage transition request",
	})
	.input(
		z.object({
			projectId: z.string(),
			requestId: z.string(),
			organizationId: z.string().nullable().optional(),
			note: z.string().max(2000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			context.user.id,
		);
		const reviewer: StageTransitionActor = {
			userId: context.user.id,
			organizationId: organizationId ?? null,
		};
		try {
			const result = await rejectStageTransitionRequest({
				requestId: input.requestId,
				projectId: input.projectId,
				reviewer,
				note: input.note,
			});
			return { success: true as const, ...result };
		} catch (error) {
			throw mapStageTransitionError(error);
		}
	});
