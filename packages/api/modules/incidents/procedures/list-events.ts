/**
 * List the event timeline for an ErrorRateIncident (admin-only).
 *
 * Returns the rows in ascending `createdAt` order so the UI can render
 * top-to-bottom in chronological order. Each event carries the actor
 * (id/name/image) joined in.
 */
import { ORPCError } from "@orpc/client";
import {
	getErrorRateIncidentById,
	listErrorRateIncidentEvents,
} from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

export const listEventsProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/incidents/error-rate/{id}/events",
		tags: ["Incidents"],
		summary: "List events for an error-rate incident",
	})
	.input(z.object({ id: z.string().min(1) }))
	.handler(async ({ input }) => {
		const incident = await getErrorRateIncidentById(input.id);
		if (!incident) {
			throw new ORPCError("NOT_FOUND", {
				message: `Error-rate incident not found: ${input.id}`,
			});
		}
		const events = await listErrorRateIncidentEvents(input.id);
		return { events };
	});
