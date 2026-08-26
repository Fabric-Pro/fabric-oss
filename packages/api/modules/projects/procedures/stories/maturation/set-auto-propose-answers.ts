import { ORPCError } from "@orpc/client";
import { hasProjectAccess, setAutoProposeAnswers } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * `maturation.setAutoProposeAnswers` (#7) — toggle whether maturation runs auto-
 * propose AI answers for newly minted open questions on this feature. ON by default;
 * disabling is per-feature only and never cascades to other features.
 *
 * PM-SYNC ISOLATION (§7.7): writes ONLY the toggle, never
 * `description`/`acceptanceCriteria`, so it does not touch the dev-facing Clean Spec
 * and must not trigger PM sync. This file does not import `enqueuePmSync`.
 */
export const setAutoProposeAnswersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/auto-propose-answers",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Toggle auto-propose AI answers for this feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			enabled: z.boolean(),
		}),
	)
	.output(z.object({ enabled: z.boolean() }))
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

		const count = await setAutoProposeAnswers({
			userStoryId: input.storyId,
			projectId: input.projectId,
			enabled: input.enabled,
		});
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}
		return { enabled: input.enabled };
	});
