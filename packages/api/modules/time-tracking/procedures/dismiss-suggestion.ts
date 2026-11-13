import { ORPCError } from "@orpc/server";
import { dismissTimeSuggestion } from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	assertProjectPermission,
	Permissions,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertProjectVisible } from "../lib/project-access";
import { requireOwnSuggestion } from "../lib/suggestions";

export const dismissTimeSuggestionInputSchema = z.object({
	suggestionId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * Dismiss one of the caller's own suggestions. Dismissing it again answers
 * the same. Its evidence stays with it, so the same activity is not suggested
 * again; new activity is.
 *
 * Someone else's suggestion answers NOT_FOUND. The caller must still see the
 * suggestion's project and hold TIME_LOG there, checked in the handler as for
 * `deleteEntry`.
 */
export const dismissTimeSuggestionProcedure = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/time-tracking/suggestions/{suggestionId}/dismiss",
		tags: ["Time tracking"],
		summary: "Dismiss a time suggestion",
		description:
			"Dismisses one of the caller's own pending suggestions. Dismissing an already dismissed suggestion succeeds; a confirmed one cannot be dismissed.",
	})
	.input(dismissTimeSuggestionInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const suggestion = await requireOwnSuggestion({
			suggestionId: input.suggestionId,
			userId,
		});
		await assertProjectVisible(suggestion.projectId, userId);
		await assertProjectPermission(
			suggestion.projectId,
			userId,
			Permissions.TIME_LOG,
		);

		if (suggestion.status !== "DISMISSED") {
			const moved = await dismissTimeSuggestion({
				id: suggestion.id,
				userId,
			});
			// Not PENDING any more: dismissed meanwhile is the answer asked
			// for, confirmed is not.
			const current = moved
				? null
				: await requireOwnSuggestion({
						suggestionId: suggestion.id,
						userId,
					});
			if (current && current.status !== "DISMISSED") {
				throw new ORPCError("CONFLICT", {
					message: "A confirmed suggestion cannot be dismissed",
				});
			}
		}
		return { id: suggestion.id, status: "DISMISSED" as const };
	});
