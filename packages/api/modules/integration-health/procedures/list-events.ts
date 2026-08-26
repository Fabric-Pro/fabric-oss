/**
 * List the event timeline for a single `IntegrationIncident` (admin-only).
 *
 * Returns ack / close / comment events ordered ascending by `createdAt` so
 * the UI can render top-to-bottom in chronological order. Each event
 * carries the actor (id/name/image) joined in. Parallel to the
 * `incidents.errorRate.listEvents` procedure.
 *
 * Auth: `adminProcedure` — the underlying `IncidentEvent` table is global
 * and reveals actor identity, which we don't expose to non-admin users.
 */
import { ORPCError } from "@orpc/client";
import {
	getIntegrationIncidentById,
	listIntegrationIncidentEvents,
} from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

export const listIntegrationEventsProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/integration-health/incidents/{id}/events",
		tags: ["Integration Health"],
		summary: "List events for an integration incident",
	})
	.input(z.object({ id: z.string().min(1) }))
	.handler(async ({ input }) => {
		const incident = await getIntegrationIncidentById(input.id);
		if (!incident) {
			throw new ORPCError("NOT_FOUND", {
				message: `Integration incident not found: ${input.id}`,
			});
		}
		const events = await listIntegrationIncidentEvents(input.id);
		return { events };
	});
