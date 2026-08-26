/**
 * Acknowledge an ErrorRateIncident (admin-only).
 *
 * Transaction: updates `status = ACKNOWLEDGED` + writes an
 * `IncidentEvent(ACKNOWLEDGED)` row with the actor user ID. Idempotent —
 * a second call after acknowledgement is a no-op.
 *
 * Also signals the per-incident lifecycle workflow (workflow ID
 * `incident-{id}`). The signal is best-effort: if Temporal is
 * unreachable, the DB row still reflects the acknowledgement, and the
 * workflow will reconcile on its next tick. Manual acknowledge/resolve
 * writes an IncidentEvent AND signals the workflow — whichever lands
 * first wins, the other is a no-op.
 */
import { ORPCError } from "@orpc/client";
import { acknowledgeErrorRateIncident } from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";
import { signalIncidentAcknowledged } from "../lib/lifecycle-signal";

export const acknowledgeErrorRateIncidentProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/incidents/error-rate/{id}/acknowledge",
		tags: ["Incidents"],
		summary: "Acknowledge an error-rate incident",
	})
	.input(
		z.object({
			id: z.string().min(1),
			note: z.string().max(2000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const updated = await acknowledgeErrorRateIncident({
			incidentId: input.id,
			actorUserId: context.user.id,
			note: input.note,
		});
		if (!updated) {
			throw new ORPCError("NOT_FOUND", {
				message: `Error-rate incident not found: ${input.id}`,
			});
		}
		// Best-effort signal — the DB write above is the source of truth.
		await signalIncidentAcknowledged({
			incidentId: input.id,
			userId: context.user.id,
			note: input.note,
		});
		return { incident: updated };
	});
