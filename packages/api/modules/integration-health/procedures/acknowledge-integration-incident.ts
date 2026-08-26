/**
 * Acknowledge an IntegrationIncident (admin-only).
 *
 * Transactional: updates `status = ACKNOWLEDGED` + writes an
 * `IncidentEvent(ACKNOWLEDGED)` row. Also signals the lifecycle workflow
 * `incident-{id}` so the per-incident workflow can short-circuit. Manual
 * acknowledge/resolve writes an IncidentEvent AND signals the workflow —
 * whichever lands first wins, the other is a no-op.
 */
import { ORPCError } from "@orpc/client";
import { acknowledgeIntegrationIncident } from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";
import { signalIncidentAcknowledged } from "../../incidents/lib/lifecycle-signal";

export const acknowledgeIntegrationIncidentProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/integration-health/incidents/{id}/acknowledge",
		tags: ["Integration Health"],
		summary: "Acknowledge an integration incident",
	})
	.input(
		z.object({
			id: z.string().min(1),
			note: z.string().max(2000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const updated = await acknowledgeIntegrationIncident({
			incidentId: input.id,
			actorUserId: context.user.id,
			note: input.note,
		});
		if (!updated) {
			throw new ORPCError("NOT_FOUND", {
				message: `Integration incident not found: ${input.id}`,
			});
		}
		await signalIncidentAcknowledged({
			incidentId: input.id,
			userId: context.user.id,
			note: input.note,
		});
		return { incident: updated };
	});
