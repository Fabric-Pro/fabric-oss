/**
 * Manually resolve an IntegrationIncident (admin-only).
 *
 * Used when Statuspage polling or synthetic probes have not yet confirmed
 * recovery but an admin has independently verified the provider is back.
 * Writes `IncidentEvent(MANUAL_RESOLVED)` and flips `status = RESOLVED`
 * + sets `resolvedAt`. Signals the lifecycle workflow's `resolved` channel
 * so the workflow can emit the recovery notification.
 *
 * Idempotent — a second call after resolution returns the row unchanged.
 */
import { ORPCError } from "@orpc/client";
import { resolveIntegrationIncident } from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";
import { signalIncidentResolved } from "../../incidents/lib/lifecycle-signal";

export const resolveIntegrationIncidentProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/integration-health/incidents/{id}/resolve",
		tags: ["Integration Health"],
		summary: "Manually resolve an integration incident",
	})
	.input(
		z.object({
			id: z.string().min(1),
			note: z.string().max(2000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const updated = await resolveIntegrationIncident({
			incidentId: input.id,
			actorUserId: context.user.id,
			note: input.note,
		});
		if (!updated) {
			throw new ORPCError("NOT_FOUND", {
				message: `Integration incident not found: ${input.id}`,
			});
		}
		await signalIncidentResolved({
			incidentId: input.id,
			userId: context.user.id,
			reason: input.note ?? "MANUAL_RESOLVED",
		});
		return { incident: updated };
	});
