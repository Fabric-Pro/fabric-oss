/**
 * List the event timeline for a `ComponentIncident` (admin-only).
 *
 * Parallel to `incidents.errorRate.listEvents` and
 * `integrationHealth.listEvents`: returns ack / resolve / comment events
 * ascending by `createdAt` so the UI renders top-to-bottom chronologically.
 * Each event carries the actor (id/name/image) joined in.
 *
 * Used by the admin monitoring timeline's expand drill-down for component
 * rows (Fabric subsystem outages — Temporal worker stalled, RAG indexer
 * backed up, etc.).
 *
 * Auth: `adminProcedure` — the `IncidentEvent` table is global and reveals
 * actor identity, which we don't expose to non-admin users.
 */
import { ORPCError } from "@orpc/client";
import {
	getComponentIncidentById,
	listComponentIncidentEvents,
} from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

export const listComponentEventsProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/incidents/component/{id}/events",
		tags: ["Incidents"],
		summary: "List events for a component incident",
	})
	.input(z.object({ id: z.string().min(1) }))
	.handler(async ({ input }) => {
		const incident = await getComponentIncidentById(input.id);
		if (!incident) {
			throw new ORPCError("NOT_FOUND", {
				message: `Component incident not found: ${input.id}`,
			});
		}
		const events = await listComponentIncidentEvents(input.id);
		return { events };
	});
