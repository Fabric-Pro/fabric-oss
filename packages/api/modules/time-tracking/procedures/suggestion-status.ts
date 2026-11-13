import { ORPCError } from "@orpc/server";
import {
	getLatestTimeSuggestionRun,
	TIME_SUGGESTION_RUN_TIMEOUT_MS,
} from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const timeSuggestionStatusInputSchema = z.object({
	organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * The caller's newest suggestion run in the organization, polled while one
 * runs. Null before their first run.
 *
 * A run still GENERATING past its timeout is reported FAILED: no workflow
 * can complete it any more, and the next start reclaims it, so a poll must
 * not wait on it.
 */
export const timeSuggestionStatusProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/suggestions/status",
		tags: ["Time tracking"],
		summary: "Get the caller's latest time-suggestion run",
		description:
			"The status (GENERATING, DONE or FAILED), the number of suggestions created and the start and finish times of the caller's newest run, or null before their first.",
	})
	.input(timeSuggestionStatusInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "organizationId is required",
			});
		}

		const run = await getLatestTimeSuggestionRun({
			organizationId,
			userId: context.user.id,
		});
		if (!run) {
			return null;
		}
		const timedOut =
			run.status === "GENERATING" &&
			run.startedAt.getTime() + TIME_SUGGESTION_RUN_TIMEOUT_MS <
				Date.now();
		return {
			runId: run.id,
			status: timedOut ? ("FAILED" as const) : run.status,
			createdCount: run.createdCount,
			startedAt: run.startedAt.toISOString(),
			finishedAt: run.finishedAt?.toISOString() ?? null,
		};
	});
