/**
 * Add a free-text comment to an IntegrationIncident (admin-only).
 *
 * Writes an `IncidentEvent(COMMENT)` row with the actor user ID. Allowed
 * at any time, including after RESOLVED (post-mortem notes).
 */
import { ORPCError } from "@orpc/client";
import {
	addIntegrationIncidentComment,
	getIntegrationIncidentById,
} from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

export const addIntegrationCommentProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/integration-health/incidents/{id}/comments",
		tags: ["Integration Health"],
		summary: "Add a comment to an integration incident",
	})
	.input(
		z.object({
			id: z.string().min(1),
			message: z.string().min(1).max(4000),
		}),
	)
	.handler(async ({ input, context }) => {
		const incident = await getIntegrationIncidentById(input.id);
		if (!incident) {
			throw new ORPCError("NOT_FOUND", {
				message: `Integration incident not found: ${input.id}`,
			});
		}
		const event = await addIntegrationIncidentComment({
			incidentId: input.id,
			actorUserId: context.user.id,
			message: input.message,
		});
		return { event };
	});
