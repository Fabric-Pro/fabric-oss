/**
 * What the timer procedures share: loading the caller's own timer, checking
 * they may still time its project, and the wire shape of a timer.
 *
 * A timer is personal. The caller has at most one per organization, read by
 * organization and caller, so someone else's timer is never loaded: a
 * `timerId` that is not the caller's current timer answers NOT_FOUND when
 * they have none, and CONFLICT with their own timer when they have one.
 */

import { ORPCError } from "@orpc/server";
import {
	ACTIVITY_ACTION_PREFIX,
	findTimeTimerForOwner,
	loadTimeTrackingProject,
	type TimeTimerRow,
	type TimeTimerSegmentRow,
} from "@repo/database";
import {
	type EffectiveTimePolicy,
	resolveEffectiveTimePolicy,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import { assertProjectPermission, Permissions } from "../../../orpc/procedures";
import { assertProjectVisible } from "./project-access";

/**
 * The audit action every timer procedure is recorded under by the automatic
 * activity capture (`activity.<procedure path>`), so a proposed stop time can
 * leave the timer's own calls out of the member's activity. Follows the
 * router: `timeTracking` in the root router, `timer` in this module's.
 */
export const TIMER_ACTION_PREFIX = `${ACTIVITY_ACTION_PREFIX}timeTracking.timer.`;

export const TIMER_NOT_FOUND_MESSAGE = "You have no running timer";

/** The input every timer procedure takes: whose organization's timer. */
export const timerOrganizationInput = z.object({
	organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
});

/**
 * The organization `resolveOrganizationId` resolved, which a timer always
 * needs.
 */
export function requireTimerOrganization(
	organizationId: string | undefined,
): string {
	if (!organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId is required",
		});
	}
	return organizationId;
}

/**
 * The input of every change to a timer: which timer, at the version the
 * caller last saw.
 */
export const timerChangeInput = timerOrganizationInput.extend({
	timerId: z.string().min(1).max(INPUT_BOUNDS.name),
	version: z.number().int().positive(),
});

const TIMER_CHANGED_MESSAGE = "Your timer changed since this view was loaded";

/** Whole seconds the timer has run, its open segment up to `now`. */
function timerElapsedSeconds(
	segments: readonly TimeTimerSegmentRow[],
	now: Date,
): number {
	const elapsedMs = segments.reduce(
		(sum, segment) =>
			sum +
			Math.max(
				0,
				(segment.stopAt ?? now).getTime() - segment.startAt.getTime(),
			),
		0,
	);
	return Math.floor(elapsedMs / 1000);
}

const NO_POLICY = { timeRequireStartStop: false, timeDefaultBillable: null };

/**
 * The policy an entry on the timer's project would be saved under now. Read
 * whatever the project's state, so a timer on a project archived since still
 * shows.
 */
async function currentTimerPolicy(
	projectId: string,
): Promise<EffectiveTimePolicy> {
	const project = await loadTimeTrackingProject(projectId);
	return resolveEffectiveTimePolicy({
		org: project?.organization ?? NO_POLICY,
		project: project ?? NO_POLICY,
	});
}

/** A timer as every timer procedure returns it. */
export async function describeTimer(timer: TimeTimerRow, now: Date) {
	const policy = await currentTimerPolicy(timer.projectId);
	return {
		id: timer.id,
		projectId: timer.projectId,
		projectName: timer.projectName,
		activity: timer.activity,
		storyId: timer.storyId,
		storyIdentifier: timer.storyIdentifier,
		storyTitle: timer.storyTitle,
		description: timer.description,
		billable: timer.billable,
		timezone: timer.timezone,
		status: timer.status,
		version: timer.version,
		segments: timer.segments.map((segment) => ({
			startAt: segment.startAt.toISOString(),
			stopAt: segment.stopAt?.toISOString() ?? null,
		})),
		elapsedSeconds: timerElapsedSeconds(timer.segments, now),
		startStopRequired: policy.startStopRequired,
		defaultBillable: policy.defaultBillable,
		createdAt: timer.createdAt.toISOString(),
		updatedAt: timer.updatedAt.toISOString(),
	};
}

/**
 * CONFLICT carrying the caller's current timer in `data.timer`, for a change
 * made from a stale view.
 */
export async function timerConflict(
	timer: TimeTimerRow,
	message = TIMER_CHANGED_MESSAGE,
) {
	return new ORPCError("CONFLICT", {
		message,
		data: { timer: await describeTimer(timer, new Date()) },
	});
}

/**
 * The caller's timer, when it is the one `timerId` names: NOT_FOUND when they
 * have none, CONFLICT with theirs when it is another one.
 */
export async function requireOwnTimer(params: {
	organizationId: string;
	userId: string;
	timerId: string;
}): Promise<TimeTimerRow> {
	const timer = await findTimeTimerForOwner({
		organizationId: params.organizationId,
		userId: params.userId,
	});
	if (!timer) {
		throw new ORPCError("NOT_FOUND", { message: TIMER_NOT_FOUND_MESSAGE });
	}
	if (timer.id !== params.timerId) {
		throw await timerConflict(timer);
	}
	return timer;
}

/**
 * The caller may still put time on the project: they can discover it and
 * hold TIME_LOG there, checked as `confirmSuggestion` checks a suggestion's
 * project.
 */
export async function assertCanTimeProject(
	projectId: string,
	userId: string,
): Promise<void> {
	await assertProjectVisible(projectId, userId);
	await assertProjectPermission(projectId, userId, Permissions.TIME_LOG);
}
