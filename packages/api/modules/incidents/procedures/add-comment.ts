/**
 * Add a free-text comment to an ErrorRateIncident (admin-only).
 *
 * Writes an `IncidentEvent(COMMENT)` row with the actor user ID. Allowed
 * at any time, including after RESOLVED (post-mortem notes). See spec
 * §4.4.1.
 */
import { ORPCError } from "@orpc/client";
import {
	addErrorRateIncidentComment,
	getErrorRateIncidentById,
} from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

export const addCommentProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/incidents/error-rate/{id}/comments",
		tags: ["Incidents"],
		summary: "Add a comment to an error-rate incident",
	})
	.input(
		z.object({
			id: z.string().min(1),
			message: z.string().min(1).max(4000),
		}),
	)
	.handler(async ({ input, context }) => {
		// Verify the incident exists before allowing a comment write — keeps
		// `IncidentEvent` orphans out of the DB.
		const incident = await getErrorRateIncidentById(input.id);
		if (!incident) {
			throw new ORPCError("NOT_FOUND", {
				message: `Error-rate incident not found: ${input.id}`,
			});
		}
		const event = await addErrorRateIncidentComment({
			incidentId: input.id,
			actorUserId: context.user.id,
			message: input.message,
		});
		return { event };
	});
