/**
 * Get a single ErrorRateIncident with its event timeline (admin-only).
 *
 * Returns the incident row plus all `IncidentEvent` rows ordered ascending
 * by `createdAt`, with the actor user joined in.
 */
import { ORPCError } from "@orpc/client";
import { getErrorRateIncidentById } from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

export const getErrorRateIncidentProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/incidents/error-rate/{id}",
		tags: ["Incidents"],
		summary: "Get an error-rate incident with event timeline",
	})
	.input(z.object({ id: z.string().min(1) }))
	.handler(async ({ input }) => {
		const incident = await getErrorRateIncidentById(input.id);
		if (!incident) {
			throw new ORPCError("NOT_FOUND", {
				message: `Error-rate incident not found: ${input.id}`,
			});
		}
		// Caller can read `incident.events` for the timeline.
		const { events, ...incidentRow } = incident;
		return { incident: incidentRow, events };
	});
