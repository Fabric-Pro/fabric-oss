/**
 * Discard Spike Procedure (plan Slice 3)
 *
 * AUTHORIZATION: project-level AGENT_EXECUTE via requireProjectPermission;
 * the run is loaded within the project and its tenant (XOR).
 *
 * DEMO_READY -> CANCELLED. The demo frame is kept for reference; an
 * optional reason is recorded as play notes. Nothing is written to the
 * story, so the readiness gap stays open.
 */

import { addCodingRunEvent, discardSpikeRun } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { mapSpikeRunError, resolveProjectTenant } from "./accept-spike";

export const discardSpikeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/coding-runs/{codingRunId}/discard-spike",
		tags: ["CodingRuns"],
		summary: "Discard a DEMO_READY spike (frame is kept)",
	})
	.input(
		z.object({
			codingRunId: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			reason: z.string().max(4000).optional(),
		}),
	)
	.output(
		z.object({
			codingRunId: z.string(),
			status: z.literal("CANCELLED"),
			storyId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = await resolveProjectTenant(input.projectId);

		let result: Awaited<ReturnType<typeof discardSpikeRun>>;
		try {
			result = await discardSpikeRun({
				codingRunId: input.codingRunId,
				projectId: input.projectId,
				organizationId,
				reason: input.reason?.trim() || undefined,
			});
		} catch (error) {
			throw mapSpikeRunError(error);
		}

		await addCodingRunEvent(input.codingRunId, "spike_discarded", {
			discardedBy: user.id,
			reason: input.reason ?? null,
		}).catch((error) => {
			logger.warn(
				{ err: error, codingRunId: input.codingRunId },
				"[CodingRun] Failed to record spike_discarded event",
			);
		});

		return result;
	});
