import { ORPCError } from "@orpc/server";
import {
	findTimeTimerForOwner,
	findTimeTimerStop,
	stopTimeTimer,
	type TimeEntryValues,
	type TimeTimerRow,
} from "@repo/database";
import {
	TIME_WARNING_CODES,
	type TimeEntryWarning,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveEntryTiming, timeEntryFieldsObject } from "../lib/entry-input";
import {
	assertAcceptsNewTime,
	requireTimeTrackingProject,
	serializeTimeEntry,
	snapshotStory,
} from "../lib/save-entry";
import {
	assertCanTimeProject,
	requireTimerOrganization,
	TIMER_NOT_FOUND_MESSAGE,
	timerChangeInput,
	timerConflict,
} from "../lib/timer";
import {
	closeTimerSegments,
	evaluateTimerEntryWarnings,
	planTimerEntries,
} from "../lib/timer-stop";

export const stopTimerInputSchema = timerChangeInput.extend({
	/** When work stopped; omitted, now. Ignored for a paused timer. */
	stopAt: z.iso.datetime({ offset: true }).optional(),
	/** The time zone the entries are recorded in and dated by. */
	timezone: timeEntryFieldsObject.shape.timezone,
	/** Warning codes the caller has seen and chosen to save past. */
	acknowledgedWarnings: z
		.array(z.enum(TIME_WARNING_CODES))
		.max(TIME_WARNING_CODES.length)
		.default([]),
});

export const discardTimerInputSchema = timerChangeInput;

type TimerStopResult =
	| {
			status: "saved";
			entries: ReturnType<typeof serializeTimeEntry>[];
	  }
	| { status: "needs_confirmation"; warnings: TimeEntryWarning[] }
	| { status: "discarded" };

/**
 * The answer to a stop or discard of a timer that is not the caller's
 * current one at that version. When that timer was stopped at that version,
 * by this call's twin or an earlier one, its outcome: the entries it saved,
 * or `discarded`. A discard of a timer that was saved answers CONFLICT.
 * Otherwise CONFLICT with the caller's current timer, or NOT_FOUND when they
 * have none.
 */
async function answerFinishedTimer(params: {
	timerId: string;
	version: number;
	userId: string;
	current: TimeTimerRow | null;
	requested: "stop" | "discard";
}): Promise<TimerStopResult> {
	const stop = await findTimeTimerStop({
		timerId: params.timerId,
		userId: params.userId,
	});
	if (stop && stop.version === params.version) {
		switch (stop.outcome) {
			case "SAVED":
				if (params.requested === "discard") {
					throw new ORPCError("CONFLICT", {
						message: "This timer was already stopped and saved",
					});
				}
				return {
					status: "saved",
					entries: stop.entries.map(serializeTimeEntry),
				};
			case "DISCARDED":
				return { status: "discarded" };
			default: {
				const unreachable: never = stop.outcome;
				throw new Error(
					`Unhandled timer stop outcome: ${String(unreachable)}`,
				);
			}
		}
	}
	if (params.current) {
		throw await timerConflict(params.current);
	}
	throw new ORPCError("NOT_FOUND", { message: TIMER_NOT_FOUND_MESSAGE });
}

/**
 * Delete the timer at the version it was loaded at and save `entries`
 * (none: discard it). When it is no longer at that version, `answerStale`
 * answers with the caller's timer as it is now.
 */
async function finishTimer(params: {
	timer: TimeTimerRow;
	organizationId: string;
	userId: string;
	entries: TimeEntryValues[];
	now: Date;
	answerStale: (current: TimeTimerRow | null) => Promise<TimerStopResult>;
}): Promise<TimerStopResult> {
	const { organizationId, userId } = params;
	const saved = await stopTimeTimer({
		timerId: params.timer.id,
		organizationId,
		userId,
		version: params.timer.version,
		entries: params.entries,
		now: params.now,
	});
	if (!saved) {
		return params.answerStale(
			await findTimeTimerForOwner({ organizationId, userId }),
		);
	}
	return saved.length > 0
		? { status: "saved", entries: saved.map(serializeTimeEntry) }
		: { status: "discarded" };
}

/**
 * Stop the caller's timer and save it as time entries, exactly once.
 *
 * The entries go through the same rules as `createEntry`: an ACTIVE project
 * the caller can still log time on, its current start/stop rule (one entry
 * per segment on a start/stop project, one entry with the summed duration
 * otherwise), the timer's billable flag or else the project's default, a
 * work item of the project, and the duplicate and daily-total warnings,
 * answered with `needs_confirmation` until acknowledged, the timer left as
 * it is. Segments under a minute are dropped; when nothing is left the timer
 * is discarded.
 *
 * A repeated or concurrent stop of the same version answers with the
 * entries the first one saved. A stale version answers CONFLICT with the
 * current timer.
 */
export const stopTimerProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/timer/stop",
		tags: ["Time tracking"],
		summary: "Stop the caller's timer and save its time",
		description:
			"Stops the caller's timer at stopAt (default now) and saves it as time entries. Returns needs_confirmation with the warnings instead of saving when they are not in acknowledgedWarnings, and discarded when the timer ran under a minute. Stopping again returns the same entries.",
	})
	.input(stopTimerInputSchema)
	.handler(async ({ input, context }): Promise<TimerStopResult> => {
		const organizationId = requireTimerOrganization(
			resolveOrganizationId(input.organizationId, context.session),
		);
		const userId = context.user.id;
		const finished = (current: TimeTimerRow | null) =>
			answerFinishedTimer({
				timerId: input.timerId,
				version: input.version,
				userId,
				current,
				requested: "stop",
			});

		const timer = await findTimeTimerForOwner({ organizationId, userId });
		if (!timer || timer.id !== input.timerId) {
			return finished(timer);
		}
		if (timer.version !== input.version) {
			throw await timerConflict(timer);
		}
		await assertCanTimeProject(timer.projectId, userId);
		const project = await requireTimeTrackingProject(timer.projectId);
		assertAcceptsNewTime(project);
		const startStopRequired = project.policy.startStopRequired;

		const now = new Date();
		const planned = planTimerEntries({
			segments: closeTimerSegments({
				segments: timer.segments,
				stopAt:
					input.stopAt === undefined
						? undefined
						: new Date(input.stopAt),
				now,
			}),
			timezone: input.timezone,
			startStopRequired,
		});
		const finish = (entries: TimeEntryValues[]) =>
			finishTimer({
				timer,
				organizationId,
				userId,
				entries,
				now,
				answerStale: finished,
			});
		if (planned.length === 0) {
			return finish([]);
		}

		const timings = planned.map((entry) => ({
			workDate: entry.workDate,
			...resolveEntryTiming(entry.timing, startStopRequired),
		}));
		const story = await snapshotStory({
			projectId: project.id,
			storyId: timer.storyId,
		});
		const { blocked, warnings } = await evaluateTimerEntryWarnings({
			organizationId,
			userId,
			proposed: timings.map((timing) => ({
				projectId: project.id,
				activity: timer.activity,
				storyId: story.storyId,
				description: timer.description,
				...timing,
			})),
			acknowledged: input.acknowledgedWarnings,
		});
		if (blocked) {
			return { status: "needs_confirmation", warnings };
		}

		return finish(
			timings.map((timing) => ({
				projectId: project.id,
				timezone: input.timezone,
				activity: timer.activity,
				billable: timer.billable ?? project.policy.defaultBillable,
				description: timer.description,
				startStopRequired,
				userNameSnapshot: context.user.name,
				...timing,
				...story,
			})),
		);
	});

/**
 * Throw the caller's timer away without saving anything.
 *
 * Unlike the other changes, the timer's project is not checked: discarding
 * writes nothing to it, and a member who lost access to the project must
 * still be able to clear their timer to start another. A repeated discard
 * of the same version answers `discarded` again.
 */
export const discardTimerProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.PROJECT_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/time-tracking/timer/discard",
		tags: ["Time tracking"],
		summary: "Discard the caller's timer",
		description:
			"Deletes the caller's timer without saving time. A stale version answers CONFLICT with the current timer.",
	})
	.input(discardTimerInputSchema)
	.handler(async ({ input, context }): Promise<TimerStopResult> => {
		const organizationId = requireTimerOrganization(
			resolveOrganizationId(input.organizationId, context.session),
		);
		const userId = context.user.id;
		const finished = (current: TimeTimerRow | null) =>
			answerFinishedTimer({
				timerId: input.timerId,
				version: input.version,
				userId,
				current,
				requested: "discard",
			});

		const timer = await findTimeTimerForOwner({ organizationId, userId });
		if (!timer || timer.id !== input.timerId) {
			return finished(timer);
		}
		if (timer.version !== input.version) {
			throw await timerConflict(timer);
		}
		return finishTimer({
			timer,
			organizationId,
			userId,
			entries: [],
			now: new Date(),
			answerStale: finished,
		});
	});
