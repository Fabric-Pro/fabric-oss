/**
 * Manually resolve an ErrorRateIncident (admin-only).
 *
 * Used for the rare case where Alertmanager's `resolved` event is missed
 * (network partition, Prometheus restart) and an admin needs to close the
 * incident by hand. Writes an `IncidentEvent(MANUAL_RESOLVED)` and flips
 * `status = RESOLVED` + sets `resolvedAt`.
 *
 * Also signals the lifecycle workflow's `resolved` channel so the per-
 * incident workflow can short-circuit its 7-day wait and emit the
 * recovery notification. Both code paths are idempotent — whichever
 * lands first wins, the other is a no-op.
 */
import { ORPCError } from "@orpc/client";
import { resolveErrorRateIncident } from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";
import { signalIncidentResolved } from "../lib/lifecycle-signal";

export const resolveErrorRateIncidentProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/incidents/error-rate/{id}/resolve",
		tags: ["Incidents"],
		summary: "Manually resolve an error-rate incident",
	})
	.input(
		z.object({
			id: z.string().min(1),
			note: z.string().max(2000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const updated = await resolveErrorRateIncident({
			incidentId: input.id,
			actorUserId: context.user.id,
			note: input.note,
		});
		if (!updated) {
			throw new ORPCError("NOT_FOUND", {
				message: `Error-rate incident not found: ${input.id}`,
			});
		}
		await signalIncidentResolved({
			incidentId: input.id,
			userId: context.user.id,
			reason: input.note ?? "MANUAL_RESOLVED",
		});
		return { incident: updated };
	});
