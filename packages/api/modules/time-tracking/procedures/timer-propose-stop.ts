import { ORPCError } from "@orpc/server";
import { findOwnActivity, findTimeTimerForOwner } from "@repo/database";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	assertCanTimeProject,
	requireTimerOrganization,
	TIMER_ACTION_PREFIX,
	TIMER_NOT_FOUND_MESSAGE,
	timerOrganizationInput,
} from "../lib/timer";
import { proposeTimerStop, RETURN_WINDOW_MINUTES } from "../lib/timer-stop";

export const proposeTimerStopInputSchema = timerOrganizationInput;

/**
 * When the caller's timer most likely stopped being work, for the Stop
 * question.
 *
 * Read from the caller's successful actions of their own in the
 * organization's audit log since the timer first started, leaving out the
 * timer's own calls. Actions in the last 15 minutes are coming back to stop
 * the timer (opening a page records one), so the quiet stretch is measured
 * from the newest action before them until the first of them. Over 30
 * minutes of quiet after an action, or over 4 hours of a running segment with
 * no action before them, `needsQuestion` is true and the proposal is that
 * action's time (or now); otherwise the proposal is now. A paused timer
 * proposes its pause. The proposal always
 * lies within the open segment, from its start to now, so it can be passed
 * to `stop` as `stopAt` unchanged.
 */
export const proposeTimerStopProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/timer/proposed-stop",
		tags: ["Time tracking"],
		summary: "Propose when the caller's timer stopped",
		description:
			"Proposes a stop time for the caller's timer from their own most recent activity, and whether to ask them when they stopped working.",
	})
	.input(proposeTimerStopInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireTimerOrganization(
			resolveOrganizationId(input.organizationId, context.session),
		);
		const userId = context.user.id;
		const timer = await findTimeTimerForOwner({ organizationId, userId });
		const firstStart = timer?.segments[0]?.startAt;
		if (!timer || !firstStart) {
			throw new ORPCError("NOT_FOUND", {
				message: TIMER_NOT_FOUND_MESSAGE,
			});
		}
		await assertCanTimeProject(timer.projectId, userId);

		const now = new Date();
		const returnSince = new Date(
			Math.max(
				firstStart.getTime(),
				now.getTime() - RETURN_WINDOW_MINUTES * 60_000,
			),
		);
		const scope = {
			organizationId,
			userId,
			excludeActionPrefix: TIMER_ACTION_PREFIX,
		};
		const [activity, returned] =
			timer.status === "RUNNING"
				? await Promise.all([
						findOwnActivity({
							...scope,
							after: firstStart,
							before: returnSince,
							pick: "newest",
						}),
						findOwnActivity({
							...scope,
							after: returnSince,
							before: now,
							pick: "oldest",
						}),
					])
				: [null, null];
		const proposal = proposeTimerStop({
			segments: timer.segments,
			activity,
			returnedAt: returned?.createdAt ?? null,
			now,
		});
		return {
			timerId: timer.id,
			version: timer.version,
			proposedStopAt: proposal.proposedStopAt.toISOString(),
			source: proposal.source
				? {
						action: proposal.source.action,
						at: proposal.source.at.toISOString(),
					}
				: null,
			gapMinutes: proposal.gapMinutes,
			needsQuestion: proposal.needsQuestion,
		};
	});
